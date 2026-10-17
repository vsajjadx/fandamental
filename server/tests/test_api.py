"""Backend tests. Run from server/:  python3 -m unittest discover -s tests -v"""
from __future__ import annotations

import io
import json
import logging
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from starlette.testclient import TestClient  # noqa: E402

from app import services  # noqa: E402
from app.config import Config  # noqa: E402
from app.db import connect, migrate  # noqa: E402
from app.main import create_app  # noqa: E402
from app.security import redact  # noqa: E402


class Clock:
    """Controls services.now() so expiry/timeouts can be tested without sleeping."""

    def __init__(self):
        self.t = int(time.time())

    def __call__(self):
        return self.t


class Base(unittest.TestCase):
    rate = 10000

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = Config(db_path=os.path.join(self.tmp.name, "t.db"), allowed_origins=["https://vsajjadx.github.io"],
                          require_https=True, rate_limit_per_min=self.rate, log_level="WARNING")
        self.clock = Clock()
        self.p = mock.patch.object(services, "now", self.clock)
        self.p.start()
        self.app = create_app(self.cfg)
        self.svc = self.app.state.service
        self.c = TestClient(self.app, base_url="https://testserver")
        _, self.ukey = self.svc.create_user("alice")
        _, self.ukey_b = self.svc.create_user("bob")

    def tearDown(self):
        self.p.stop()
        self.svc.conn.close()
        self.tmp.cleanup()

    # helpers
    def H(self, key=None):
        return {"Authorization": "Bearer " + (key or self.ukey)}

    def T(self, tkey):
        return {"X-Terminal-Key": tkey}

    def account(self, mode="notify", key=None, **kw):
        r = self.c.post("/api/v1/accounts", json={"name": "demo-1", "mode": mode, **kw}, headers=self.H(key))
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["account"], r.json()["terminal_key"]

    def heartbeat(self, tkey, login="5001234", trade_mode="demo", **kw):
        body = {"login": login, "server": "MetaQuotes-Demo", "company": "MetaQuotes", "trade_mode": trade_mode,
                "currency": "USD", "balance": 10000, "equity": 10000, "trade_allowed": True, "ea_version": "1.00", **kw}
        return self.c.post("/api/v1/ea/heartbeat", json=body, headers=self.T(tkey))

    def signal(self, cid="s1", key=None, **kw):
        body = {"client_signal_id": cid, "symbol": "XAUUSD", "direction": "buy", "entry": 2400.0, "sl": 2390.0, "tp": 2420.0,
                "timeframe": "1h", "generated_at": self.clock.t - 5, "confluence": 74, **kw}
        return self.c.post("/api/v1/signals", json=body, headers=self.H(key))

    def poll(self, tkey):
        r = self.c.get("/api/v1/ea/pending", headers=self.T(tkey))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def report(self, tkey, eid, state, rid=None, **kw):
        return self.c.post(f"/api/v1/ea/executions/{eid}/report", json={"report_id": rid or f"r-{state}-{eid}", "state": state, **kw},
                           headers=self.T(tkey))

    def exec_state(self, eid):
        return self.svc.conn.execute("SELECT state, reason FROM executions WHERE id=?", (eid,)).fetchone()


