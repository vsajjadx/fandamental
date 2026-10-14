// Run: node tests/ai.test.js   (offline — fetch is mocked, no network, no real key)
require("../js/ai.js");
const FA = globalThis.FA;
let fails = 0;
const check = (n, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + n + (extra ? "  " + extra : "")); if (!c) fails++; };

const MARKETS = [{ id: "BTCUSDT", name: "BTC", price: 100, direction: "long", confluence: 60, tech: 0.3, pa: 0.2, fund: null, alert: "" }];
const GOOD_RANK = { ranked: [{ symbol: "BTCUSDT", name: "BTC", rank: 1, side: "long", score: 0.4, confidence: 60, entry_quality: "good", risk_level: "medium", potential: "ok", risk_note: "ok" }], summary: "s" };
const ok = (j) => ({ ok: true, status: 200, json: async () => j });
const isGdelt = (u) => /gdelt/i.test(u);
const isInteractions = (u) => /\/interactions$/.test(u);
const genModel = (u) => decodeURIComponent(u.match(/models\/([^:]+):/)[1]);
const CHAT_HISTORY = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }];

async function main() {
// 1) retired model ids are gone; the documented replacements are wired in
{
  const g = FA.ai.PROVIDERS.gemini, o = FA.ai.PROVIDERS.openrouter;
  check("no shut-down Gemini id (2.0/2.5) is used", !/2\.0|2\.5/.test(g.model + " " + g.fallback), g.model + " / " + g.fallback);
  check("primary Gemini model = gemini-3.8-flash (documented stable)", g.model === "gemini-3.8-flash", g.model);
  check("Gemini fallback = gemini-3.6-flash (documented replacement for 2.0/2.5 flash)", g.fallback === "gemini-3.6-flash", g.fallback);
  check("OpenRouter ids are live :free models", /:free$/.test(o.model) && /:free$/.test(o.fallback), o.model + " / " + o.fallback);
}

// 2) a single-turn analysis goes to the Interactions API with the key in a header
{
  let seen = null;
  globalThis.fetch = async (url, opts) => {
    if (isGdelt(url)) return ok({ articles: [] });
    seen = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    return ok({ output_text: JSON.stringify(GOOD_RANK) });
  };
  const out = await FA.ai.screener({ provider: "gemini", gemini: "K" }, { markets: MARKETS }, () => {});
  check("uses the Interactions endpoint", isInteractions(seen.url), seen.url);
  check("key sent as x-goog-api-key header (not in the URL)", seen.headers["x-goog-api-key"] === "K" && !/key=/.test(seen.url));
  check("model = gemini-3.8-flash", seen.body.model === "gemini-3.8-flash", seen.body.model);
  check("generation_config carries max_output_tokens + thinking_level=minimal",
    seen.body.generation_config && seen.body.generation_config.max_output_tokens >= 4096 && seen.body.generation_config.thinking_level === "minimal",
    JSON.stringify(seen.body.generation_config));
  check("no legacy thinkingBudget sent to a Gemini 3.x model", !JSON.stringify(seen.body).includes("thinkingBudget"));
  check("screener reads the reply from output_text", !!(out && out.ranked && out.ranked.length === 1), out && out.sourceNote);
}

// 3) if Interactions is unavailable the still-supported generateContent is used
{
  const urls = [], models = [];
  globalThis.fetch = async (url) => {
    if (isGdelt(url)) return ok({ articles: [] });
    urls.push(url);
    if (isInteractions(url)) return { ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) };
    models.push(genModel(url));
    return ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD_RANK) }] } }] });
  };
  const out = await FA.ai.screener({ provider: "gemini", gemini: "K" }, { markets: MARKETS }, () => {});
  check("falls back to generateContent", urls.some((u) => /:generateContent/.test(u)) && !!(out && out.ranked), models.join(","));
  check("fallback keeps the new model id", models[0] === "gemini-3.8-flash", models[0]);
}

// 4) a model id saved by an older version (now shut down) is ignored
{
  const used = [];
  globalThis.fetch = async (url, opts) => {
    if (isGdelt(url)) return ok({ articles: [] });
    if (isInteractions(url)) { used.push(JSON.parse(opts.body).model); return ok({ output_text: JSON.stringify(GOOD_RANK) }); }
    used.push(genModel(url));
    return ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD_RANK) }] } }] });
  };
  await FA.ai.screener({ provider: "gemini", gemini: "K", models: { gemini: "gemini-2.0-flash" } }, { markets: MARKETS }, () => {});
  check("saved shut-down id replaced by gemini-3.8-flash", used.length > 0 && used.every((m) => m === "gemini-3.8-flash"), used.join(","));
}

// 5) multi-turn chat stays on generateContent and returns its text
{
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(url); return ok({ candidates: [{ content: { parts: [{ text: "mentor" }] } }] }); };
  const t = await FA.ai.chat({ provider: "gemini", gemini: "K" }, CHAT_HISTORY, "sys", () => {});
  check("multi-turn chat uses generateContent only", urls.length === 1 && /:generateContent/.test(urls[0]), urls[0]);
  check("chat returns the model text", t === "mentor", t);
}

// 6) an empty answer is retryable and the backup model is tried (uses chat: no GDELT, no Interactions)
{
  const models = [], bodies = [];
  globalThis.fetch = async (url, opts) => {
    models.push(genModel(url));
    bodies.push(JSON.parse(opts.body));
    return ok({ candidates: [{ content: { parts: [] } }] });
  };
  FA.ai.chat({ provider: "gemini", gemini: "K" }, CHAT_HISTORY, "sys", () => {}).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  check("empty answer retried on the backup model (not fatal)", models[0] === "gemini-3.8-flash" && models.includes("gemini-3.6-flash"), models.join(","));
  check("no thinkingBudget reaches a 3.x generateContent call",
    bodies.length > 0 && !JSON.stringify(bodies).includes("thinkingBudget"),
    JSON.stringify(bodies[0] && bodies[0].generationConfig));
}

console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED");
process.exit(fails ? 1 : 0);

}
main();
