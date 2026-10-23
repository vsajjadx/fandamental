// Run: node tests/fundamental.test.js — volume from CoinGecko + free news-tone fundamental (real saved responses)
require("../js/indicators.js"); require("../js/priceaction.js"); require("../js/signal.js"); require("../js/data.js"); require("../js/news.js");
const FA = globalThis.FA, N = FA.news;
let fails = 0;
const check = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); if (!c) fails++; };

// ---- CoinGecko volume is no longer dropped
const chart = require("./fixtures/coingecko_chart_kag.json");
const cg = FA.data.parseCoinGecko(chart);
check("CoinGecko candles keep the real traded volume", cg.length === chart.prices.length && cg.filter((x) => x.v > 0).length >= cg.length - 1, `last v=${Math.round(cg[cg.length - 1].v)}`);
check("…and the engine then uses volume indicators", (() => {
  const c = []; for (let k = 0; k < 120; k++) c.push(...cg.slice(-1).map((x) => ({ ...x, t: x.t + k * 86400, c: x.c + Math.sin(k / 5), o: x.c, h: x.c + 1.2, l: x.c - 1.2 })));
  const r = FA.signal.analyze(c); return r.series.hasVol && r.items.some((i) => i.group === "vol") && !r.notes.some((n) => /حجم/.test(n));
})());

// ---- GDELT tone
const parse = (j) => j.timeline[0].data.map((p) => ({ t: Date.parse(p.date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z")) / 1000, v: +p.value }));
const eur = parse(require("./fixtures/gdelt_tone_euro.json")), usd = parse(require("./fixtures/gdelt_tone_usd.json"));
const se = N.toneShift(eur), su = N.toneShift(usd);
check("tone shift computed from a real 7-day GDELT timeline", se && su && isFinite(se.delta) && se.n > 100, se && `EUR recent ${se.recent.toFixed(2)} vs ${se.base.toFixed(2)}`);
const f = N.toneFund({ base: se, quote: su }, { base: "EUR", quote: "USD" });
check("EUR/USD fund = base minus quote, same shape the engine expects", f.kind === "tone" && ["bullish", "bearish", "neutral"].includes(f.bias) && Math.abs(f.score - Math.max(-1, Math.min(1, (se.delta - su.delta) / 1.5))) < 1e-12, `${f.bias} ${f.score.toFixed(2)} conf ${f.confidence}`);
check("confidence capped low (≤35) → small weight in the score", f.confidence <= 35 && f.confidence >= 0);
check("summary explains the numbers", /EUR/.test(f.summary) && /USD/.test(f.summary) && /۷۲ ساعت/.test(f.summary));
const T0 = 1800000000, mk = (vals) => vals.map((v, k) => ({ t: T0 + k * 3600, v }));
const up = N.toneShift(mk([...Array(96).fill(-2), ...Array(72).fill(0)]));
check("news turning more positive → bullish", N.toneFund({ base: up }, { base: "X" }).bias === "bullish" && up.delta === 2);
const dn = N.toneShift(mk([...Array(96).fill(0), ...Array(72).fill(-1.5)]));
check("news turning more negative → bearish", N.toneFund({ base: dn }, { base: "X" }).bias === "bearish");
check("too little data → no signal (null), never a guess", N.toneShift(mk(Array(10).fill(0))) === null);

// ---- engine: notes instead of alarming warnings
const c = []; let p = 1.1; for (let k = 0; k < 300; k++) { const o = p, cl = o + Math.sin(k / 9) * 0.002; c.push({ t: T0 + k * 86400, o, c: cl, h: Math.max(o, cl) + 0.001, l: Math.min(o, cl) - 0.001, v: 0 }); p = cl; }
const r0 = FA.signal.analyze(c);
check("no-volume source → informational note, not a warning", r0.notes.some((n) => /حجم/.test(n)) && !r0.warnings.some((w) => /حجم/.test(w)));
check("no fundamental yet → note, not a warning", r0.notes.some((n) => /فاندامنتال/.test(n)) && !r0.warnings.some((w) => /فاندامنتال/.test(w)));
const r1 = FA.signal.analyze(c, { fund: f });
check("tone fund enters the score with its low confidence", r1.fund === f && r1.notes.some((n) => /لحن اخبار/.test(n)) && !r1.notes.some((n) => /هنوز آماده/.test(n)));
console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED"); process.exit(fails ? 1 : 0);