class TestTransportAndAuth(Base):
    def test_health(self):
        r = self.c.get("/api/v1/health")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["ok"])

    def test_plain_http_refused_on_public_host(self):
        c = TestClient(self.app, base_url="http://api.example.com")
        r = c.get("/api/v1/health")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"]["code"], "https_required")

    def test_auth_required_and_key_kinds_not_interchangeable(self):
        _, tkey = self.account()
        self.assertEqual(self.c.get("/api/v1/accounts").status_code, 401)
        self.assertEqual(self.c.get("/api/v1/accounts", headers={"Authorization": "Bearer fa_u_wrong"}).status_code, 401)
        self.assertEqual(self.c.get("/api/v1/accounts", headers={"Authorization": "Bearer " + tkey}).status_code, 401)
        self.assertEqual(self.c.get("/api/v1/ea/pending", headers=self.T(self.ukey)).status_code, 401)
        self.assertEqual(self.c.get("/api/v1/ea/pending").status_code, 401)

    def test_terminal_key_shown_once_and_never_stored_in_clear(self):
        acc, tkey = self.account()
        self.assertTrue(tkey.startswith("fa_t_"))
        listed = self.c.get("/api/v1/accounts", headers=self.H()).json()["accounts"][0]
        self.assertNotIn(tkey, json.dumps(listed))
        dump = "\n".join(self.svc.conn.iterdump())
        self.assertNotIn(tkey, dump)
        self.assertNotIn(self.ukey, dump)

    def test_rotate_key_invalidates_old_one(self):
        acc, tkey = self.account()
        r = self.c.post(f"/api/v1/accounts/{acc['id']}/rotate-key", headers=self.H())
        new = r.json()["terminal_key"]
        self.assertEqual(self.heartbeat(tkey).status_code, 401)
        self.assertEqual(self.heartbeat(new).status_code, 200)

    def test_bad_json_and_too_large(self):
        r = self.c.post("/api/v1/signals", content=b"{not json", headers={**self.H(), "Content-Type": "application/json"})
        self.assertEqual(r.status_code, 400)
        r = self.c.post("/api/v1/signals", content=b"x" * (70 * 1024), headers={**self.H(), "Content-Type": "application/json"})
        self.assertEqual(r.status_code, 413)

    def test_cors_only_for_allowed_origin(self):
        pre = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"}
        ok = self.c.options("/api/v1/signals", headers={"Origin": "https://vsajjadx.github.io", **pre})
        self.assertEqual(ok.headers.get("access-control-allow-origin"), "https://vsajjadx.github.io")
        bad = self.c.options("/api/v1/signals", headers={"Origin": "https://evil.example", **pre})
        self.assertIsNone(bad.headers.get("access-control-allow-origin"))


class TestRateLimit(Base):
    rate = 5

    def test_rate_limited(self):
        codes = [self.c.get("/api/v1/me", headers=self.H()).status_code for _ in range(7)]
        self.assertEqual(codes[:5], [200] * 5)
        self.assertEqual(codes[5], 429)


class TestSignals(Base):
    def test_validation(self):
        cases = [
            ({"sl": 2410.0}, "sl < entry < tp"),
            ({"direction": "sell"}, "sl > entry > tp"),
            ({"timeframe": "2h"}, "timeframe"),
            ({"entry": float("nan")}, None),
            ({"symbol": "BAD SYMBOL!"}, "symbol"),
            ({"tp2": 2395.0}, "tp2"),
            ({"client_signal_id": "has space"}, "client_signal_id"),
        ]
        for i, (patch, needle) in enumerate(cases):
            body = {"client_signal_id": f"v{i}", "symbol": "XAUUSD", "direction": "buy", "entry": 2400.0, "sl": 2390.0, "tp": 2420.0,
                    "timeframe": "1h", "generated_at": self.clock.t}
            body.update(patch)
            raw = json.dumps(body, allow_nan=True)
            r = self.c.post("/api/v1/signals", content=raw, headers={**self.H(), "Content-Type": "application/json"})
            self.assertIn(r.status_code, (400, 422), (patch, r.text))
            if needle:
                self.assertIn(needle, r.text, patch)

    def test_normalisation(self):
        r = self.signal(symbol="eur/usd", direction="long", entry=1.1, sl=1.09, tp=1.12, timeframe="1D")
        self.assertEqual(r.status_code, 201, r.text)
        s = r.json()["signal"]
        self.assertEqual((s["symbol"], s["direction"], s["timeframe"]), ("EURUSD", "buy", "1d"))
        self.assertEqual(s["validity"], "active")

    def test_stale_and_future_refused_and_audited(self):
        r = self.signal(cid="old", generated_at=self.clock.t - 10_000)
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["error"]["code"], "stale_signal")
        ev = [e["event"] for e in self.c.get("/api/v1/audit", headers=self.H()).json()["events"]]
        self.assertIn("signal.refused", ev)
        r = self.signal(cid="fut", generated_at=self.clock.t + 3600)
        self.assertEqual(r.json()["error"]["code"], "clock_skew")

    def test_idempotent_resubmit(self):
        self.account()
        a = self.signal(cid="dup")
        b = self.signal(cid="dup")
        self.assertEqual(a.status_code, 201)
        self.assertEqual(b.status_code, 200)
        self.assertFalse(b.json()["created"])
        self.assertEqual(a.json()["signal"]["id"], b.json()["signal"]["id"])
        self.assertEqual(self.svc.conn.execute("SELECT COUNT(*) FROM executions").fetchone()[0], 1)

    def test_allowed_symbols(self):
        self.account(allowed_symbols=["EURUSD"])
        ex = self.signal().json()["signal"]["executions"][0]
        self.assertEqual(ex["state"], "rejected")
        self.assertIn("allowed", ex["reason"])

    def test_cancel(self):
        acc, tkey = self.account(mode="auto")
        self.heartbeat(tkey)
        sid = self.signal().json()["signal"]["id"]
        self.poll(tkey)  # delivered
        s = self.c.post(f"/api/v1/signals/{sid}/cancel", headers=self.H()).json()["signal"]
        self.assertEqual(s["validity"], "cancelled")
        self.assertEqual(s["executions"][0]["state"], "cancelled")
        self.assertEqual(self.poll(tkey)["items"], [])


