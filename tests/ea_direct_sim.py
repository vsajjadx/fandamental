"""Simulator of FandamentalBridge.mq5 in DIRECT mode (shared folder, no server).

It follows the same file protocol and the same ordering as the MQL5 code (PollFiles / LocalGo /
ReconcileLocal / WatchLocal) so the web app side can be tested against real files:
  FandamentalBridge/config.json   read     (web app settings)
  FandamentalBridge/status.json   written  (heartbeat)
  FandamentalBridge/inbox/*.json  read + deleted
  FandamentalBridge/outbox/<id>.json, <id>.close.json   written atomically (tmp + rename)
  FandamentalBridge/ea_processed.txt, ea_sending.txt, ea_positions.txt   EA-private state
A fake broker (broker.json in the same folder) records orders by their comment tag.

Usage:  python3 tests/ea_direct_sim.py <Common\\Files folder> [--cycles N] [--login 5001] [--trade-mode demo|real]
                 [--allow-real] [--crash-after-send] [--close-all] [--restart]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time

HEX = re.compile(r"^[0-9a-f]{16}$")


class DiskFS:
    def __init__(self, root):
        self.root = root

    def _p(self, rel):
        return os.path.join(self.root, *rel.split("/"))

    def read(self, rel):
        try:
            with open(self._p(rel), encoding="utf-8") as f:
                return f.read()
        except FileNotFoundError:
            return None

    def write_atomic(self, rel, text):
        p = self._p(rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p + ".tmp", "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(p + ".tmp", p)

    def list(self, rel):
        try:
            return sorted(os.listdir(self._p(rel)))
        except FileNotFoundError:
            return []

    def delete(self, rel):
        try:
            os.remove(self._p(rel))
        except FileNotFoundError:
            pass

    def exists(self, rel):
        return os.path.exists(self._p(rel))

    def mkdirs(self, rel):
        os.makedirs(self._p(rel), exist_ok=True)


class SimEA:
    def __init__(self, fs, login="5001", trade_mode="demo", allow_real=False, execution_enabled=True):
        self.fs, self.login, self.trade_mode, self.allow_real, self.execution_enabled = fs, login, trade_mode, allow_real, execution_enabled
        self.crash_after_send = False
        self.cfg, self.have_cfg = {}, False
        B = "FandamentalBridge"
        self.B = B
        for d in (B, B + "/inbox", B + "/outbox"):
            fs.mkdirs(d)
        self.proc = self._lines("ea_processed.txt")
        self.positions = [l.split("\t") for l in self._lines("ea_positions.txt", raw=True) if "\t" in l]
        self.sending = self._lines("ea_sending.txt")
        self.reconcile()   # == OnInit

    # ---- broker
    def broker(self):
        t = self.fs.read(self.B + "/broker.json")
        return json.loads(t) if t else {"orders": [], "next": 1000}

    def save_broker(self, b):
        self.fs.write_atomic(self.B + "/broker.json", json.dumps(b))

    def find_tag(self, tag):
        return next((o for o in self.broker()["orders"] if o["comment"] == tag), None)

    # ---- EA-private files
    def _lines(self, name, raw=False):
        t = self.fs.read(f"{self.B}/{name}") or ""
        ls = [l.strip() for l in t.split("\n") if l.strip()]
        return ls if raw else [l for l in ls if HEX.match(l)]

    def _save(self, name, lines):
        self.fs.write_atomic(f"{self.B}/{name}", "".join(l + "\n" for l in lines))

    def write_outbox(self, eid, report, close=False):
        doc = {"id": eid, "time": int(time.time()), "kind": "close" if close else "result", "login": self.login, "report": report}
        self.fs.write_atomic(f"{self.B}/outbox/{eid}{'.close' if close else ''}.json", json.dumps(doc))
        if not close and report["state"] != "unknown" and eid in self.sending:
            self.sending.remove(eid)
            self._save("ea_sending.txt", self.sending)

    def mark_processed(self, eid):
        if eid not in self.proc:
            self.proc.append(eid)
            self._save("ea_processed.txt", self.proc)

    def read_config(self):
        t = self.fs.read(self.B + "/config.json")
        if t is None:
            self.cfg, self.have_cfg = {}, False
            return
        self.cfg, self.have_cfg = json.loads(t), True

    def local_go(self, eid, expires_in):
        self.read_config()
        c = self.cfg
        if not self.have_cfg: return "web app settings (config.json) not found"
        if not c.get("enabled"): return "connection disabled in the web app"
        if c.get("mode") == "notify": return "web app switched to display-only mode"
        if expires_in <= 0: return "signal expired"
        if self.trade_mode != "demo":
            if not c.get("live_enabled"): return "real account: live trading is not enabled in the web app"
            if c.get("live_login") != self.login: return "real account: live trading was enabled for another account"
            if not self.allow_real: return "real account and AllowRealAccount=false"
        if eid in self.proc: return "duplicate"
        self.mark_processed(eid)
        self.sending.append(eid)
        self._save("ea_sending.txt", self.sending)
        return ""

    def execute(self, eid, sig, expires_in):
        if not self.execution_enabled:
            return self.write_outbox(eid, {"state": "rejected", "reason": "order execution disabled in EA inputs"})
        if self.find_tag("FA:" + eid):
            return self.write_outbox(eid, {"state": "filled", "reason": "found existing order with this tag; not sent again"})
        gw = self.local_go(eid, expires_in)
        if gw == "duplicate":
            return
        if gw:
            return self.write_outbox(eid, {"state": "rejected", "reason": gw})
        b = self.broker()
        b["next"] += 1
        tk = str(b["next"])
        b["orders"].append({"ticket": tk, "comment": "FA:" + eid, "symbol": sig["symbol"], "side": sig["direction"], "open": True,
                            "price": sig["entry"], "sl": sig["sl"], "tp": sig["tp"]})
        self.save_broker(b)
        if self.crash_after_send:
            raise SystemExit("simulated crash right after OrderSend")
        self.write_outbox(eid, {"state": "filled", "fill_price": sig["entry"], "volume": 0.01, "ticket": tk, "retcode": 10009, "broker_symbol": sig["symbol"]})
        self.positions.append([eid, tk])
        self._save("ea_positions.txt", ["\t".join(p) for p in self.positions])

    def reconcile(self):
        for eid in list(self.sending):
            o = self.find_tag("FA:" + eid)
            st = "filled" if o else "failed"
            self.write_outbox(eid, {"state": st, "reason": "found at broker during reconciliation" if o else
                                    "no order with this tag at the broker (send did not go through); not re-sent", "ticket": o["ticket"] if o else None})
            if o:
                self.positions.append([eid, o["ticket"]])
                self._save("ea_positions.txt", ["\t".join(p) for p in self.positions])

    def write_status(self):
        self.fs.write_atomic(self.B + "/status.json", json.dumps({
            "time": int(time.time()), "link": "files", "login": self.login, "server": "Sim-Demo", "company": "Sim Broker", "trade_mode": self.trade_mode,
            "currency": "USD", "balance": 10000, "equity": 10000, "connected_to_broker": True, "trade_allowed": True,
            "execution_enabled": self.execution_enabled, "ea_allow_real": self.allow_real, "ea_version": "1.10", "poll_seconds": 3}))

    def watch(self):
        b = self.broker()
        keep = []
        for eid, tk in self.positions:
            o = next((x for x in b["orders"] if x["ticket"] == tk), None)
            if o and not o["open"]:
                self.write_outbox(eid, {"close_price": o.get("close_price"), "profit": o.get("profit"), "close_reason": o.get("close_reason", "tp")}, close=True)
            else:
                keep.append([eid, tk])
        if keep != self.positions:
            self.positions = keep
            self._save("ea_positions.txt", ["\t".join(p) for p in self.positions])

    def poll(self):   # == PollFiles()
        self.read_config()
        self.write_status()
        if not self.have_cfg or not self.cfg.get("enabled"):
            self.watch()
            return
        names = [n for n in self.fs.list(self.B + "/inbox") if n.endswith(".json")][:20]
        for n in names:
            path = f"{self.B}/inbox/{n}"
            t = self.fs.read(path)
            if t is None:
                continue
            try:
                it = json.loads(t)
            except ValueError:
                it = None
            eid = (it or {}).get("execution_id", "")
            if not it or not HEX.match(eid) or n != eid + ".json":
                self.fs.delete(path)
                continue
            if eid in self.proc:
                self.fs.delete(path)
                continue
            sig, expires_in = it.get("signal"), it.get("expires_at", 0) - time.time()
            if not sig:
                self.write_outbox(eid, {"state": "rejected", "reason": "signal data missing"})
            elif expires_in <= 0:
                self.write_outbox(eid, {"state": "expired", "reason": "signal expired before MT5 picked it up"})
            elif it.get("action") == "notify" or self.cfg.get("mode") == "notify":
                self.write_outbox(eid, {"state": "displayed", "reason": "", "broker_symbol": sig["symbol"]})
            else:
                self.execute(eid, sig, expires_in)
            self.mark_processed(eid)
            self.fs.delete(path)
        self.watch()


def close_all(fs, profit=12.5):
    t = fs.read("FandamentalBridge/broker.json")
    if not t:
        return
    b = json.loads(t)
    for o in b["orders"]:
        if o["open"]:
            o.update(open=False, close_price=o["tp"], profit=profit, close_reason="tp")
    fs.write_atomic("FandamentalBridge/broker.json", json.dumps(b))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--cycles", type=int, default=1)
    ap.add_argument("--login", default="5001")
    ap.add_argument("--trade-mode", default="demo")
    ap.add_argument("--allow-real", action="store_true")
    ap.add_argument("--crash-after-send", action="store_true")
    ap.add_argument("--close-all", action="store_true")
    ap.add_argument("--no-exec", action="store_true")
    a = ap.parse_args()
    fs = DiskFS(a.folder)
    if a.close_all:
        close_all(fs)
    ea = SimEA(fs, a.login, a.trade_mode, a.allow_real, not a.no_exec)
    ea.crash_after_send = a.crash_after_send
    for i in range(a.cycles):
        ea.poll()
        if i < a.cycles - 1:
            time.sleep(0.2)
