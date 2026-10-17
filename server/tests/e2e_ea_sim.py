"""End-to-end test over real HTTP: uvicorn server + a simulated MT5 EA.

The simulated EA follows the SAME protocol as mt5/FandamentalBridge.mq5:
  heartbeat → poll → per item: duplicate check by tag → report "sending" (must get go) → OrderSend → report result
  + a persistent queue for reports whose response was lost, + reconciliation of "unknown" executions.
A fake broker keeps positions with their comment tags so we can count real orders.

Run from server/:  python3 tests/e2e_ea_sim.py
"""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

RESULTS: list[tuple[str, bool, str]] = []


def check(name, cond, extra=""):
    RESULTS.append((name, bool(cond), extra))
    print(("PASS " if cond else "FAIL ") + name + (("  " + extra) if extra else ""))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Server:
    def __init__(self, db):
        self.db, self.port, self.proc = db, free_port(), None

    def start(self):
        env = dict(os.environ, FA_DB_PATH=self.db, FA_REQUIRE_HTTPS="1", FA_LOG_LEVEL="WARNING", FA_SENDING_TIMEOUT_SEC="2")
        self.proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app_factory", "--factory", "--host", "127.0.0.1",
                                      "--port", str(self.port), "--log-level", "warning"], cwd=ROOT, env=env)
        for _ in range(100):
            try:
                urllib.request.urlopen(self.url + "/api/v1/health", timeout=0.5)
                return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("server did not start")

    def stop(self):
        if self.proc:
            self.proc.send_signal(signal.SIGTERM)
            self.proc.wait(timeout=10)
            self.proc = None

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"


class LostResponse(Exception):
    pass