class TestNotifyFlow(Base):
    def test_requires_binding_then_delivers_and_redelivers_until_reported(self):
        acc, tkey = self.account(mode="notify")
        self.signal()
        self.assertEqual(self.poll(tkey)["items"], [], "nothing is delivered before the EA has identified its account")
        self.assertEqual(self.heartbeat(tkey).status_code, 200)
        items = self.poll(tkey)["items"]
        self.assertEqual(len(items), 1)
        it = items[0]
        self.assertEqual(it["action"], "notify")
        self.assertEqual(it["tag"], "FA:" + it["execution_id"])
        self.assertLessEqual(len(it["tag"]), 31, "MT5 order comments are limited to 31 characters")
        self.assertEqual(len(self.poll(tkey)["items"]), 1, "delivered-but-unacknowledged work is re-delivered")
        self.assertEqual(self.report(tkey, it["execution_id"], "sending").status_code, 409, "notify items can never be executed")
        self.assertEqual(self.report(tkey, it["execution_id"], "displayed").status_code, 200)
        self.assertEqual(self.poll(tkey)["items"], [])

    def test_connection_status(self):
        acc, tkey = self.account()
        self.assertFalse(self.c.get(f"/api/v1/accounts/{acc['id']}", headers=self.H()).json()["account"]["terminal"]["connected"])
        self.heartbeat(tkey)
        t = self.c.get(f"/api/v1/accounts/{acc['id']}", headers=self.H()).json()["account"]["terminal"]
        self.assertTrue(t["connected"])
        self.assertEqual((t["login"], t["trade_mode"]), ("5001234", "demo"))
        self.clock.t += self.cfg.heartbeat_timeout_sec + 1
        self.assertFalse(self.c.get(f"/api/v1/accounts/{acc['id']}", headers=self.H()).json()["account"]["terminal"]["connected"])


