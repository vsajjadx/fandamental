"""Business logic: signals, accounts and the per-account execution state machine.

Execution states
  awaiting_approval  confirm mode: waits for the user to approve in the web app
  pending            ready to be delivered to the terminal
  approved           approved by the user, ready to be delivered
  delivered          the EA has fetched it (safe to re-deliver: no order was sent yet)
  sending            the EA announced it is about to call OrderSend → NEVER delivered again
  unknown            "sending" with no final report in time → must be reconciled, never re-sent
  displayed | filled | placed | rejected | failed | expired | cancelled   (final)

Duplicate-order protection (defence in depth)
  1. UNIQUE(signal_id, account_id): one execution per signal per account.
  2. UNIQUE(user_id, client_signal_id): re-submitting a signal is a no-op.
  3. The EA must get HTTP 200 on "sending" BEFORE it calls OrderSend. The server re-checks
     expiry / mode / live permission at that moment (server clock = no clock-skew issues).
     Once "sending", the execution is never handed out again; if its outcome is lost it becomes
     "unknown" and the EA reconciles it against the broker using the order comment tag.
  4. The EA itself also looks for the tag in open positions/orders/history before sending.
"""
from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
import uuid
from typing import Any, Optional

from . import security
from .config import Config
from .db import tx
from .models import AccountCreate, AccountSettings, CloseReport, ExecReport, Heartbeat, SignalIn

FINAL = {"displayed", "filled", "placed", "rejected", "failed", "expired", "cancelled"}
OPEN_PRE_SEND = ("awaiting_approval", "pending", "approved", "delivered")

SETTINGS_COLS = [
    "name", "enabled", "mode", "risk_percent", "fixed_lot", "max_lot", "max_spread_points", "max_spread_sl_ratio",
    "max_entry_dev_sl_ratio", "max_open_positions", "max_daily_loss_percent", "tp_index", "symbol_suffix",
    "symbol_map", "allowed_symbols",
]


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, extra: Optional[dict] = None):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra or {}


def now() -> int:
    return int(time.time())


def _row(r: Optional[sqlite3.Row]) -> Optional[dict]:
    return dict(r) if r is not None else None


def tag_for(exec_id: str) -> str:
    """Order comment the EA writes on every order it sends (MT5 comments are max 31 chars)."""
    return "FA:" + exec_id


