// Run: node tests/mt5_direct.test.js
// Direct (no server) mode, end to end on a real folder:
//   web-app code (FA.mt5.direct) → files on disk ← tests/ea_direct_sim.py (same protocol as the MQL5 EA)
const fs = require("fs"), path = require("path"), os = require("os"), { execFileSync } = require("child_process");
require("../js/indicators.js"); require("../js/priceaction.js"); require("../js/signal.js"); require("../js/mt5.js");
const M = globalThis.FA.mt5, D = M.direct;
let fails = 0;
const check = (name, cond, extra = "") => { console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); if (!cond) fails++; };

/* A disk-backed implementation of the browser's FileSystemDirectoryHandle API (the subset the app uses). */
function dirHandle(p) {
  return {
    kind: "directory", name: path.basename(p),
    async getDirectoryHandle(n, o = {}) { const q = path.join(p, n); if (!fs.existsSync(q)) { if (!o.create) throw Object.assign(new Error("nf"), { name: "NotFoundError" }); fs.mkdirSync(q); } return dirHandle(q); },
    async getFileHandle(n, o = {}) { const q = path.join(p, n); if (!fs.existsSync(q)) { if (!o.create) throw Object.assign(new Error("nf"), { name: "NotFoundError" }); fs.writeFileSync(q, ""); } return fileHandle(q); },
    async removeEntry(n) { fs.unlinkSync(path.join(p, n)); },
    async *entries() { for (const n of fs.readdirSync(p)) { const q = path.join(p, n); yield [n, fs.statSync(q).isDirectory() ? dirHandle(q) : fileHandle(q)]; } },
  };
}
function fileHandle(q) {
  return {
    kind: "file", name: path.basename(q),
    async getFile() { return { text: async () => fs.readFileSync(q, "utf8") }; },
    async createWritable() { let buf = ""; return { write: async (s) => { buf += s; }, close: async () => { fs.writeFileSync(q + ".crswap", buf); fs.renameSync(q + ".crswap", q); } }; },
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fa-common-files-"));
const ea = (...args) => execFileSync("python3", [path.join(__dirname, "ea_direct_sim.py"), root, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString();
const nowS = () => Math.floor(Date.now() / 1000);
let n = 0;
function payload(over = {}) {
  n++;
  return { client_signal_id: "XAUUSD:1h:" + (1790000000 + n * 3600) + ":long:entry:" + n, symbol: "XAUUSD", direction: "buy", order_type: "market",
    entry: 2400, sl: 2390, tp: 2420, timeframe: "1h", generated_at: nowS() - 2, valid_for_sec: 3600, confluence: 75, signal_type: "entry", note: "", ...over };
}
const local = (over = {}) => ({ enabled: true, mode: "auto", live_enabled: false, live_login: "", settings: { ...D.DEFAULT_SETTINGS }, ...over });

(async () => {
  // pure helpers
  const id = D.eidFor("abc");
  check("eid is 16 hex chars and deterministic", /^[0-9a-f]{16}$/.test(id) && id === D.eidFor("abc") && id !== D.eidFor("abd"));
  const doc = D.inboxDoc(payload(), "execute", nowS());
  check("inbox doc carries id, tag, expiry and the unchanged signal", doc.tag === "FA:" + doc.execution_id && doc.expires_at === doc.signal.generated_at + 3600 && doc.signal.entry === 2400 && !("valid_for_sec" in doc.signal));
  check("tag fits MT5's 31-char comment limit", doc.tag.length <= 31);
  const cfg = D.configDoc(local({ live_enabled: false, live_login: "999" }), 1);
  check("config doc never carries a live login when live is off", cfg.live_login === "" && cfg.live_enabled === false);
  check("settings are clamped to safe ranges", D.cleanSettings({ risk_percent: 50, max_lot: -1 }).risk_percent === 0.5 && D.cleanSettings({ max_lot: -1 }).max_lot === 0.1);
  check("status: fresh = connected, old = disconnected", D.statusView({ time: nowS() - 2, poll_seconds: 3 }, nowS()).connected && !D.statusView({ time: nowS() - 60, poll_seconds: 3 }, nowS()).connected);

  const dirs = await D.bridgeDirs(dirHandle(root));
  const list = [];
  async function sendSignal(over, action = "execute") {
    const p = payload(over), d = D.inboxDoc(p, action, nowS());
    await D.writeJson(dirs.inbox, d.execution_id + ".json", d);
    const e = { id: d.execution_id, state: "queued", payload: p };
    list.push(e);
    return e;
  }
  async function sync() { return D.applyOutbox(list, await D.listJson(dirs.outbox)); }
  const broker = () => JSON.parse(fs.readFileSync(path.join(root, "FandamentalBridge", "broker.json"), "utf8")).orders;

  // 0) EA running before the web app wrote any settings → does nothing, but reports status
  const early = await sendSignal();
  ea();
  const st = await D.readJson(dirs.bridge, "status.json");
  check("EA heartbeat visible to the web app", D.statusView(st, nowS()).connected && st.login === "5001" && st.trade_mode === "demo");
  check("without config.json the EA touches nothing", fs.existsSync(path.join(root, "FandamentalBridge", "inbox", early.id + ".json")));

  // 1) auto mode on demo → filled once
  await D.writeJson(dirs.bridge, "config.json", D.configDoc(local(), nowS()));
  ea();
  await sync();
  check("auto mode, demo: executed and reported 'filled'", early.state === "filled" && early.ticket === "1001", early.state);
  check("inbox file removed after handling", !fs.existsSync(path.join(root, "FandamentalBridge", "inbox", early.id + ".json")));

  // 2) the same signal again (same id) → no second order
  const again = D.inboxDoc(early.payload, "execute", nowS());
  await D.writeJson(dirs.inbox, again.execution_id + ".json", again);
  ea();
  check("re-sent signal is not executed twice", broker().length === 1);

  // 3) display-only
  await D.writeJson(dirs.bridge, "config.json", D.configDoc(local({ mode: "notify" }), nowS()));
  const shown = await sendSignal({}, "notify");
  ea(); await sync();
  check("display-only: 'displayed', no order", shown.state === "displayed" && broker().length === 1);

  // 4) queued as execute, then the user switches to display-only before MT5 picks it up → not executed
  await D.writeJson(dirs.bridge, "config.json", D.configDoc(local({ mode: "auto" }), nowS()));
  const switched = await sendSignal();
  await D.writeJson(dirs.bridge, "config.json", D.configDoc(local({ mode: "notify" }), nowS()));
  ea(); await sync();
  check("mode switched to display-only: shown, not executed", switched.state === "displayed" && broker().length === 1, switched.state);

  // 5) expired
  await D.writeJson(dirs.bridge, "config.json", D.configDoc(local(), nowS()));
  const old = await sendSignal({ generated_at: nowS() - 4000, valid_for_sec: 3600 });
  ea(); await sync();
  check("expired signal not executed", old.state === "expired" && broker().length === 1);

  // 6) connection disabled → inbox left alone
  await D.writeJson(dirs.bridge, "config.json", D.configDoc(local({ enabled: false }), nowS()));
  const off = await sendSignal();
  ea();
  check("disabled connection: nothing executed", broker().length === 1 && fs.existsSync(path.join(root, "FandamentalBridge", "inbox", off.id + ".json")));
  await dirs.inbox.removeEntry(off.id + ".json"); list.pop();

  // 7) real account gates
  await D.writeJson(dirs.bridge, "config.json", D.configDoc(local(), nowS()));
  const r1 = await sendSignal();
  ea("--login", "7777", "--trade-mode", "real", "--allow-real"); await sync();
  check("real account, live not enabled in web app: rejected", r1.state === "rejected" && /live trading is not enabled/.test(r1.reason) && broker().length === 1, r1.reason);
  await D.writeJson(dirs.bridge, "config.json", D.configDoc(local({ live_enabled: true, live_login: "1234" }), nowS()));
  const r2 = await sendSignal();
  ea("--login", "7777", "--trade-mode", "real", "--allow-real"); await sync();
  check("real account, live enabled for ANOTHER login: rejected", r2.state === "rejected" && /another account/.test(r2.reason), r2.reason);
  await D.writeJson(dirs.bridge, "config.json", D.configDoc(local({ live_enabled: true, live_login: "7777" }), nowS()));
  const r3 = await sendSignal();
  ea("--login", "7777", "--trade-mode", "real"); await sync();
  check("real account, EA AllowRealAccount=false: rejected", r3.state === "rejected" && /AllowRealAccount/.test(r3.reason), r3.reason);
  const r4 = await sendSignal();
  ea("--login", "7777", "--trade-mode", "real", "--allow-real"); await sync();
  check("real account with BOTH switches on: executed", r4.state === "filled" && broker().length === 2, r4.state);

  // 8) terminal crashes right after OrderSend (no result written) → restart reconciles by tag, no duplicate
  const c1 = await sendSignal();
  try { ea("--crash-after-send"); } catch (e) { /* the simulated crash exits non-zero */ }
  await sync();
  check("crash after send: order exists but no result yet", broker().length === 3 && c1.state === "queued");
  ea(); await sync();
  check("after restart: reconciled to 'filled', still exactly one order", c1.state === "filled" && broker().length === 3, c1.state + " / " + c1.reason);

  // 9) position closes → final P/L reported
  ea("--close-all"); await sync();
  check("closed position reported with profit and reason", !!early.close && early.close.profit === 12.5 && early.close.close_reason === "tp");

  // 10) malformed / foreign files in inbox are ignored safely
  fs.writeFileSync(path.join(root, "FandamentalBridge", "inbox", "not-an-id.json"), "{oops");
  ea();
  check("malformed inbox file removed, nothing executed", !fs.existsSync(path.join(root, "FandamentalBridge", "inbox", "not-an-id.json")) && broker().length === 3);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
