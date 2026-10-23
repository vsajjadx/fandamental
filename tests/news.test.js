// Run: node tests/news.test.js — news layer: real Bing RSS samples, parallel sources with a hard time budget,
// merge/dedupe, Persian news for Tehran stocks, web-search model detection.
require("../js/indicators.js"); require("../js/priceaction.js"); require("../js/signal.js"); require("../js/data.js"); require("../js/news.js"); require("../js/ai.js");
const fs = require("fs"), path = require("path"), FA = globalThis.FA, N = FA.news;
let fails = 0;
const check = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); if (!c) fails++; };
const fx = (f) => fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8");
const en = fx("bing_news_en.xml"), fa = fx("bing_news_fa.xml");

const all = N.parseRss(fa, 0), recent = N.parseRss(fa, 7);
check("Bing RSS (English) parsed: title, source, date, link", N.parseRss(en, 0).length >= 5 && N.parseRss(en, 0).every((h) => h.title && h.src && h.ts > 0 && h.url));
check("Bing RSS (Persian) parsed with Persian titles", all.length >= 5 && all.some((h) => /[؀-ۿ]/.test(h.title)));
check("old articles (Bing mixes in years-old items) are dropped by the 7-day filter", recent.length < all.length && recent.every((h) => Date.now() / 1000 - h.ts <= 7 * 86400 + 60), `${all.length} → ${recent.length}`);
const tse = { id: "TSE-فولاد", name: "فولاد مبارکه", group: "بورس تهران", tse: "1" };
check("Tehran stocks are searched in Persian (fa) with the company name", N.bingQuery(tse).lang === "fa" && /فولاد مبارکه/.test(N.bingQuery(tse).q));
check("FX / gold / crypto searched in English", N.bingQuery({ id: "EURUSD", name: "EUR/USD", group: "فارکس", fx: ["EUR", "USD"] }).lang === "en" && /gold/.test(N.bingQuery({ id: "XAUUSD", name: "Gold" }).q));

check("web-search models detected (OpenRouter :online, *search*, sonar)", FA.ai.webModel({ provider: "openrouter", models: { openrouter: "openai/gpt-4o-mini:online" } })
  && FA.ai.webModel({ provider: "custom", models: { custom: "gpt-4o-mini-search-preview" } }) && FA.ai.webModel({ provider: "custom", models: { custom: "perplexity/sonar" } })
  && !FA.ai.webModel({ provider: "custom", models: { custom: "deepseek-chat" } }));

// ---- parallel sources with a hard budget: GDELT hangs (as when filtered), Yahoo fails, Bing answers via a relay
const hang = () => new Promise(() => {});
global.fetch = (url, opt) => {
  const u = String(url);
  if (u.includes("gdeltproject")) return hang();                                      // blocked → never answers
  if (u.includes("finance.yahoo")) return Promise.reject(new TypeError("Failed to fetch"));
  if (u.startsWith("https://www.bing.com")) return Promise.reject(new TypeError("CORS"));   // direct Bing has no CORS
  if (u.includes("allorigins") && u.includes("bing.com")) {
    const fresh = en.replace(/<pubDate>[^<]*<\/pubDate>/g, `<pubDate>${new Date().toUTCString()}</pubDate>`);
    return new Promise((res) => setTimeout(() => res({ ok: true, status: 200, text: async () => fresh }), 200));
  }
  return hang();
};
(async () => {
  const t0 = Date.now();
  const r = await N.assetNews({ id: "XAUUSD", name: "طلا", group: "فلزات و کالا" }, 4000);
  const ms = Date.now() - t0;
  check("never waits longer than the budget, even when a source hangs (was up to ~2 min)", ms < 5000, ms + " ms");
  check("headlines from the source that answered (Bing via relay) are returned", r.list.length >= 5 && /Bing/.test(r.source), r.source);
  check("failed / timed-out sources are reported, not hidden", /GDELT/.test(r.error) && /Yahoo/.test(r.error), r.error);
  check("merged list is newest-first and de-duplicated", r.list.every((h, i, a) => i === 0 || (a[i - 1].ts || 0) >= (h.ts || 0)) && new Set(r.list.map((h) => h.title)).size === r.list.length);
  console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED"); process.exit(fails ? 1 : 0);
})();
