// Run: node tests/mtf.test.js — multi-timeframe view (display only; the engine itself is unchanged)
require("../js/indicators.js"); require("../js/priceaction.js"); require("../js/signal.js"); require("../js/data.js"); require("../js/mtf.js");
const FA = globalThis.FA, M = FA.mtf;
let fails = 0;
const check = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); if (!c) fails++; };
let seed = 11; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
function gen(n, drift, step) {
  const out = []; let p = 2400, t = 1790000000;
  for (let i = 0; i < n; i++) { const o = p, c = o + drift + Math.sin(i / 17) * 3 + (rnd() - 0.5) * 6; out.push({ t: t + i * step, o, h: Math.max(o, c) + rnd() * 3, l: Math.min(o, c) - rnd() * 3, c, v: 100 }); p = c; }
  return out;
}
const TF = FA.data.TIMEFRAMES;
check("five timeframes, each with its own colour", TF.length === 5 && TF.every((t) => M.TF_COLOR[t.id]));

const rows = TF.map((tf, k) => {
  const res = FA.signal.analyze(gen(600, k % 2 ? -0.9 : 0.9, tf.sec), { early: true });
  return { tf, res, sum: M.summarize(res) };
});
const r0 = rows[0];
check("summary mirrors the engine's own result (direction / confluence / plan)",
  r0.sum.direction === r0.res.direction && r0.sum.confluence === r0.res.confluence && (!r0.res.plan || (r0.sum.plan.entry === r0.res.plan.entry && r0.sum.plan.sl === r0.res.plan.sl && r0.sum.plan.tps[0] === r0.res.plan.tps[0])));
check("summary status matches tradeable / early", rows.every((r) => (r.sum.status === "valid") === (r.res.tradeable && r.res.signalType !== "early") && (r.sum.status === "early") === (r.res.signalType === "early")));
check("summary has RSI / ADX / regime from the engine's series", rows.every((r) => r.sum.rsi === r.res.series.rsi[r.res.count - 1] && typeof r.sum.regime === "string"));
check("summarize(error) is safe", M.summarize({ error: "x" }).error === "x" && M.summarize(null).error);

const al = M.alignment(rows);
check("alignment counts every analysed timeframe once", al.total === 5 && al.long + al.short + al.none === 5, JSON.stringify(al));
check("alignment ignores failed rows", M.alignment([...rows, { sum: { error: "x" } }, null]).total === 5);

const lines = M.overlayLines(rows, ["4h", "1d", "1h"], "1h");
check("current timeframe is never drawn twice", !lines.some((l) => l.title.startsWith("1H ")));
check("only ticked timeframes are drawn", lines.every((l) => /^(4H|1D) /.test(l.title)) && lines.length > 0, lines.map((l) => l.title).join(","));
const four = rows.find((r) => r.tf.id === "4h").sum;
if (four.plan) check("4H plan lines carry the 4H plan prices", lines.find((l) => l.title === "4H ENTRY").price === four.plan.entry && lines.find((l) => l.title === "4H SL").price === four.plan.sl);
check("lines use the timeframe's colour", lines.filter((l) => l.title.startsWith("4H")).every((l) => l.color === M.TF_COLOR["4h"]));
check("nothing ticked → nothing drawn", M.overlayLines(rows, [], "1h").length === 0);
check("cache: intraday 60s, 4H/1D 5 min", M.cacheTtlSec(TF[0]) === 60 && M.cacheTtlSec(TF[2]) === 60 && M.cacheTtlSec(TF[3]) === 300 && M.cacheTtlSec(TF[4]) === 300);
console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED"); process.exit(fails ? 1 : 0);