class TestAutoFlow(Base):
    def setUp(self):
        super().setUp()
        self.acc, self.tkey = self.account(mode="auto")
        self.heartbeat(self.tkey)

    def deliver(self, **kw):
        self.signal(**kw)
        items = self.poll(self.tkey)["items"]
        self.assertEqual(len(items), 1)
        return items[0]["execution_id"]

    def test_demo_fill_and_idempotent_reports(self):
        eid = self.deliver()
        r = self.report(self.tkey, eid, "sending", rid="rep-a1", broker_symbol="XAUUSD.m", volume=0.01)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["go"])
        self.assertEqual(self.poll(self.tkey)["items"], [], "an execution in 'sending' is never handed out again")
        retry = self.report(self.tkey, eid, "sending", rid="rep-a1")
        self.assertTrue(retry.json()["go"] and retry.json()["duplicate"], "same attempt retrying after a lost response gets the same go")
        again = self.report(self.tkey, eid, "sending", rid="rep-a2")
        self.assertEqual(again.status_code, 409, "second 'sending' (e.g. another EA instance) must not get a go")
        f = self.report(self.tkey, eid, "filled", rid="rep-a3", fill_price=2400.4, ticket="123456", retcode=10009, volume=0.01)
        self.assertEqual(f.status_code, 200)
        self.assertTrue(self.report(self.tkey, eid, "filled", rid="rep-a3").json()["duplicate"], "retried report is a no-op")
        self.assertEqual(self.report(self.tkey, eid, "failed", rid="rep-a4").status_code, 409)
        ex = self.c.get("/api/v1/executions", headers=self.H()).json()["executions"][0]
        self.assertEqual((ex["state"], ex["fill_price"], ex["ticket"], ex["broker_symbol"]), ("filled", 2400.4, "123456", "XAUUSD.m"))

    def test_position_close_is_recorded_once(self):
        eid = self.deliver()
        self.report(self.tkey, eid, "sending", rid="rep-c1")
        self.report(self.tkey, eid, "filled", rid="rep-c2", ticket="555", fill_price=2400.0)
        self.assertEqual(self.poll(self.tkey)["watch"], [{"execution_id": eid, "ticket": "555"}])
        body = {"report_id": "close-1", "close_price": 2420.0, "profit": 19.6, "close_reason": "tp"}
        r = self.c.post(f"/api/v1/ea/executions/{eid}/closed", json=body, headers=self.T(self.tkey))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(self.c.post(f"/api/v1/ea/executions/{eid}/closed", json=body, headers=self.T(self.tkey)).json()["duplicate"])
        self.assertEqual(self.poll(self.tkey)["watch"], [])
        ex = self.c.get("/api/v1/executions", headers=self.H()).json()["executions"][0]
        self.assertEqual((ex["position_status"], ex["profit"], ex["close_reason"]), ("closed", 19.6, "tp"))

    def test_migration_0002_on_existing_data(self):
        """0002 added columns to a table that already had rows: those rows must survive with NULLs."""
        eid = self.deliver()
        row = self.svc.conn.execute("SELECT state, closed_at FROM executions WHERE id=?", (eid,)).fetchone()
        self.assertEqual((row["state"], row["closed_at"]), ("delivered", None))

    def test_expired_before_send_is_refused_and_persisted(self):
        eid = self.deliver(valid_for_sec=60)
        self.clock.t += 120
        r = self.report(self.tkey, eid, "sending")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["error"]["code"], "expired")
        self.assertEqual(self.exec_state(eid)["state"], "expired")

    def test_expired_never_delivered(self):
        self.signal(valid_for_sec=60)
        self.clock.t += 61
        self.assertEqual(self.poll(self.tkey)["items"], [])
        self.assertEqual(self.c.get("/api/v1/executions", headers=self.H()).json()["executions"][0]["state"], "expired")

    def test_mode_switched_to_notify_blocks_send(self):
        eid = self.deliver()
        self.c.patch(f"/api/v1/accounts/{self.acc['id']}", json={"mode": "notify"}, headers=self.H())
        r = self.report(self.tkey, eid, "sending")
        self.assertEqual(r.json()["error"]["code"], "mode_changed")

    def test_disabled_account(self):
        self.c.patch(f"/api/v1/accounts/{self.acc['id']}", json={"enabled": False}, headers=self.H())
        self.signal()
        self.assertEqual(self.poll(self.tkey)["items"], [])
        self.assertEqual(self.c.get("/api/v1/executions", headers=self.H()).json()["executions"], [],
                         "disabled connections are skipped when a signal is routed")

    def test_lost_result_becomes_unknown_and_is_reconciled_not_resent(self):
        eid = self.deliver()
        self.assertEqual(self.report(self.tkey, eid, "sending").status_code, 200)
        self.clock.t += self.cfg.sending_timeout_sec + 1
        p = self.poll(self.tkey)
        self.assertEqual(p["items"], [])
        self.assertEqual([r["execution_id"] for r in p["reconcile"]], [eid])
        self.assertEqual(self.exec_state(eid)["state"], "unknown")
        r = self.report(self.tkey, eid, "not_found", rid="rec1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.exec_state(eid)["state"], "failed")
        self.assertEqual(self.poll(self.tkey)["reconcile"], [])

    def test_unknown_can_reconcile_to_filled(self):
        eid = self.deliver()
        self.report(self.tkey, eid, "sending")
        self.clock.t += self.cfg.sending_timeout_sec + 1
        self.poll(self.tkey)
        self.assertEqual(self.report(self.tkey, eid, "filled", rid="rec2", ticket="99").status_code, 200)
        self.assertEqual(self.exec_state(eid)["state"], "filled")

    def test_existing_tagged_order_reported_without_send(self):
        eid = self.deliver()
        self.assertEqual(self.report(self.tkey, eid, "filled", reason="found existing order with this tag", ticket="77").status_code, 200)
        self.assertEqual(self.poll(self.tkey)["items"], [])

    def test_ea_side_rejection_is_recorded_with_reason(self):
        eid = self.deliver()
        r = self.report(self.tkey, eid, "rejected", reason="spread 85 pts > max 30")
        self.assertEqual(r.status_code, 200)
        ex = self.c.get("/api/v1/executions", headers=self.H()).json()["executions"][0]
        self.assertEqual((ex["state"], ex["reason"]), ("rejected", "spread 85 pts > max 30"))


class TestConfirmFlow(Base):
    def test_approve_then_deliver(self):
        acc, tkey = self.account(mode="confirm")
        self.heartbeat(tkey)
        ex = self.signal().json()["signal"]["executions"][0]
        self.assertEqual(ex["state"], "awaiting_approval")
        self.assertEqual(self.poll(tkey)["items"], [], "not delivered before approval")
        self.assertEqual(self.c.post(f"/api/v1/executions/{ex['id']}/approve", headers=self.H()).status_code, 200)
        items = self.poll(tkey)["items"]
        self.assertEqual([i["execution_id"] for i in items], [ex["id"]])
        self.assertEqual(items[0]["action"], "execute")
        self.assertEqual(self.c.post(f"/api/v1/executions/{ex['id']}/approve", headers=self.H()).status_code, 409)

    def test_reject(self):
        acc, tkey = self.account(mode="confirm")
        self.heartbeat(tkey)
        ex = self.signal().json()["signal"]["executions"][0]
        r = self.c.post(f"/api/v1/executions/{ex['id']}/reject", json={"reason": "news soon"}, headers=self.H())
        self.assertEqual(r.json()["execution"]["state"], "cancelled")
        self.assertEqual(self.poll(tkey)["items"], [])

    def test_approval_after_expiry_fails(self):
        acc, tkey = self.account(mode="confirm")
        ex = self.signal(valid_for_sec=60).json()["signal"]["executions"][0]
        self.clock.t += 61
        r = self.c.post(f"/api/v1/executions/{ex['id']}/approve", headers=self.H())
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["error"]["state"], "expired")


