// Run: node tests/ai.test.js   (offline — fetch is mocked, no network, no real key)
require("../js/ai.js");
const FA = globalThis.FA;
let fails = 0;
const check = (n, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + n + (extra ? "  " + extra : "")); if (!c) fails++; };

const MARKETS = [{ id: "BTCUSDT", name: "BTC", price: 100, direction: "long", confluence: 60, tech: 0.3, pa: 0.2, fund: null, alert: "" }];
const GOOD_RANK = { ranked: [{ symbol: "BTCUSDT", name: "BTC", rank: 1, side: "long", score: 0.4, confidence: 60, entry_quality: "good", risk_level: "medium", potential: "ok", risk_note: "ok" }], summary: "s" };

async function main() {
// 1) regression: Gemini 2.5 thinking-only answers («پاسخ خالی») must be retried, not fatal
{
  let bodies = [], calls = 0, switched = false;
  globalThis.fetch = async (url, opts) => {
    calls++; const model = decodeURIComponent(url.match(/models\/([^:]+):/)[1]); if (model !== "gemini-2.5-flash") switched = true;
    bodies.push({ model, gc: JSON.parse(opts.body).generationConfig });
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [] } }] }) };
  };
  let threw = false;
  try { FA.ai.screener({ provider: "gemini", gemini: "K" }, { markets: MARKETS }, () => {}).catch((e) => { threw = true; }); } catch (e) { threw = true; }
  await new Promise((r) => setTimeout(r, 100));
  check("empty Gemini answer is retryable (not thrown immediately)", !threw || calls > 2, "calls=" + calls);
  check("thinkingConfig.thinkingBudget=0 sent for flash models", bodies.some((b) => b.gc && b.gc.thinkingConfig && b.gc.thinkingConfig.thinkingBudget === 0), JSON.stringify(bodies[0] && bodies[0].gc));
  check("fallback model tried on empty answer", switched, "models: " + [...new Set(bodies.map((b) => b.model))].join(","));
}

// 2) happy path: valid JSON comes back and screener normalizes it
{
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD_RANK) }] } }] }) });
  const out = await FA.ai.screener({ provider: "gemini", gemini: "K" }, { markets: MARKETS }, () => {});
  check("screener returns ranked list", !!(out && out.ranked && out.ranked.length === 1));
  check("screener builds a sourceNote", typeof out.sourceNote === "string" && out.sourceNote.length > 0, out.sourceNote);
}

console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED");
process.exit(fails ? 1 : 0);

}
main();
