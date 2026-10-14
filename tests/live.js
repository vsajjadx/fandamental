/* Live end-to-end check of the real provider chain (Node 22 has fetch).
   Mirrors what the browser does: resolveTimeframe -> fetchCandles -> signal.analyze. */
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
require("../js/indicators.js"); require("../js/priceaction.js"); require("../js/signal.js"); require("../js/data.js"); require("../js/news.js");
const FA = globalThis.FA, D = FA.data;
let fails = 0;
const rows = [];
const check = (n, c, extra = "") => { if (!c) fails++; rows.push((c ? "PASS " : "FAIL ") + n + (extra ? "  " + extra : "")); };
const brief = (e) => String((e && e.message) || e).slice(0, 110);

async function probe(sym) {
  const tf = D.resolveTimeframe(sym, D.TIMEFRAMES.find((t) => t.id === "1d"), {}).tf;
  try {
    const r = await D.fetchCandles(sym, tf, {}, 400);
    const c = r.candles, a = FA.signal.analyze(c, { early: true });
    const okBar = c.every((x) => [x.o, x.h, x.l, x.c].every((v) => typeof v === "number" && v === v && v > 0));
    check("data " + sym.id, !a.error && c.length >= 60 && okBar && a.price > 0,
      `${c.length} کندل · ${r.source} · آخرین ${a.price} · جهت ${a.direction} · هم‌سویی ${a.confluence}` + (okBar ? "" : " [کندل خراب!]"));
  } catch (e) { check("data " + sym.id, false, brief(e)); }
}

(async () => {
  const list = D.SYMBOLS.filter((s) => ["XAGUSD", "USOIL", "XPTUSD", "XAUUSD", "SPX", "DXY", "EURUSD", "USDJPY", "BTCUSDT", "DOGEUSDT"].includes(s.id));
  for (const s of list) await probe(s);
  await probe(D.SYMBOLS.find((s) => s.tse));           // بورس تهران (TSETMC + relays)

  // «بهترین‌ها» = scan every non-bourse market through the same chain
  const scan = D.SYMBOLS.filter((s) => s.group !== "بورس تهران");
  const out = [];
  for (let i = 0; i < scan.length; i += 6) {
    await Promise.all(scan.slice(i, i + 6).map(async (sym) => {
      try {
        const r = await D.fetchCandles(sym, D.resolveTimeframe(sym, D.TIMEFRAMES.find((t) => t.id === "1d"), {}).tf, {}, 400);
        const a = FA.signal.analyze(r.candles, { early: true, marketEntry: true, threshold: 0 });
        if (a.error) throw new Error(a.error);
        out.push({ id: sym.id, src: r.source, n: r.candles.length, dir: a.direction, conf: a.confluence });
      } catch (e) { out.push({ id: sym.id, err: brief(e) }); }
    }));
  }
  const bad = out.filter((x) => x.err);
  check("بهترین‌ها: every market returns real candles", bad.length === 0, `${out.length - bad.length}/${out.length} ok` + (bad.length ? " · خطاها: " + bad.map((b) => b.id + " -> " + b.err).join(" ; ") : ""));
  rows.push("   scan: " + out.map((x) => `${x.id}${x.err ? "✗" : "✓"}(${x.src || x.err})`).join(", "));

  // news + calendar (the panel that used to hang)
  const news = await FA.news.assetNews(D.SYMBOLS.find((s) => s.id === "XAGUSD"));
  check("news: silver headlines (GDELT/Yahoo/cache, never hangs)", !!news.list.length || !!news.error,
    `${news.list.length} تیتر · منبع ${news.source || "—"} · ${news.error || "بدون خطا"} · "${(news.list[0] || {}).title || ""}".slice(0,70)`);
  let cal = null; try { cal = await FA.news.economicCalendar(); } catch (e) { cal = null; }
  const match = cal ? FA.news.matchCalendar(cal, D.SYMBOLS.find((s) => s.id === "EURUSD")) : [];
  check("news: economic calendar resolves", !!cal, cal ? `${cal.length} رویداد هفته · مربوط به EURUSD: ${match.length}` : "خطا (کش/پیام خطا نمایش داده می‌شود)");

  // spot quote for metals
  const sp = await D.spotPrice(D.SYMBOLS.find((s) => s.id === "XAGUSD"));
  check("spot quote: silver live price", !!sp && sp.price > 0, sp ? `${sp.price} از ${sp.src}` : "در دسترس نبود");

  console.log(rows.join("\n"));
  console.log(fails ? "\n" + fails + " FAILED" : "\nLIVE ALL PASSED");
  process.exit(fails ? 1 : 0);
})();
