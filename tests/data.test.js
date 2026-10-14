// Run: node tests/data.test.js   (offline fixtures — no network)
require("../js/data.js");
const FA = globalThis.FA, D = FA.data;
let fails = 0;
const check = (n, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + n + (extra ? "  " + extra : "")); if (!c) fails++; };

// --- Frankfurter (FX) ---
const fr = D.parseFrankfurter({ amount: 1, base: "EUR", start_date: "2024-06-01", end_date: "2026-10-14", rates: { "2024-06-03": { USD: 1.09 }, "2024-06-04": { USD: 1.088 }, "2026-10-14": { USD: 1.1195 } } }, "EUR", "USD");
check("Frankfurter range -> 3 candles", fr.length === 3, String(fr.length));
check("Frankfurter candles ordered + valued", fr.every((x) => x.c > 0) && fr[0].t < fr[2].t);
check("Frankfurter legacy single -> 1 candle", D.parseFrankfurter({ base: "EUR", date: "2026-10-14", rates: { USD: 1.1195 } }, "EUR", "USD").length === 1);

// --- CoinGecko (silver / platinum) ---
const cg = D.parseCoinGecko({ prices: [[1e12, 2], [1e12 + 86400e3, 3]] }, 31.1034768);
check("CoinGecko platinum scaled to troy ounce", Math.abs(cg[1].c - 3 * 31.1034768) < 1e-6, String(cg[1].c));
check("CoinGecko OHLC consistent", cg.every((x) => x.h >= x.l && x.h >= Math.max(x.o, x.c) && x.l <= Math.min(x.o, x.c)));

// --- Yahoo chart ---
const ys = D.parseYahoo({ chart: { result: [{ timestamp: [1, 2, 3], indicators: { quote: [{ open: [1, null, 3], high: [2, null, 4], low: [0.5, null, 2.5], close: [1.5, null, 3.5], volume: [10, null, 20] }] } }] } });
check("Yahoo drops null bars", ys.length === 2, String(ys.length));
check("Yahoo volume mapped", ys[1].v === 20);
check("Yahoo range map 1d", D.rangeForTf("1d").interval === "1d");
check("Yahoo range map 5m", D.rangeForTf("5m").range === "1mo");

// --- TSETMC (بورس تهران) ---
const ts = D.parseTsetmc({ closingPriceDaily: [{ dEven: 20261014, pOpening: 3000, priceMax: 3150, priceMin: 2980, pClosing: 3100, qTotTran: 12 }] });
check("TSETMC parsed", ts.length === 1 && ts[0].c === 3100 && ts[0].v === 12);
check("TSETMC date = 2026-10-14", new Date(ts[0].t * 1000).toISOString().slice(0, 10) === "2026-10-14");
check("TSETMC drops broken rows", D.parseTsetmc({ closingPriceDaily: [{ dEven: 20261014, pOpening: 0, priceMax: 0, priceMin: 0, pClosing: 0 }] }).length === 0);

// --- catalog integrity (the 404 regression) ---
const s = (id) => D.SYMBOLS.find((x) => x.id === id) || {};
const orphans = D.SYMBOLS.filter((x) => !x.bn && !x.tse && !x.fx && !x.cg && !x.yh && !x.td);
check("every symbol has at least one provider", orphans.length === 0, orphans.map((x) => x.id).join(","));
check("silver uses the live CoinGecko id (kinesis-silver)", s("XAGUSD").cg === "kinesis-silver");
check("platinum uses the live CoinGecko id (gram-platinum)", s("XPTUSD").cg === "gram-platinum" && s("XPTUSD").cgScale > 31);
check("oil has a Yahoo symbol (CL=F)", s("USOIL").yh === "CL=F");
check("metals expose live spot codes", ["XAUUSD", "XAGUSD", "XPTUSD"].every((id) => !!s(id).spot));
check("indices have Yahoo fallbacks", ["DXY", "SPX", "NDX", "DJI"].every((id) => !!s(id).yh));
check("FX pairs have Yahoo fallbacks", D.SYMBOLS.filter((x) => x.group === "فارکس").every((x) => !!x.yh));
check("bourse group present in the catalog", D.SYMBOLS.some((x) => x.group === "بورس تهران" && x.tse));

// --- timeframe feasibility ---
const TF = (id) => D.TIMEFRAMES.find((t) => t.id === id);
check("5m on a free daily metal auto-switches to 1D", D.resolveTimeframe(s("XAGUSD"), TF("5m"), {}).changed && D.resolveTimeframe(s("XAGUSD"), TF("5m"), {}).tf.id === "1d");
check("5m stays for crypto (Binance intraday)", D.resolveTimeframe(s("BTCUSDT"), TF("5m"), {}).changed === false);
check("5m stays when a Twelve Data key exists", D.resolveTimeframe(s("XAGUSD"), TF("5m"), { twelve: "k" }).changed === false);
check("1d never switches", D.resolveTimeframe(s("XAGUSD"), TF("1d"), {}).changed === false);

console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED");
process.exit(fails ? 1 : 0);