class TestLiveGate(Base):
    def test_real_account_needs_web_confirmation_and_ea_flag(self):
        acc, tkey = self.account(mode="auto")
        self.heartbeat(tkey, trade_mode="real")
        self.signal(cid="l1")
        eid = self.poll(tkey)["items"][0]["execution_id"]
        r = self.report(tkey, eid, "sending")
        self.assertEqual(r.json()["error"]["code"], "live_not_enabled")
        self.assertEqual(self.exec_state(eid)["state"], "rejected")

        bad = self.c.post(f"/api/v1/accounts/{acc['id']}/live", json={"enable": True, "confirm": "yes"}, headers=self.H())
        self.assertEqual(bad.status_code, 400)
        phrase = bad.json()["error"]["phrase"]
        self.assertEqual(phrase, "ENABLE LIVE 5001234")
        ok = self.c.post(f"/api/v1/accounts/{acc['id']}/live", json={"enable": True, "confirm": phrase}, headers=self.H())
        self.assertTrue(ok.json()["account"]["live_enabled"])

        self.signal(cid="l2")
        eid2 = self.poll(tkey)["items"][0]["execution_id"]
        self.assertEqual(self.report(tkey, eid2, "sending").json()["error"]["code"], "ea_real_not_allowed")

        self.heartbeat(tkey, trade_mode="real", ea_allow_real=True)
        self.signal(cid="l3")
        eid3 = self.poll(tkey)["items"][0]["execution_id"]
        self.assertTrue(self.report(tkey, eid3, "sending").json()["go"])

    def test_live_requires_bound_terminal(self):
        acc, _ = self.account(mode="auto")
        r = self.c.post(f"/api/v1/accounts/{acc['id']}/live", json={"enable": True, "confirm": "ENABLE LIVE None"}, headers=self.H())
        self.assertEqual(r.json()["error"]["code"], "not_bound")

    def test_unknown_trade_mode_refused(self):
        acc, tkey = self.account(mode="auto")
        self.heartbeat(tkey, trade_mode="unknown")
        self.signal()
        eid = self.poll(tkey)["items"][0]["execution_id"]
        self.assertEqual(self.report(tkey, eid, "sending").json()["error"]["code"], "unknown_account_type")

    def test_binding_mismatch_and_reset(self):
        acc, tkey = self.account()
        self.heartbeat(tkey, login="111")
        r = self.heartbeat(tkey, login="222")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["error"]["code"], "binding_mismatch")
        self.c.post(f"/api/v1/accounts/{acc['id']}/reset-binding", headers=self.H())
        self.assertEqual(self.heartbeat(tkey, login="222").status_code, 200)