def http(method, url, headers=None, body=None, drop_response=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            code, payload = r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        code, payload = e.code, json.loads(e.read() or b"{}")
    if drop_response:  # the server DID process it; the EA just never sees the answer (timeout / cut connection)
        raise LostResponse()
    return code, payload


class FakeBroker:
    def __init__(self):
        self.positions: list[dict] = []
        self.ticket = 1000

    def order_send(self, symbol, side, volume, sl, tp, comment):
        self.ticket += 1
        self.positions.append({"ticket": self.ticket, "symbol": symbol, "side": side, "volume": volume, "comment": comment})
        return {"retcode": 10009, "ticket": str(self.ticket), "price": 2400.3}

    def find(self, tag):
        return next((p for p in self.positions if p["comment"] == tag), None)


class SimEA:
    def __init__(self, base, key, broker, login="5001234", trade_mode="demo", allow_real=False, state_file=None):
        self.base, self.key, self.broker = base, key, broker
        self.login, self.trade_mode, self.allow_real = login, trade_mode, allow_real
        self.state_file = state_file
        self.queue: list[dict] = []        # persisted report queue (like the EA's FILE_COMMON json)
        self.drop_next: set[str] = set()   # names of calls whose response should be "lost"
        self.load()

    def load(self):
        if self.state_file and os.path.exists(self.state_file):
            self.queue = json.load(open(self.state_file))

    def save(self):
        if self.state_file:
            json.dump(self.queue, open(self.state_file, "w"))

    def call(self, name, method, path, body=None):
        drop = name in self.drop_next
        self.drop_next.discard(name)
        return http(method, self.base + path, {"X-Terminal-Key": self.key}, body, drop_response=drop)

    def heartbeat(self):
        return self.call("heartbeat", "POST", "/api/v1/ea/heartbeat", {
            "login": self.login, "server": "Demo-Server", "company": "Sim", "trade_mode": self.trade_mode, "currency": "USD",
            "balance": 10000, "equity": 10000, "trade_allowed": True, "ea_allow_real": self.allow_real, "ea_version": "sim"})

    def flush_queue(self):
        left = []
        for q in self.queue:
            try:
                code, _ = self.call("report", "POST", f"/api/v1/ea/executions/{q['eid']}/report", q["body"])
                if code >= 500:
                    left.append(q)
            except (LostResponse, OSError):
                left.append(q)
        self.queue = left
        self.save()

    def report(self, eid, body):
        self.queue.append({"eid": eid, "body": body})
        self.save()
        self.flush_queue()

    def tick(self, sending_hook=None):
        self.flush_queue()
        code, p = self.call("poll", "GET", "/api/v1/ea/pending")
        if code != 200:
            return code, p
        for r in p["reconcile"]:
            pos = self.broker.find(r["tag"])
            body = {"report_id": "rec-" + uuid.uuid4().hex[:12], "state": "filled" if pos else "not_found"}
            if pos:
                body["ticket"] = str(pos["ticket"])
            self.report(r["execution_id"], body)
        for it in p["items"]:
            eid, s = it["execution_id"], it["signal"]
            if it["action"] == "notify":
                self.report(eid, {"report_id": "d-" + uuid.uuid4().hex[:12], "state": "displayed"})
                continue
            if self.broker.find(it["tag"]):  # already executed (e.g. lost report) → never send twice
                self.report(eid, {"report_id": "f-" + uuid.uuid4().hex[:12], "state": "filled"})
                continue
            try:
                code, resp = self.call("sending", "POST", f"/api/v1/ea/executions/{eid}/report",
                                       {"report_id": "s-" + uuid.uuid4().hex[:12], "state": "sending", "broker_symbol": s["symbol"], "volume": 0.01})
            except (LostResponse, OSError):
                continue  # no go received → do NOT send; next poll will not redeliver (server may be in 'sending') → reconcile
            if code != 200 or not resp.get("go"):
                continue
            if sending_hook:
                sending_hook(eid)
            res = self.broker.order_send(s["symbol"], s["direction"], 0.01, s["sl"], s["tp"], it["tag"])
            self.report(eid, {"report_id": "r-" + uuid.uuid4().hex[:12], "state": "filled", "ticket": res["ticket"],
                              "fill_price": res["price"], "retcode": res["retcode"], "volume": 0.01})
        return 200, p


def main():
    tmp = tempfile.mkdtemp()
    db = os.path.join(tmp, "e2e.db")
    os.environ["FA_DB_PATH"] = db
    from app.config import Config
    from app.db import connect, migrate
    from app.services import Service
    conn = connect(db)
    migrate(conn)
    _, ukey = Service(conn, Config(db_path=db)).create_user("e2e")
    conn.close()

    srv = Server(db)
    srv.start()
    U = {"Authorization": "Bearer " + ukey}
    try:
        code, r = http("POST", srv.url + "/api/v1/accounts", U, {"name": "demo", "mode": "auto"})
        check("web: create MT5 connection (auto mode)", code == 201)
        acc, tkey = r["account"], r["terminal_key"]
        broker = FakeBroker()
        ea = SimEA(srv.url, tkey, broker, state_file=os.path.join(tmp, "q.json"))
        check("EA: heartbeat binds account", ea.heartbeat()[0] == 200)

        def submit(cid, **kw):
            body = {"client_signal_id": cid, "symbol": "XAUUSD", "direction": "buy", "entry": 2400, "sl": 2390, "tp": 2420,
                    "timeframe": "1h", "generated_at": int(time.time()) - 2, **kw}
            return http("POST", srv.url + "/api/v1/signals", U, body)

        # 1) normal flow
        check("web: submit signal", submit("e1")[0] == 201)
        ea.tick()
        check("EA: order placed exactly once", len(broker.positions) == 1)
        ex = http("GET", srv.url + "/api/v1/executions", U)[1]["executions"][0]
        check("server: execution recorded as filled with ticket", ex["state"] == "filled" and ex["ticket"] == "1001", f"{ex['state']} {ex['ticket']}")

        # 2) resubmitting the same signal does nothing
        code, r = submit("e1")
        ea.tick()
        check("idempotent resubmit: no new order", code == 200 and len(broker.positions) == 1)

        # 3) response of the final report is lost → EA queues and retries → no duplicate
        submit("e2")
        ea.drop_next.add("report")
        ea.tick()
        check("lost final-report response: order sent once", len(broker.positions) == 2)
        ea.tick()
        ea.tick()
        check("lost final-report response: still once after retries", len(broker.positions) == 2)
        e2 = [e for e in http("GET", srv.url + "/api/v1/executions", U)[1]["executions"] if e["signal"]["client_signal_id"] == "e2"][0]
        check("lost final-report response: server ends 'filled'", e2["state"] == "filled", e2["state"])

        # 4) the 'sending' response is lost → EA must NOT send; server reconciles → failed, never re-sent
        submit("e3")
        ea.drop_next.add("sending")
        ea.tick()
        check("lost 'go' response: EA did not send", len(broker.positions) == 2)
        time.sleep(2.5)  # > FA_SENDING_TIMEOUT_SEC
        ea.tick()
        ea.tick()
        e3 = [e for e in http("GET", srv.url + "/api/v1/executions", U)[1]["executions"] if e["signal"]["client_signal_id"] == "e3"][0]
        check("lost 'go' response: reconciled to failed, not re-sent", e3["state"] == "failed" and len(broker.positions) == 2, e3["state"])

        # 5) EA crashes right after OrderSend (before reporting) and restarts with empty memory
        submit("e4")
        crashed = {"eid": None}

        def crash_after_send(eid):
            crashed["eid"] = eid
            ea.drop_next.add("report")  # emulate: the report never reaches the server
        # send happens, report dropped; then simulate a restart that LOSES the local queue file
        ea.tick(sending_hook=crash_after_send)
        os.remove(os.path.join(tmp, "q.json"))
        ea2 = SimEA(srv.url, tkey, broker, state_file=os.path.join(tmp, "q.json"))
        time.sleep(2.5)
        ea2.tick()
        e4 = [e for e in http("GET", srv.url + "/api/v1/executions", U)[1]["executions"] if e["signal"]["client_signal_id"] == "e4"][0]
        check("EA restart after send: reconciled via order tag → filled, no duplicate",
              e4["state"] == "filled" and len(broker.positions) == 3, f"{e4['state']} orders={len(broker.positions)}")

        # 6) server restart: state survives in SQLite
        submit("e5")
        srv.stop()
        try:
            ea.tick()
            check("server down: EA call fails cleanly", False)
        except OSError:
            check("server down: EA call fails cleanly (EA keeps running, no order)", len(broker.positions) == 3)
        srv.start()
        ea.base = ea2.base = srv.url
        ea2.tick()
        check("server back: pending signal executed once", len(broker.positions) == 4)

        # 7) expired signal is never executed
        submit("e6", valid_for_sec=60, generated_at=int(time.time()) - 59)
        time.sleep(1.5)
        ea2.tick()
        check("expired signal not executed", len(broker.positions) == 4)

        # 8) real account without live enable → refused, no order
        code, r = http("POST", srv.url + "/api/v1/accounts", U, {"name": "real", "mode": "auto"})
        broker2 = FakeBroker()
        real = SimEA(srv.url, r["terminal_key"], broker2, login="777", trade_mode="real", allow_real=True)
        real.heartbeat()
        submit("e7", account_ids=[r["account"]["id"]])
        real.tick()
        ex7 = [e for e in http("GET", srv.url + "/api/v1/executions", U)[1]["executions"] if e["signal"]["client_signal_id"] == "e7"][0]
        check("real account without explicit live enable: no order", len(broker2.positions) == 0 and ex7["state"] == "rejected", ex7["reason"])

        # 9) notify mode only displays
        code, r = http("POST", srv.url + "/api/v1/accounts", U, {"name": "watch", "mode": "notify"})
        broker3 = FakeBroker()
        watch = SimEA(srv.url, r["terminal_key"], broker3, login="888")
        watch.heartbeat()
        submit("e8", account_ids=[r["account"]["id"]])
        watch.tick()
        ex8 = [e for e in http("GET", srv.url + "/api/v1/executions", U)[1]["executions"] if e["signal"]["client_signal_id"] == "e8"][0]
        check("notify mode: displayed, no order", ex8["state"] == "displayed" and not broker3.positions)

        # 10) plain-HTTP to a non-local host is refused (HTTPS enforcement on)
        code, _ = http("GET", srv.url + "/api/v1/health", {"Host": "api.example.com"})
        check("HTTPS enforced for non-local hosts", code == 403)
    finally:
        srv.stop()

    fails = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(fails)}/{len(RESULTS)} passed")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
