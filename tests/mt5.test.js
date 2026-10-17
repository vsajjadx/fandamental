// Run: node tests/mt5.test.js
// Optional live check against a running bridge server (validates that the web app's payload matches the server schema):
//   FA_BRIDGE_URL=http://127.0.0.1:8787 FA_BRIDGE_KEY=fa_u_... node tests/mt5.test.js
require("../js/indicators.js"); require("../js/priceaction.js"); require("../js/signal.js"); require("../js/mt5.js");
const FA = globalThis.FA, M = FA.mt5;
let fails = 0;
const check = (name, cond, extra = "") => { console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); if (!cond) fails++; };

let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
function gen(n, drift) {
  const out = []; let p = 2400, t = Math.floor(Date.now() / 1000) - n * 3600;
  for (let i = 0; i < n; i++) {
    const o = p, c = o + drift + Math.sin(i / 17) * 3 + (rnd() - 0.5) * 6;
    out.push({ t: t + i * 3600, o, h: Math.max(o, c) + rnd() * 3, l: Math.min(o, c) - rnd() * 3, c, v: 100 + rnd() * 50 }); p = c;
  }
  return out;
}
const sym = { id: "XAUUSD", name: "Gold" }, tf = { id: "1h" };

// find a real analysis with a plan (both directions if possible)
let withPlan = null;
for (const d of [0.9, -0.9, 0.5, -0.5]) {
  const r = FA.signal.analyze(gen(600, d), { early: true });
  if (r.plan && r.direction !== "none") { withPlan = r; break; }
}
check("engine produced a signal with a trade plan on synthetic data", !!withPlan);

const at = Date.now();
const b = M.buildPayload(withPlan, sym, tf, at);
check("payload built from a real analyze() result", !!b.payload, b.error || "");
const p = b.payload || {};
const buy = p.direction === "buy";
check("direction mapped to buy/sell", p.direction === (withPlan.direction === "long" ? "buy" : "sell"));
check("levels copied unchanged from the plan", p.entry === withPlan.plan.entry && p.sl === withPlan.plan.sl && p.tp === withPlan.plan.tps[0]);
check("levels consistent with direction", buy ? p.sl < p.entry && p.entry < p.tp : p.sl > p.entry && p.entry > p.tp);
check("order type follows plan.isLimit", p.order_type === (withPlan.plan.isLimit ? "limit" : "market"));
check("generated_at = analysis time (seconds)", p.generated_at === Math.floor(at / 1000));
check("validity window from timeframe (1h → 3600s)", p.valid_for_sec === 3600);
check("timeframe id passed through", p.timeframe === "1h");
check("confluence is an int 0..100", Number.isInteger(p.confluence) && p.confluence >= 0 && p.confluence <= 100);
const id1 = M.clientSignalId(sym, tf, withPlan), id2 = M.clientSignalId(sym, tf, withPlan);
check("client id deterministic (re-send = no-op on server)", id1 === id2 && p.client_signal_id === id1);
check("client id charset/length valid for the server", /^[A-Za-z0-9_.:\-]{1,100}$/.test(id1), id1);
check("client id changes with the candle", M.clientSignalId(sym, tf, { ...withPlan, lastTime: withPlan.lastTime + 3600 }) !== id1);

check("no plan → refused", !!M.buildPayload({ direction: "none", plan: null }, sym, tf).error);
check("Tehran stock → refused", !!M.buildPayload(withPlan, { id: "TSE-فولاد", tse: "1" }, tf).error);
const bad = JSON.parse(JSON.stringify(withPlan)); bad.plan.sl = bad.plan.tps[0];
check("inverted SL/TP → refused", !!M.buildPayload(bad, sym, tf).error);
const nan = JSON.parse(JSON.stringify(withPlan)); nan.plan.entry = NaN;
check("NaN level → refused", !!M.buildPayload(nan, sym, tf).error);

check("https URL accepted", M.normalizeBase("https://a.example.com/").base === "https://a.example.com");
check("plain http public URL refused", !!M.normalizeBase("http://a.example.com").error);
check("http://127.0.0.1 allowed for local testing", !!M.normalizeBase("http://127.0.0.1:8787").base);

(async () => {
  // client with stubbed fetch
  let seen = null;
  const okFetch = async (url, opt) => { seen = { url, opt }; return { ok: true, status: 200, json: async () => ({ ok: 1 }) }; };
  await M.makeClient("https://x.test", "fa_u_KEY", okFetch)("POST", "/api/v1/signals", { a: 1 });
  check("client sends Bearer key + JSON body", seen.opt.headers.Authorization === "Bearer fa_u_KEY" && seen.opt.body === '{"a":1}' && seen.url === "https://x.test/api/v1/signals");
  const errFetch = async () => ({ ok: false, status: 422, json: async () => ({ error: { code: "stale_signal", message: "too old" } }) });
  try { await M.makeClient("https://x.test", "k", errFetch)("GET", "/x"); check("server error surfaces", false); }
  catch (e) { check("server error surfaces code + message", e.code === "stale_signal" && e.message === "too old" && e.status === 422); }
  const netFetch = async () => { throw new TypeError("Failed to fetch"); };
  try { await M.makeClient("https://x.test", "k", netFetch)("GET", "/x"); check("network error", false); }
  catch (e) { check("network error flagged", e.network === true); }

  // live round-trip against the real server
  const url = process.env.FA_BRIDGE_URL, key = process.env.FA_BRIDGE_KEY;
  if (url && key) {
    const api = M.makeClient(url, key);
    const acc = await api("POST", "/api/v1/accounts", { name: "js-live-test", mode: "notify" });
    check("live: account created from JS", !!acc.terminal_key);
    const r1 = await api("POST", "/api/v1/signals", p);
    check("live: server accepts the web app's real payload", r1.created === true && r1.signal.symbol === "XAUUSD", JSON.stringify(r1.signal && r1.signal.validity));
    check("live: execution created for the connection", (r1.signal.executions || []).some((e) => e.account_id === acc.account.id && e.state === "pending"));
    const r2 = await api("POST", "/api/v1/signals", p);
    check("live: re-send is idempotent", r2.created === false && r2.signal.id === r1.signal.id);
    try { await api("POST", "/api/v1/signals", { ...p, client_signal_id: p.client_signal_id + "x", generated_at: p.generated_at - 100000 }); check("live: stale refused", false); }
    catch (e) { check("live: stale signal refused with reason", e.code === "stale_signal"); }
  } else console.log("SKIP live server checks (set FA_BRIDGE_URL and FA_BRIDGE_KEY)");

  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
})();