class TestIsolation(Base):
    def test_users_cannot_touch_each_other(self):
        acc, tkey = self.account(mode="confirm")
        self.heartbeat(tkey)
        sig = self.signal().json()["signal"]
        eid = sig["executions"][0]["id"]
        B = self.H(self.ukey_b)
        self.assertEqual(self.c.get("/api/v1/accounts", headers=B).json()["accounts"], [])
        self.assertEqual(self.c.get(f"/api/v1/accounts/{acc['id']}", headers=B).status_code, 404)
        self.assertEqual(self.c.patch(f"/api/v1/accounts/{acc['id']}", json={"mode": "auto"}, headers=B).status_code, 404)
        self.assertEqual(self.c.post(f"/api/v1/accounts/{acc['id']}/live", json={"enable": True, "confirm": "x"}, headers=B).status_code, 404)
        self.assertEqual(self.c.get(f"/api/v1/signals/{sig['id']}", headers=B).status_code, 404)
        self.assertEqual(self.c.post(f"/api/v1/signals/{sig['id']}/cancel", headers=B).status_code, 404)
        self.assertEqual(self.c.post(f"/api/v1/executions/{eid}/approve", headers=B).status_code, 404)
        self.assertEqual(self.c.get("/api/v1/executions", headers=B).json()["executions"], [])
        self.assertEqual(self.c.get("/api/v1/signals", headers=B).json()["signals"], [])
        r = self.signal(cid="x", key=self.ukey_b, account_ids=[acc["id"]])
        self.assertEqual(r.status_code, 404, "cannot target another user's account")
        # bob's terminal cannot report on alice's execution
        _, tkey_b = self.account(key=self.ukey_b)
        self.assertEqual(self.report(tkey_b, eid, "rejected").status_code, 404)
        # alice's signals do not reach bob's terminal
        self.heartbeat(tkey_b, login="999")
        self.assertEqual(self.poll(tkey_b)["items"], [])


class TestLogging(Base):
    def test_no_secrets_in_logs_or_audit(self):
        buf = io.StringIO()
        h = logging.StreamHandler(buf)
        from app.security import RedactingFilter
        h.addFilter(RedactingFilter())
        root = logging.getLogger()
        root.addHandler(h)
        old = root.level
        root.setLevel(logging.INFO)
        try:
            acc, tkey = self.account()
            self.heartbeat(tkey)
            self.c.get("/api/v1/me", headers=self.H())
            logging.getLogger("x").info("leak attempt %s and Bearer %s", tkey, self.ukey)
        finally:
            root.removeHandler(h)
            root.setLevel(old)
        out = buf.getvalue()
        self.assertIn("/api/v1/me", out)
        self.assertNotIn(tkey, out)
        self.assertNotIn(self.ukey, out)
        audit = json.dumps([dict(r) for r in self.svc.conn.execute("SELECT * FROM audit_log")])
        self.assertNotIn(tkey, audit)
        self.assertNotIn(self.ukey, audit)

    def test_redact(self):
        self.assertEqual(redact("key fa_t_abcdefghijk123 end"), "key fa_*** end")
        self.assertNotIn("secret", redact("Authorization: Bearer secret"))


class TestMigrations(unittest.TestCase):
    def test_idempotent_and_non_destructive(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "m.db")
            conn = connect(path)
            self.assertEqual(migrate(conn), ["0001_init", "0002_position_close"])
            conn.execute("INSERT INTO users(name, created_at) VALUES ('keep-me', 1)")
            self.assertEqual(migrate(conn), [])
            conn.close()
            conn = connect(path)
            self.assertEqual(migrate(conn), [])
            self.assertEqual(conn.execute("SELECT name FROM users").fetchone()[0], "keep-me")
            vers = [r[0] for r in conn.execute("SELECT version FROM schema_migrations")]
            self.assertEqual(vers, ["0001_init", "0002_position_close"])
            conn.close()

    def test_failed_migration_rolls_back(self):
        from app import db as dbmod
        with tempfile.TemporaryDirectory() as d:
            mig = os.path.join(d, "mig")
            os.mkdir(mig)
            with open(os.path.join(mig, "0001_a.sql"), "w") as f:
                f.write("CREATE TABLE a (x INTEGER);\nCREATE TABLE a (x INTEGER);\n")  # second statement fails
            with mock.patch.object(dbmod, "MIGRATIONS_DIR", __import__("pathlib").Path(mig)):
                conn = connect(os.path.join(d, "f.db"))
                with self.assertRaises(sqlite3.OperationalError):
                    migrate(conn)
                tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                self.assertNotIn("a", tables)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0], 0)
                conn.close()


if __name__ == "__main__":
    unittest.main()
