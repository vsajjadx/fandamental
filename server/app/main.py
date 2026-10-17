"""HTTP API for the MT5 bridge (Starlette + Pydantic; run with uvicorn).

Two kinds of callers, two kinds of keys:
  web app  → Authorization: Bearer fa_u_…   (manage accounts, submit signals, approve executions)
  MT5 EA   → X-Terminal-Key: fa_t_…         (heartbeat, fetch work, report results; scoped to ONE account)
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Callable

from pydantic import BaseModel, ValidationError
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from . import security
from .config import Config
from .db import open_db
from .models import AccountCreate, AccountSettings, CloseReport, Decision, ExecReport, Heartbeat, LiveToggle, SignalIn
from .services import ApiError, Service

API_VERSION = "1.0.0"
log = logging.getLogger("fandamental.api")


def _setup_logging(level: str) -> None:
    root = logging.getLogger()
    if not any(isinstance(f, security.RedactingFilter) for h in root.handlers for f in h.filters):
        h = logging.StreamHandler()
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        h.addFilter(security.RedactingFilter())
        root.addHandler(h)
    root.setLevel(level)
    for name in ("uvicorn.access", "uvicorn.error"):
        for hh in logging.getLogger(name).handlers:
            hh.addFilter(security.RedactingFilter())


def err(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, **extra}}, status_code=status)


class GuardMiddleware:
    """HTTPS enforcement, body-size cap, rate limiting and one access-log line per request (no secrets)."""

    def __init__(self, app: ASGIApp, cfg: Config):
        self.app, self.cfg = app, cfg
        self.limiter = security.RateLimiter(cfg.rate_limit_per_min)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        t0 = time.monotonic()
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        path, method = scope.get("path", ""), scope.get("method", "")
        status_box = {"s": 0}

        async def send_wrap(msg):
            if msg["type"] == "http.response.start":
                status_box["s"] = msg["status"]
            await send(msg)

        def done():
            log.info("%s %s -> %s %.0fms", method, path, status_box["s"], (time.monotonic() - t0) * 1000)

        if self.cfg.require_https and method != "OPTIONS":
            scheme = scope.get("scheme", "http")
            if self.cfg.trust_proxy and headers.get("x-forwarded-proto"):
                scheme = headers["x-forwarded-proto"].split(",")[0].strip()
            host = (headers.get("host") or "").split(":")[0]
            if scheme != "https" and host not in ("localhost", "127.0.0.1", "::1"):
                await err(403, "https_required", "use https://")(scope, receive, send_wrap)
                return done()

        if int(headers.get("content-length") or 0) > self.cfg.max_body_bytes:
            await err(413, "too_large", "request body too large")(scope, receive, send_wrap)
            return done()

        cred = headers.get("x-terminal-key") or headers.get("authorization", "")
        if cred and method != "OPTIONS":
            bucket = security.hash_key(cred)[:16]
            if not self.limiter.allow(bucket):
                await err(429, "rate_limited", "too many requests; slow down")(scope, receive, send_wrap)
                return done()

        await self.app(scope, receive, send_wrap)
        done()


def create_app(cfg: Config | None = None) -> Starlette:
    cfg = cfg or Config.from_env()
    _setup_logging(cfg.log_level)
    conn = open_db(cfg.db_path)
    svc = Service(conn, cfg)

    async def body(request: Request, model: type[BaseModel]) -> BaseModel:
        raw = await request.body()
        if len(raw) > cfg.max_body_bytes:
            raise ApiError(413, "too_large", "request body too large")
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            raise ApiError(400, "bad_json", "body is not valid JSON")
        try:
            return model.model_validate(data)
        except ValidationError as ex:
            details = [{"field": ".".join(str(p) for p in e["loc"]), "message": e["msg"]} for e in ex.errors(include_url=False, include_input=False)]
            raise ApiError(422, "validation_error", details[0]["message"] if details else "invalid input", {"details": details})

    def user_of(request: Request) -> dict:
        h = request.headers.get("authorization", "")
        key = h[7:].strip() if h.lower().startswith("bearer ") else ""
        u = svc.auth_user(key) if key else None
        if not u:
            raise ApiError(401, "unauthorized", "missing or invalid API key")
        return u

    def terminal_of(request: Request) -> dict:
        key = request.headers.get("x-terminal-key", "").strip()
        a = svc.auth_terminal(key) if key else None
        if not a:
            raise ApiError(401, "unauthorized", "missing or invalid terminal key")
        return a

    def endpoint(fn: Callable) -> Callable:
        async def wrapped(request: Request):
            try:
                res = await fn(request)
                if isinstance(res, JSONResponse):
                    return res
                return JSONResponse(res)
            except ApiError as ex:
                if ex.status >= 500:
                    log.error("api error %s", ex.code)
                return err(ex.status, ex.code, ex.message, **ex.extra)
            except Exception:
                log.exception("unhandled error on %s %s", request.method, request.url.path)
                return err(500, "internal", "internal server error")
        return wrapped

    def qint(request: Request, name: str, default: int) -> int:
        try:
            return int(request.query_params.get(name, default))
        except ValueError:
            raise ApiError(400, "bad_query", f"{name} must be an integer")

    # ---------------------------------------------------------------- public
    async def health(request):
        return {"ok": True, "version": API_VERSION, "server_time": int(time.time())}

    # ---------------------------------------------------------------- web app
    async def me(request):
        u = user_of(request)
        return {"user": {"id": u["id"], "name": u["name"]}, "server_time": int(time.time()), "version": API_VERSION}

    async def signals_create(request):
        u = user_of(request)
        data = await body(request, SignalIn)
        sig, created = svc.create_signal(u, data)
        return JSONResponse({"signal": sig, "created": created}, status_code=201 if created else 200)

    async def signals_list(request):
        return {"signals": svc.list_signals(user_of(request), qint(request, "limit", 50))}

    async def signal_get(request):
        return {"signal": svc.get_signal(user_of(request), request.path_params["sid"])}

    async def signal_cancel(request):
        return {"signal": svc.cancel_signal(user_of(request), request.path_params["sid"])}

    async def accounts_list(request):
        return {"accounts": svc.list_accounts(user_of(request))}

    async def accounts_create(request):
        u = user_of(request)
        data = await body(request, AccountCreate)
        acc, key = svc.create_account(u, data)
        return JSONResponse({"account": acc, "terminal_key": key,
                             "notice": "Copy the terminal key into the EA inputs now; it is shown only once."}, status_code=201)

    async def account_get(request):
        return {"account": svc.get_account(user_of(request), request.path_params["aid"])}

    async def account_patch(request):
        u = user_of(request)
        data = await body(request, AccountSettings)
        return {"account": svc.update_account(u, request.path_params["aid"], data)}

    async def account_rotate(request):
        key = svc.rotate_terminal_key(user_of(request), request.path_params["aid"])
        return {"terminal_key": key, "notice": "Old key stops working immediately. Update the EA inputs."}

    async def account_live(request):
        u = user_of(request)
        data = await body(request, LiveToggle)
        return {"account": svc.set_live(u, request.path_params["aid"], data.enable, data.confirm)}

    async def account_reset(request):
        return {"account": svc.reset_binding(user_of(request), request.path_params["aid"])}

    async def executions_list(request):
        u = user_of(request)
        return {"executions": svc.list_executions(u, request.query_params.get("account_id"), request.query_params.get("state"),
                                                  qint(request, "limit", 100))}

    async def execution_approve(request):
        return {"execution": svc.approve(user_of(request), request.path_params["eid"])}

    async def execution_reject(request):
        u = user_of(request)
        data = await body(request, Decision)
        return {"execution": svc.reject(u, request.path_params["eid"], data.reason)}

    async def audit(request):
        return {"events": svc.audit_list(user_of(request), qint(request, "limit", 100))}

    # ---------------------------------------------------------------- EA
    async def ea_heartbeat(request):
        a = terminal_of(request)
        hb = await body(request, Heartbeat)
        return svc.heartbeat(a, hb)

    async def ea_pending(request):
        return svc.poll(terminal_of(request))

    async def ea_report(request):
        a = terminal_of(request)
        rep = await body(request, ExecReport)
        return svc.report(a, request.path_params["eid"], rep)

    async def ea_closed(request):
        a = terminal_of(request)
        rep = await body(request, CloseReport)
        return svc.report_close(a, request.path_params["eid"], rep)

    E = endpoint
    routes = [
        Route("/api/v1/health", E(health)),
        Route("/api/v1/me", E(me)),
        Route("/api/v1/signals", E(signals_create), methods=["POST"]),
        Route("/api/v1/signals", E(signals_list), methods=["GET"]),
        Route("/api/v1/signals/{sid}", E(signal_get), methods=["GET"]),
        Route("/api/v1/signals/{sid}/cancel", E(signal_cancel), methods=["POST"]),
        Route("/api/v1/accounts", E(accounts_list), methods=["GET"]),
        Route("/api/v1/accounts", E(accounts_create), methods=["POST"]),
        Route("/api/v1/accounts/{aid}", E(account_get), methods=["GET"]),
        Route("/api/v1/accounts/{aid}", E(account_patch), methods=["PATCH"]),
        Route("/api/v1/accounts/{aid}/rotate-key", E(account_rotate), methods=["POST"]),
        Route("/api/v1/accounts/{aid}/live", E(account_live), methods=["POST"]),
        Route("/api/v1/accounts/{aid}/reset-binding", E(account_reset), methods=["POST"]),
        Route("/api/v1/executions", E(executions_list), methods=["GET"]),
        Route("/api/v1/executions/{eid}/approve", E(execution_approve), methods=["POST"]),
        Route("/api/v1/executions/{eid}/reject", E(execution_reject), methods=["POST"]),
        Route("/api/v1/audit", E(audit), methods=["GET"]),
        Route("/api/v1/ea/heartbeat", E(ea_heartbeat), methods=["POST"]),
        Route("/api/v1/ea/pending", E(ea_pending), methods=["GET"]),
        Route("/api/v1/ea/executions/{eid}/report", E(ea_report), methods=["POST"]),
        Route("/api/v1/ea/executions/{eid}/closed", E(ea_closed), methods=["POST"]),
    ]
    middleware = [
        Middleware(CORSMiddleware, allow_origins=cfg.allowed_origins, allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
                   allow_headers=["Authorization", "Content-Type"], max_age=600),
        Middleware(GuardMiddleware, cfg=cfg),
    ]
    app = Starlette(routes=routes, middleware=middleware)
    app.state.service = svc
    app.state.config = cfg
    return app


def app_factory() -> Starlette:  # uvicorn app.main:app_factory --factory
    return create_app()
