// Run: node tests/providers.live.js [SYMBOL_ID ...]   (REAL network; skips a source that is down)
// Proves per provider that the fixed data layer returns candles. No args = the whole list.
require("../js/data.js");
const FA = globalThis.FA, D = FA.data;
const TF1D = D.TIMEFRAMES.find((t) => t.id === "1d");
const want = process.argv.slice(2);
const LIST = want.length ? want : ["BTCUSDT", "EURUSD", "XAGUSD", "XAUUSD", "SPX", "TSE-فولاد"];
let fails = 0, skipped = 0;

async function one(symId) {
  const sym = D.SYMBOLS.find((x) => x.id === symId);
  if (!sym) { console.log(`FAIL ${symId.padEnd(22)} unknown symbol`); fails++; return; }
  const t0 = Date.now();
  try {
    const r = await D.fetchCandles(sym, TF1D, {});
    const last = r.candles[r.candles.length - 1];
    const ms = Date.now() - t0;
    console.log(`PASS ${symId.padEnd(22)} ${String(r.candles.length).padStart(4)} candles via ${r.source} | last ${new Date(last.t * 1000).toISOString().slice(0, 10)} close=${last.c} | ${ms}ms`);
    if (!(r.candles.length >= 60) || !(last.c > 0)) { console.log("     ^ FAIL: too few candles / bad close"); fails++; }
  } catch (e) {
    const msg = String(e.message || e).slice(0, 160);
    const down = /Failed to fetch|زمان انتظار|rate limit|رله|HTTP 4\d\d|TSETMC پاسخ نداد|not covered|پلن|در انتظار/i.test(msg);
    console.log(`${down ? "SKIP" : "FAIL"} ${symId.padEnd(22)} ${msg}`);
    down ? skipped++ : fails++;
  }
}

(async () => {
  for (const id of LIST) if (id !== "XAUUSD") await one(id);
  // live spot path (gold-api) is a separate function
  if (LIST.indexOf("XAUUSD") >= 0) {
    const sp = await D.spotPrice(D.SYMBOLS.find((x) => x.id === "XAUUSD"));
    console.log(sp ? `PASS gold-api spot            XAU price=${sp.price} (${sp.src})` : "SKIP gold-api spot            unreachable");
    if (!sp) skipped++;
  }
  console.log(fails ? `\n${fails} FAILED, ${skipped} skipped (source unreachable from this network)` : `\nALL PASSED${skipped ? ` (${skipped} source(s) unreachable from this network)` : ""}`);
  process.exit(fails ? 1 : 0);
})();
