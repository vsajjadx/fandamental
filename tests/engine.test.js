// Run: node tests/engine.test.js
require("../js/indicators.js"); require("../js/priceaction.js"); require("../js/signal.js"); require("../js/backtest.js");
const FA = globalThis.FA, I = FA.ind;
let fails = 0;
const check = (name, cond, extra = "") => { console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); if (!cond) fails++; };

// deterministic pseudo-random walk with trend + cycles
let seed = 42; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
function gen(n, drift) {
  const out = []; let p = 100, t = 1700000000;
  for (let i = 0; i < n; i++) {
    const o = p, c = o + drift + Math.sin(i / 17) * 0.6 + (rnd() - 0.5) * 1.6;
    const h = Math.max(o, c) + rnd() * 0.7, l = Math.min(o, c) - rnd() * 0.7;
    out.push({ t: t + i * 3600, o, h, l, c, v: 100 + rnd() * 50 }); p = c;
  }
  return out;
}

// --- known-value checks
const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
check("SMA(3) last = 9", I.sma(a, 3)[9] === 9);
check("EMA seed = SMA", Math.abs(I.ema(a, 3)[2] - 2) < 1e-9);
const up = a.map((x) => x), rs = I.rsi(up, 5);
check("RSI of strictly rising series = 100", rs[9] === 100);
const flat = new Array(40).fill(5);
check("RSI of falling series -> 0", I.rsi(a.slice().reverse(), 5)[9] < 1);

// --- engine on synthetic data
const c = gen(600, 0.05);
const res = FA.signal.analyze(c);
check("analyze returns no error", !res.error);
check("direction valid", ["long", "short", "none"].includes(res.direction), res.direction);
check("confluence in 0..100", res.confluence >= 0 && res.confluence <= 100, String(res.confluence));
check("indicator count >= 28 (with volume)", res.items.length >= 28, String(res.items.length));
check("no NaN scores", res.items.concat(res.paItems).every((x) => x.score === x.score));
if (res.plan) {
  const p = res.plan, s = p.side === "long" ? 1 : -1;
  check("SL on correct side", s * (p.entry - p.sl) > 0);
  check("TPs ordered & on correct side", s * (p.tps[0] - p.entry) > 0 && s * (p.tps[1] - p.tps[0]) > 0 && s * (p.tps[2] - p.tps[1]) > 0);
  check("RR positive", p.rr.every((x) => x > 0), p.rr.map((x) => x.toFixed(2)).join("/"));
}
const noVol = FA.signal.analyze(c.map((x) => ({ ...x, v: 0 })));
check("works without volume (fewer indicators)", !noVol.error && noVol.items.length < res.items.length, `${noVol.items.length} vs ${res.items.length}`);
check("rejects <60 candles", !!FA.signal.analyze(c.slice(0, 30)).error);

// --- early-signal path + P&L fields
const early = FA.signal.analyze(c, { early: true });
check("early path valid signalType", ["entry", "early", "none"].includes(early.signalType), early.signalType);
check("early timing string when early", early.signalType !== "early" || typeof early.timing === "string");
const ePlan = FA.signal.analyze(c, { early: true, marketEntry: true });
if (ePlan.plan) {
  const p = ePlan.plan, s2 = p.side === "long" ? 1 : -1;
  check("early plan SL on correct side", s2 * (p.entry - p.sl) > 0);
  check("early plan RR positive", p.rr.every((x) => x > 0));
}

// --- backtest
(async () => {
  const t0 = Date.now();
  const bt = await FA.backtest.run(gen(900, 0.02), { window: 300, horizon: 48 });
  console.log("backtest ms:", Date.now() - t0, "trades:", bt.trades.length);
  check("backtest produced trades", bt.trades.length > 5);
  check("every trade has valid result", bt.trades.every((x) => ["win", "loss", "expired"].includes(x.res)));
  const s0 = bt.summary[0];
  check("bucket totals consistent", s0.wins + s0.losses + s0.expired === s0.count);
  check("P&L: grossWin >= 0", s0.grossWin >= 0, String(s0.grossWin));
  check("P&L: grossLoss >= 0", s0.grossLoss >= 0, String(s0.grossLoss));
  check("P&L: maxDD >= 0", s0.maxDD >= 0, String(s0.maxDD));
  check("P&L: totalR = grossWin - grossLoss", Math.abs(s0.totalR - (s0.grossWin - s0.grossLoss)) < 1e-9);
  check("P&L: profitFactor consistent", s0.profitFactor === null || s0.profitFactor === Infinity || Math.abs(s0.profitFactor - s0.grossWin / s0.grossLoss) < 1e-9 || (s0.grossLoss === 0));
  console.log(bt.summary.map((s) => `>=${s.threshold}: n=${s.count} win=${s.winRate === null ? "-" : s.winRate.toFixed(1)}% avgR=${s.avgR === null ? "-" : s.avgR.toFixed(2)} totalR=${s.totalR === null ? "-" : s.totalR.toFixed(2)} PF=${s.profitFactor == null ? "-" : s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2)} maxDD=${s.maxDD.toFixed(2)}`).join("\n"));
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
})();