class Service:
    def __init__(self, conn: sqlite3.Connection, cfg: Config):
        self.conn, self.cfg = conn, cfg
        self.lock = threading.RLock()

    # ------------------------------------------------------------------ audit
    def audit(self, event: str, *, actor: str, user_id=None, account_id=None, ref_id=None, **detail: Any) -> None:
        self.conn.execute(
            "INSERT INTO audit_log(ts,user_id,account_id,actor,event,ref_id,detail) VALUES (?,?,?,?,?,?,?)",
            (now(), user_id, account_id, actor, event, ref_id, security.redact(json.dumps(detail, ensure_ascii=False, default=str))),
        )

    # ------------------------------------------------------------------ users / auth
    def create_user(self, name: str, label: str = "cli") -> tuple[int, str]:
        key = security.new_key(security.USER_PREFIX)
        with self.lock, tx(self.conn):
            cur = self.conn.execute("INSERT INTO users(name, created_at) VALUES (?, ?)", (name, now()))
            uid = cur.lastrowid
            self.conn.execute("INSERT INTO api_keys(user_id,key_hash,prefix,label,created_at) VALUES (?,?,?,?,?)",
                              (uid, security.hash_key(key), security.key_prefix(key), label, now()))
            self.audit("user.created", actor="system", user_id=uid, name=name)
        return uid, key

    def issue_user_key(self, user_id: int, label: str = "cli") -> str:
        key = security.new_key(security.USER_PREFIX)
        with self.lock, tx(self.conn):
            if not self.conn.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone():
                raise ApiError(404, "not_found", "user not found")
            self.conn.execute("INSERT INTO api_keys(user_id,key_hash,prefix,label,created_at) VALUES (?,?,?,?,?)",
                              (user_id, security.hash_key(key), security.key_prefix(key), label, now()))
            self.audit("user.key_issued", actor="system", user_id=user_id, label=label)
        return key

    def revoke_user_keys(self, user_id: int) -> int:
        with self.lock, tx(self.conn):
            n = self.conn.execute("UPDATE api_keys SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (now(), user_id)).rowcount
            self.audit("user.keys_revoked", actor="system", user_id=user_id, count=n)
        return n

    def auth_user(self, key: str) -> Optional[dict]:
        if not key.startswith(security.USER_PREFIX):
            return None
        with self.lock:
            r = self.conn.execute(
                "SELECT u.* FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.key_hash=? AND k.revoked_at IS NULL AND u.disabled=0",
                (security.hash_key(key),)).fetchone()
        return _row(r)

    def auth_terminal(self, key: str) -> Optional[dict]:
        if not key.startswith(security.TERMINAL_PREFIX):
            return None
        with self.lock:
            r = self.conn.execute(
                "SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.terminal_key_hash=? AND u.disabled=0",
                (security.hash_key(key),)).fetchone()
        return _row(r)

    # ------------------------------------------------------------------ accounts
    def _account_for_user(self, user_id: int, account_id: str) -> dict:
        r = self.conn.execute("SELECT * FROM accounts WHERE id=? AND user_id=?", (account_id, user_id)).fetchone()
        if not r:  # same answer whether it does not exist or belongs to someone else
            raise ApiError(404, "not_found", "account not found")
        return dict(r)

    def account_view(self, a: dict) -> dict:
        t = now()
        connected = bool(a.get("last_seen_at")) and t - a["last_seen_at"] <= self.cfg.heartbeat_timeout_sec
        return {
            "id": a["id"], "name": a["name"], "enabled": bool(a["enabled"]), "mode": a["mode"],
            "live_enabled": bool(a["live_enabled"]), "live_enabled_at": a["live_enabled_at"],
            "terminal_key_prefix": a["terminal_key_prefix"],
            "settings": self.settings_of(a),
            "terminal": {
                "connected": connected, "last_seen_at": a["last_seen_at"],
                "seconds_since_seen": (t - a["last_seen_at"]) if a.get("last_seen_at") else None,
                "login": a["mt5_login"], "server": a["mt5_server"], "company": a["mt5_company"],
                "trade_mode": a["mt5_trade_mode"], "currency": a["mt5_currency"], "balance": a["balance"],
                "equity": a["equity"], "trade_allowed": None if a["trade_allowed"] is None else bool(a["trade_allowed"]),
                "ea_allow_real": None if a["ea_allow_real"] is None else bool(a["ea_allow_real"]),
                "ea_version": a["ea_version"],
            },
            "created_at": a["created_at"], "updated_at": a["updated_at"],
        }

    @staticmethod
    def settings_of(a: dict) -> dict:
        return {
            "risk_percent": a["risk_percent"], "fixed_lot": a["fixed_lot"], "max_lot": a["max_lot"],
            "max_spread_points": a["max_spread_points"], "max_spread_sl_ratio": a["max_spread_sl_ratio"],
            "max_entry_dev_sl_ratio": a["max_entry_dev_sl_ratio"], "max_open_positions": a["max_open_positions"],
            "max_daily_loss_percent": a["max_daily_loss_percent"], "tp_index": a["tp_index"],
            "symbol_suffix": a["symbol_suffix"], "symbol_map": json.loads(a["symbol_map"] or "{}"),
            "allowed_symbols": json.loads(a["allowed_symbols"] or "[]"),
        }

    @staticmethod
    def _settings_values(data: AccountSettings) -> dict:
        vals = data.model_dump(exclude_unset=True)
        if "fixed_lot" in vals and vals["fixed_lot"] == 0:
            vals["fixed_lot"] = None
        for k in ("symbol_map", "allowed_symbols"):
            if k in vals and vals[k] is not None:
                vals[k] = json.dumps(vals[k], ensure_ascii=False)
        if "enabled" in vals and vals["enabled"] is not None:
            vals["enabled"] = 1 if vals["enabled"] else 0
        return {k: v for k, v in vals.items() if k in SETTINGS_COLS and (v is not None or k == "fixed_lot")}

    def create_account(self, user: dict, data: AccountCreate) -> tuple[dict, str]:
        key = security.new_key(security.TERMINAL_PREFIX)
        aid = uuid.uuid4().hex
        vals = self._settings_values(data)
        t = now()
        cols = ["id", "user_id", "terminal_key_hash", "terminal_key_prefix", "created_at", "updated_at"] + list(vals)
        params = [aid, user["id"], security.hash_key(key), security.key_prefix(key), t, t] + list(vals.values())
        with self.lock, tx(self.conn):
            self.conn.execute(f"INSERT INTO accounts({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", params)
            self.audit("account.created", actor="user", user_id=user["id"], account_id=aid, settings=vals)
            a = self._account_for_user(user["id"], aid)
        return self.account_view(a), key

    def list_accounts(self, user: dict) -> list[dict]:
        with self.lock:
            rows = self.conn.execute("SELECT * FROM accounts WHERE user_id=? ORDER BY created_at", (user["id"],)).fetchall()
        return [self.account_view(dict(r)) for r in rows]

    def get_account(self, user: dict, account_id: str) -> dict:
        with self.lock:
            return self.account_view(self._account_for_user(user["id"], account_id))

    def update_account(self, user: dict, account_id: str, data: AccountSettings) -> dict:
        vals = self._settings_values(data)
        with self.lock, tx(self.conn):
            a = self._account_for_user(user["id"], account_id)
            if vals:
                sets = ",".join(f"{k}=?" for k in vals)
                self.conn.execute(f"UPDATE accounts SET {sets}, updated_at=? WHERE id=?", [*vals.values(), now(), account_id])
                self.audit("account.updated", actor="user", user_id=user["id"], account_id=account_id,
                           changes=vals, previous_mode=a["mode"])
            a = self._account_for_user(user["id"], account_id)
        return self.account_view(a)

    def rotate_terminal_key(self, user: dict, account_id: str) -> str:
        key = security.new_key(security.TERMINAL_PREFIX)
        with self.lock, tx(self.conn):
            self._account_for_user(user["id"], account_id)
            self.conn.execute("UPDATE accounts SET terminal_key_hash=?, terminal_key_prefix=?, updated_at=? WHERE id=?",
                              (security.hash_key(key), security.key_prefix(key), now(), account_id))
            self.audit("account.key_rotated", actor="user", user_id=user["id"], account_id=account_id)
        return key

    def live_phrase(self, a: dict) -> str:
        return f"ENABLE LIVE {a['mt5_login']}"

    def set_live(self, user: dict, account_id: str, enable: bool, confirm: str) -> dict:
        with self.lock, tx(self.conn):
            a = self._account_for_user(user["id"], account_id)
            if enable:
                if not a["mt5_login"]:
                    raise ApiError(409, "not_bound", "connect the EA once (heartbeat) before enabling live trading")
                if confirm.strip() != self.live_phrase(a):
                    raise ApiError(400, "confirmation_required",
                                   f"type exactly: {self.live_phrase(a)}", {"phrase": self.live_phrase(a)})
                self.conn.execute("UPDATE accounts SET live_enabled=1, live_enabled_at=?, updated_at=? WHERE id=?", (now(), now(), account_id))
            else:
                self.conn.execute("UPDATE accounts SET live_enabled=0, updated_at=? WHERE id=?", (now(), account_id))
            self.audit("account.live_" + ("enabled" if enable else "disabled"), actor="user", user_id=user["id"],
                       account_id=account_id, login=a["mt5_login"], trade_mode=a["mt5_trade_mode"])
            a = self._account_for_user(user["id"], account_id)
        return self.account_view(a)

    def reset_binding(self, user: dict, account_id: str) -> dict:
        with self.lock, tx(self.conn):
            self._account_for_user(user["id"], account_id)
            self.conn.execute("UPDATE accounts SET mt5_login=NULL, mt5_server=NULL, mt5_company=NULL, mt5_trade_mode=NULL, "
                              "live_enabled=0, updated_at=? WHERE id=?", (now(), account_id))
            self.audit("account.binding_reset", actor="user", user_id=user["id"], account_id=account_id)
            a = self._account_for_user(user["id"], account_id)
        return self.account_view(a)

    # ------------------------------------------------------------------ signals
    def signal_view(self, s: dict, executions: Optional[list] = None) -> dict:
        t = now()
        out = {k: s[k] for k in ("id", "client_signal_id", "symbol", "direction", "order_type", "entry", "sl", "tp", "tp2", "tp3",
                                 "timeframe", "confluence", "signal_type", "source", "note", "generated_at", "expires_at", "status", "created_at")}
        out["valid"] = s["status"] == "active" and s["expires_at"] > t
        out["validity"] = "cancelled" if s["status"] == "cancelled" else ("expired" if s["expires_at"] <= t else "active")
        if executions is not None:
            out["executions"] = executions
        return out

    def create_signal(self, user: dict, data: SignalIn) -> tuple[dict, bool]:
        t = now()
        with self.lock, tx(self.conn):
            existing = self.conn.execute("SELECT * FROM signals WHERE user_id=? AND client_signal_id=?",
                                         (user["id"], data.client_signal_id)).fetchone()
            if existing:
                ex = self._executions_for_signal(existing["id"])
                return self.signal_view(dict(existing), ex), False
            if data.generated_at > t + 120:
                raise ApiError(422, "clock_skew", "generated_at is in the future (check the device clock)")
            age = t - data.generated_at
            if age > self.cfg.signal_max_age_sec:
                self.audit("signal.refused", actor="user", user_id=user["id"], reason="stale", age=age, symbol=data.symbol)
                raise _Refused(422, "stale_signal", f"signal is {age}s old (max {self.cfg.signal_max_age_sec}s)")  # keeps the audit row
            ttl = data.valid_for_sec or self.cfg.signal_default_ttl_sec
            expires = data.generated_at + ttl
            if expires <= t:
                raise ApiError(422, "expired_signal", "signal already expired")

            if data.account_ids is not None:
                accounts = [self._account_for_user(user["id"], aid) for aid in data.account_ids]
            else:
                accounts = [dict(r) for r in self.conn.execute("SELECT * FROM accounts WHERE user_id=? AND enabled=1", (user["id"],))]

            sid = uuid.uuid4().hex
            self.conn.execute(
                "INSERT INTO signals(id,user_id,client_signal_id,symbol,direction,order_type,entry,sl,tp,tp2,tp3,timeframe,"
                "confluence,signal_type,note,generated_at,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (sid, user["id"], data.client_signal_id, data.symbol, data.direction, data.order_type, data.entry, data.sl, data.tp,
                 data.tp2, data.tp3, data.timeframe, data.confluence, data.signal_type, data.note, data.generated_at, expires, t))
            for a in accounts:
                allowed = json.loads(a["allowed_symbols"] or "[]")
                if not a["enabled"]:
                    action, state, reason = "notify", "rejected", "account disabled"
                elif allowed and data.symbol not in allowed:
                    action, state, reason = "notify", "rejected", "symbol not in this account's allowed list"
                elif a["mode"] == "notify":
                    action, state, reason = "notify", "pending", ""
                elif a["mode"] == "confirm":
                    action, state, reason = "execute", "awaiting_approval", ""
                else:
                    action, state, reason = "execute", "pending", ""
                self.conn.execute(
                    "INSERT INTO executions(id,signal_id,account_id,user_id,action,state,reason,created_at,updated_at,finished_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (secrets.token_hex(8), sid, a["id"], user["id"], action, state, reason, t, t, t if state in FINAL else None))
            self.audit("signal.created", actor="user", user_id=user["id"], ref_id=sid, symbol=data.symbol,
                       direction=data.direction, timeframe=data.timeframe, accounts=len(accounts))
            s = dict(self.conn.execute("SELECT * FROM signals WHERE id=?", (sid,)).fetchone())
            return self.signal_view(s, self._executions_for_signal(sid)), True

    def _executions_for_signal(self, sid: str) -> list[dict]:
        rows = self.conn.execute("SELECT * FROM executions WHERE signal_id=? ORDER BY created_at", (sid,)).fetchall()
        return [self.exec_view(dict(r)) for r in rows]

    def list_signals(self, user: dict, limit: int = 50) -> list[dict]:
        with self.lock:
            self._sweep(user_id=user["id"])
            rows = self.conn.execute("SELECT * FROM signals WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
                                     (user["id"], max(1, min(limit, 500)))).fetchall()
            return [self.signal_view(dict(r), self._executions_for_signal(r["id"])) for r in rows]

    def get_signal(self, user: dict, sid: str) -> dict:
        with self.lock:
            self._sweep(user_id=user["id"])
            r = self.conn.execute("SELECT * FROM signals WHERE id=? AND user_id=?", (sid, user["id"])).fetchone()
            if not r:
                raise ApiError(404, "not_found", "signal not found")
            return self.signal_view(dict(r), self._executions_for_signal(sid))

    def cancel_signal(self, user: dict, sid: str) -> dict:
        with self.lock, tx(self.conn):
            r = self.conn.execute("SELECT * FROM signals WHERE id=? AND user_id=?", (sid, user["id"])).fetchone()
            if not r:
                raise ApiError(404, "not_found", "signal not found")
            t = now()
            self.conn.execute("UPDATE signals SET status='cancelled' WHERE id=?", (sid,))
            n = self.conn.execute(
                f"UPDATE executions SET state='cancelled', reason='signal cancelled by user', updated_at=?, finished_at=? "
                f"WHERE signal_id=? AND state IN ({','.join('?' * len(OPEN_PRE_SEND))})", (t, t, sid, *OPEN_PRE_SEND)).rowcount
            self.audit("signal.cancelled", actor="user", user_id=user["id"], ref_id=sid, executions_cancelled=n)
            s = dict(self.conn.execute("SELECT * FROM signals WHERE id=?", (sid,)).fetchone())
            return self.signal_view(s, self._executions_for_signal(sid))

    # ------------------------------------------------------------------ executions
    def exec_view(self, e: dict, signal: Optional[dict] = None) -> dict:
        out = {k: e[k] for k in ("id", "signal_id", "account_id", "action", "state", "reason", "delivery_count", "broker_symbol",
                                 "requested_price", "fill_price", "volume", "sl", "tp", "ticket", "retcode", "created_at",
                                 "updated_at", "delivered_at", "approved_at", "sending_at", "finished_at",
                                 "close_price", "profit", "closed_at", "close_reason")}
        out["tag"] = tag_for(e["id"])
        out["position_status"] = ("closed" if e["closed_at"] else "open") if e["state"] == "filled" else None
        out["final"] = e["state"] in FINAL
        if signal is not None:
            out["signal"] = self.signal_view(signal)
        return out

    def list_executions(self, user: dict, account_id: Optional[str] = None, state: Optional[str] = None, limit: int = 100) -> list[dict]:
        with self.lock:
            self._sweep(user_id=user["id"])
            q, p = "SELECT * FROM executions WHERE user_id=?", [user["id"]]
            if account_id:
                self._account_for_user(user["id"], account_id)
                q += " AND account_id=?"; p.append(account_id)
            if state:
                q += " AND state=?"; p.append(state)
            q += " ORDER BY created_at DESC LIMIT ?"; p.append(max(1, min(limit, 500)))
            rows = self.conn.execute(q, p).fetchall()
            sigs = {}
            out = []
            for r in rows:
                if r["signal_id"] not in sigs:
                    sigs[r["signal_id"]] = dict(self.conn.execute("SELECT * FROM signals WHERE id=?", (r["signal_id"],)).fetchone())
                out.append(self.exec_view(dict(r), sigs[r["signal_id"]]))
            return out

    def _exec_for_user(self, user_id: int, exec_id: str) -> dict:
        r = self.conn.execute("SELECT * FROM executions WHERE id=? AND user_id=?", (exec_id, user_id)).fetchone()
        if not r:
            raise ApiError(404, "not_found", "execution not found")
        return dict(r)

    def approve(self, user: dict, exec_id: str) -> dict:
        with self.lock, tx(self.conn):
            self._sweep(user_id=user["id"])
            e = self._exec_for_user(user["id"], exec_id)
            if e["state"] != "awaiting_approval":
                raise ApiError(409, "bad_state", f"execution is '{e['state']}', not awaiting approval", {"state": e["state"]})
            t = now()
            self.conn.execute("UPDATE executions SET state='approved', approved_at=?, updated_at=? WHERE id=?", (t, t, exec_id))
            self.audit("execution.approved", actor="user", user_id=user["id"], account_id=e["account_id"], ref_id=exec_id)
            return self.exec_view(self._exec_for_user(user["id"], exec_id))

    def reject(self, user: dict, exec_id: str, reason: str) -> dict:
        with self.lock, tx(self.conn):
            e = self._exec_for_user(user["id"], exec_id)
            if e["state"] not in OPEN_PRE_SEND:
                raise ApiError(409, "bad_state", f"execution is '{e['state']}' and can no longer be cancelled", {"state": e["state"]})
            t = now()
            self.conn.execute("UPDATE executions SET state='cancelled', reason=?, updated_at=?, finished_at=? WHERE id=?",
                              ("rejected by user" + (": " + reason if reason else ""), t, t, exec_id))
            self.audit("execution.rejected_by_user", actor="user", user_id=user["id"], account_id=e["account_id"], ref_id=exec_id)
            return self.exec_view(self._exec_for_user(user["id"], exec_id))

    def _sweep(self, *, user_id: Optional[int] = None, account_id: Optional[str] = None) -> None:
        """Expire undelivered work whose signal expired; flag lost 'sending' outcomes as 'unknown'."""
        t = now()
        scope, p = ("e.account_id=?", [account_id]) if account_id else ("e.user_id=?", [user_id])
        own_tx = not self.conn.in_transaction
        if own_tx:
            self.conn.execute("BEGIN IMMEDIATE")
        try:
            rows = self.conn.execute(
                f"SELECT e.id, e.user_id, e.account_id, s.expires_at, s.status FROM executions e JOIN signals s ON s.id=e.signal_id "
                f"WHERE {scope} AND e.state IN ({','.join('?' * len(OPEN_PRE_SEND))}) AND (s.expires_at<=? OR s.status='cancelled')",
                (*p, *OPEN_PRE_SEND, t)).fetchall()
            for r in rows:
                st, why = ("cancelled", "signal cancelled by user") if r["status"] == "cancelled" else ("expired", "signal expired before execution")
                self.conn.execute("UPDATE executions SET state=?, reason=?, updated_at=?, finished_at=? WHERE id=?", (st, why, t, t, r["id"]))
                self.audit("execution." + st, actor="system", user_id=r["user_id"], account_id=r["account_id"], ref_id=r["id"])
            lost = self.conn.execute(f"SELECT e.id, e.user_id, e.account_id FROM executions e WHERE {scope} AND e.state='sending' AND e.sending_at<=?",
                                     (*p, t - self.cfg.sending_timeout_sec)).fetchall()
            for r in lost:
                self.conn.execute("UPDATE executions SET state='unknown', reason='no result reported after send; awaiting reconciliation, will NOT be re-sent', "
                                  "updated_at=? WHERE id=?", (t, r["id"]))
                self.audit("execution.unknown", actor="system", user_id=r["user_id"], account_id=r["account_id"], ref_id=r["id"])
        except BaseException:
            if own_tx:
                self.conn.execute("ROLLBACK")
            raise
        if own_tx:
            self.conn.execute("COMMIT")

    # ------------------------------------------------------------------ terminal (EA) side
    def ea_config(self, a: dict) -> dict:
        return {
            "account_id": a["id"], "enabled": bool(a["enabled"]), "mode": a["mode"], "live_enabled": bool(a["live_enabled"]),
            "settings": self.settings_of(a), "server_time": now(),
        }

    def heartbeat(self, a: dict, hb: Heartbeat) -> dict:
        with self.lock, tx(self.conn):
            if a["mt5_login"] and (a["mt5_login"] != hb.login or (a["mt5_server"] or "") != hb.server):
                self.audit("terminal.binding_mismatch", actor="terminal", user_id=a["user_id"], account_id=a["id"],
                           expected_login=a["mt5_login"], got_login=hb.login, got_server=hb.server)
                raise ApiError(409, "binding_mismatch",
                               "this terminal key is bound to another MT5 login/server; reset the binding in the web app or create a new connection")
            first = not a["mt5_login"]
            self.conn.execute(
                "UPDATE accounts SET mt5_login=?, mt5_server=?, mt5_company=?, mt5_trade_mode=?, mt5_currency=?, balance=?, equity=?, "
                "trade_allowed=?, ea_allow_real=?, ea_version=?, last_seen_at=? WHERE id=?",
                (hb.login, hb.server, hb.company, hb.trade_mode, hb.currency, hb.balance, hb.equity, int(hb.trade_allowed),
                 int(hb.ea_allow_real), hb.ea_version, now(), a["id"]))
            if first:
                self.audit("terminal.bound", actor="terminal", user_id=a["user_id"], account_id=a["id"], login=hb.login,
                           server=hb.server, trade_mode=hb.trade_mode)
            a = dict(self.conn.execute("SELECT * FROM accounts WHERE id=?", (a["id"],)).fetchone())
        return self.ea_config(a)

    def poll(self, a: dict) -> dict:
        t = now()
        with self.lock, tx(self.conn):
            self.conn.execute("UPDATE accounts SET last_seen_at=? WHERE id=?", (t, a["id"]))
            self._sweep(account_id=a["id"])
            a = dict(self.conn.execute("SELECT * FROM accounts WHERE id=?", (a["id"],)).fetchone())
            items = []
            if a["enabled"] and a["mt5_login"]:
                self.conn.execute("UPDATE executions SET state='delivered', delivered_at=?, updated_at=?, delivery_count=delivery_count+1 "
                                  "WHERE account_id=? AND state IN ('pending','approved')", (t, t, a["id"]))
                rows = self.conn.execute(
                    "SELECT e.*, s.symbol, s.direction, s.order_type, s.entry, s.sl AS s_sl, s.tp AS s_tp, s.tp2, s.tp3, s.timeframe, "
                    "s.generated_at, s.expires_at, s.confluence, s.client_signal_id FROM executions e JOIN signals s ON s.id=e.signal_id "
                    "WHERE e.account_id=? AND e.state='delivered' ORDER BY e.created_at LIMIT 20", (a["id"],)).fetchall()
                for r in rows:
                    items.append({
                        "execution_id": r["id"], "action": r["action"], "tag": tag_for(r["id"]),
                        "signal": {
                            "id": r["signal_id"], "client_signal_id": r["client_signal_id"], "symbol": r["symbol"],
                            "direction": r["direction"], "order_type": r["order_type"], "entry": r["entry"], "sl": r["s_sl"],
                            "tp": r["s_tp"], "tp2": r["tp2"], "tp3": r["tp3"], "timeframe": r["timeframe"],
                            "confluence": r["confluence"], "generated_at": r["generated_at"], "expires_at": r["expires_at"],
                        },
                        "age_sec": t - r["generated_at"], "expires_in_sec": r["expires_at"] - t,
                    })
            reconcile = [{"execution_id": r["id"], "tag": tag_for(r["id"]), "state": r["state"]}
                         for r in self.conn.execute("SELECT id, state FROM executions WHERE account_id=? AND state='unknown'", (a["id"],))]
            # filled positions whose close has not been reported yet: the EA checks them and reports the outcome
            watch = [{"execution_id": r["id"], "ticket": r["ticket"]}
                     for r in self.conn.execute("SELECT id, ticket FROM executions WHERE account_id=? AND state='filled' AND closed_at IS NULL "
                                                "AND ticket IS NOT NULL ORDER BY created_at DESC LIMIT 50", (a["id"],))]
        return {"config": self.ea_config(a), "items": items, "reconcile": reconcile, "watch": watch, "server_time": t,
                "bound": bool(a["mt5_login"])}

    def report(self, a: dict, exec_id: str, rep: ExecReport) -> dict:
        t = now()
        with self.lock, tx(self.conn):
            r = self.conn.execute("SELECT * FROM executions WHERE id=? AND account_id=?", (exec_id, a["id"])).fetchone()
            if not r:
                raise ApiError(404, "not_found", "execution not found")
            e = dict(r)
            if e["last_report_id"] == rep.report_id:   # retried request after a network drop → idempotent
                # the same EA attempt re-asking for its go: it has not sent yet (it never saw the answer), so repeat it
                return {"execution": self.exec_view(e), "duplicate": True, "go": rep.state == "sending" and e["state"] == "sending"}
            a = dict(self.conn.execute("SELECT * FROM accounts WHERE id=?", (a["id"],)).fetchone())
            s = dict(self.conn.execute("SELECT * FROM signals WHERE id=?", (e["signal_id"],)).fetchone())
            cur, new = e["state"], rep.state

            def refuse(state: str, code: str, msg: str):
                self.conn.execute("UPDATE executions SET state=?, reason=?, updated_at=?, finished_at=? WHERE id=?", (state, msg, t, t, exec_id))
                self.audit("execution.send_refused", actor="system", user_id=a["user_id"], account_id=a["id"], ref_id=exec_id, code=code, reason=msg)
                raise _Refused(409, code, msg, {"state": state})

            if new == "sending":
                if cur != "delivered":
                    raise ApiError(409, "bad_state", f"cannot start sending from '{cur}'", {"state": cur})
                if e["action"] != "execute":
                    raise ApiError(409, "notify_only", "this execution is display-only", {"state": cur})
                if s["status"] == "cancelled":
                    refuse("cancelled", "cancelled", "signal cancelled by user")
                if s["expires_at"] <= t:
                    refuse("expired", "expired", "signal expired before execution")
                if not a["enabled"]:
                    refuse("rejected", "account_disabled", "connection disabled in the web app")
                if a["mode"] == "notify":
                    refuse("rejected", "mode_changed", "account switched to notify-only mode")
                if a["mt5_trade_mode"] not in ("demo", "real", "contest"):
                    refuse("rejected", "unknown_account_type", "account type (demo/real) not reported by the EA")
                if a["mt5_trade_mode"] != "demo":
                    if not a["live_enabled"]:
                        refuse("rejected", "live_not_enabled", "real account: live trading is not enabled in the web app")
                    if not a["ea_allow_real"]:
                        refuse("rejected", "ea_real_not_allowed", "real account: AllowRealAccount is false in the EA inputs")
                self.conn.execute("UPDATE executions SET state='sending', sending_at=?, updated_at=?, last_report_id=?, broker_symbol=?, "
                                  "requested_price=?, volume=?, sl=?, tp=? WHERE id=?",
                                  (t, t, rep.report_id, rep.broker_symbol, rep.requested_price, rep.volume, rep.sl, rep.tp, exec_id))
                self.audit("execution.sending", actor="terminal", user_id=a["user_id"], account_id=a["id"], ref_id=exec_id,
                           symbol=rep.broker_symbol, volume=rep.volume)
                return {"execution": self.exec_view(self._exec(exec_id)), "go": True}

            allowed = {
                # execute: "filled"/"placed" here only means the EA found an order already carrying this tag (it does not send)
                "delivered": {"displayed", "rejected"} if e["action"] == "notify" else {"rejected", "filled", "placed"},
                "sending": {"filled", "placed", "failed", "unknown", "rejected"},
                "unknown": {"filled", "placed", "failed", "not_found"},
            }.get(cur, set())
            if cur in FINAL:
                if new == cur or (new == "not_found" and cur == "failed"):
                    return {"execution": self.exec_view(e), "duplicate": True}
                raise ApiError(409, "already_final", f"execution already '{cur}'", {"state": cur})
            if new not in allowed:
                raise ApiError(409, "bad_transition", f"'{cur}' → '{new}' is not allowed", {"state": cur})

            state = "failed" if new == "not_found" else new
            reason = rep.reason or ("order not found at broker during reconciliation; not re-sent" if new == "not_found" else "")
            fin = t if state in FINAL else None
            self.conn.execute(
                "UPDATE executions SET state=?, reason=?, updated_at=?, finished_at=COALESCE(?, finished_at), last_report_id=?, "
                "broker_symbol=COALESCE(?, broker_symbol), requested_price=COALESCE(?, requested_price), fill_price=COALESCE(?, fill_price), "
                "volume=COALESCE(?, volume), sl=COALESCE(?, sl), tp=COALESCE(?, tp), ticket=COALESCE(?, ticket), retcode=COALESCE(?, retcode) WHERE id=?",
                (state, reason, t, fin, rep.report_id, rep.broker_symbol, rep.requested_price, rep.fill_price, rep.volume, rep.sl, rep.tp,
                 rep.ticket, rep.retcode, exec_id))
            self.audit("execution." + state, actor="terminal", user_id=a["user_id"], account_id=a["id"], ref_id=exec_id,
                       reason=reason, retcode=rep.retcode, ticket=rep.ticket, fill_price=rep.fill_price, volume=rep.volume)
            return {"execution": self.exec_view(self._exec(exec_id))}

    def report_close(self, a: dict, exec_id: str, rep: CloseReport) -> dict:
        with self.lock, tx(self.conn):
            r = self.conn.execute("SELECT * FROM executions WHERE id=? AND account_id=?", (exec_id, a["id"])).fetchone()
            if not r:
                raise ApiError(404, "not_found", "execution not found")
            e = dict(r)
            if e["state"] != "filled":
                raise ApiError(409, "bad_state", f"only filled executions can be closed (is '{e['state']}')", {"state": e["state"]})
            if e["closed_at"]:
                return {"execution": self.exec_view(e), "duplicate": True}
            self.conn.execute("UPDATE executions SET close_price=?, profit=?, closed_at=?, close_reason=?, updated_at=? WHERE id=?",
                              (rep.close_price, rep.profit, rep.closed_at or now(), rep.close_reason, now(), exec_id))
            self.audit("execution.position_closed", actor="terminal", user_id=a["user_id"], account_id=a["id"], ref_id=exec_id,
                       profit=rep.profit, close_price=rep.close_price, reason=rep.close_reason)
            return {"execution": self.exec_view(self._exec(exec_id))}

    def _exec(self, exec_id: str) -> dict:
        return dict(self.conn.execute("SELECT * FROM executions WHERE id=?", (exec_id,)).fetchone())

    def audit_list(self, user: dict, limit: int = 100) -> list[dict]:
        with self.lock:
            rows = self.conn.execute("SELECT ts,account_id,actor,event,ref_id,detail FROM audit_log WHERE user_id=? ORDER BY id DESC LIMIT ?",
                                     (user["id"], max(1, min(limit, 500)))).fetchall()
        return [{**dict(r), "detail": json.loads(r["detail"] or "{}")} for r in rows]


class _Refused(ApiError):
    """A refusal that must still COMMIT the state change (so the EA never retries it)."""
    commit_on_raise = True
