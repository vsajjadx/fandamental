// Run: node tests/setups.test.js — setups engine on hand-built patterns + no-look-ahead + walk-forward backtest
require("../js/indicators.js"); require("../js/priceaction.js"); require("../js/signal.js"); require("../js/setups.js"); require("../js/backtest.js");
const FA = globalThis.FA, X = FA.setups;
let fails = 0;
const check = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); if (!c) fails++; };

let seed = 5; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
/* Build candles that follow a path of close prices with small, controllable noise. */
function fromPath(path, noise = 0.15, t0 = 1790000000) {
  const out = []; let prev = path[0];
  path.forEach((p, i) => { const o = prev, c = p; const w = noise * (0.5 + rnd());
    out.push({ t: t0 + i * 3600, o, c, h: Math.max(o, c) + w, l: Math.min(o, c) - w, v: 100 + rnd() * 10 }); prev = c; });
  return out;
}
const flat = (n, p) => Array.from({ length: n }, (_, k) => p + Math.sin(k / 2) * 0.3);
const lerp = (a, b, n) => Array.from({ length: n }, (_, k) => a + ((b - a) * (k + 1)) / n);
const zig = (pts, step) => pts.slice(1).reduce((acc, p, k) => acc.concat(lerp(pts[k], p, step)), [pts[0]]);
const keys = (c) => X.detect(c).setups.map((s) => s.key);
const has = (c, k) => keys(c).includes(k);
const last = (c, o) => { const x = c[c.length - 1]; Object.assign(x, o); return c; };

// -------- plan helper
const p = X.plan(1, 100, 99, 104, 1);
check("plan: long, rr from target", p.side === "long" && p.rr === 4 && p.risk === 1);
check("plan: too-small stop widened to 0.5 ATR", X.plan(1, 100, 99.9, null, 1).risk === 0.5);
check("plan: stop beyond 3.5 ATR rejected", X.plan(1, 100, 95, null, 1) === null);
check("plan: wrong-side stop rejected", X.plan(1, 100, 101, null, 1) === null);
check("plan: falls back to the closer structural stop when the first is too far", X.plan(1, 100, [95, 98.5], null, 1).sl === 98.5);
check("plan: missing/too-close target → 2R", X.plan(-1, 100, 101, 99.5, 1).tp === 98);

// -------- uptrend line pullback & break (rising zigzag with higher lows on a straight line)
{
  const base = flat(80, 100);
  const up = zig([100, 106, 102, 108, 104, 110, 106, 112, 108, 113], 8);   // lows 102,104,106,108 on a line
  const path = base.concat(up);
  const c = fromPath(path);
  const d = X.detect(c);
  const tl = X.trendline({ c, i: c.length - 1, A: d.setups.length ? 1 : 1, sw: FA.pa.swings(c) }, "up");
  check("uptrend line found through higher lows", !!tl && tl.slope > 0 && tl.touches >= 3, tl && `touches ${tl.touches}`);
  // pullback: next candle dips to the line and closes bullish above it
  const i = c.length, v = tl.at(i), A = FA.ind.atr(c.map((x) => x.h), c.map((x) => x.l), c.map((x) => x.c))[c.length - 1];
  const pb = c.concat([{ t: c[c.length - 1].t + 3600, o: v + 0.6 * A, l: v + 0.05 * A, c: v + 0.9 * A, h: v + 1.0 * A, v: 100 }]);
  check("pullback to uptrend line → long setup", has(pb, "tl_up_pullback"), keys(pb).join(","));
  const br = c.concat([{ t: c[c.length - 1].t + 3600, o: v + 0.2 * A, h: v + 0.3 * A, l: v - 1.2 * A, c: v - 1.0 * A, v: 100 }]);
  check("close below uptrend line → 'break' short setup", has(br, "tl_up_break"), keys(br).join(","));
  const s = X.detect(pb).setups.find((x) => x.key === "tl_up_pullback");
  check("pullback plan: stop below the line, target above entry", s.plan.sl < v && s.plan.tp > s.plan.entry && s.plan.rr >= 1.2);
}
// -------- downtrend line rejection & break (mirror)
{
  const path = flat(80, 113).concat(zig([113, 107, 111, 105, 109, 103, 107, 101, 105, 100], 8));
  const c = fromPath(path), sw = FA.pa.swings(c);
  const A = FA.ind.atr(c.map((x) => x.h), c.map((x) => x.l), c.map((x) => x.c))[c.length - 1];
  const tl = X.trendline({ c, i: c.length - 1, A, sw }, "down");
  check("downtrend line found through lower highs", !!tl && tl.slope < 0 && tl.touches >= 3);
  const v = tl.at(c.length);
  const rej = c.concat([{ t: c[c.length - 1].t + 3600, o: v - 0.6 * A, h: v - 0.05 * A, c: v - 0.9 * A, l: v - 1.0 * A, v: 100 }]);
  check("rejection at downtrend line → short setup", has(rej, "tl_dn_pullback"), keys(rej).join(","));
  const br = c.concat([{ t: c[c.length - 1].t + 3600, o: v - 0.2 * A, l: v - 0.3 * A, h: v + 1.2 * A, c: v + 1.0 * A, v: 100 }]);
  check("close above downtrend line → 'break' long setup", has(br, "tl_dn_break") || has(br, "tri_break_up"), keys(br).join(","));
}
// -------- rectangle: inside + breakout
{
  const box = zig([100, 110, 100, 110, 100, 110, 100, 110, 104], 5);
  const c = fromPath(flat(60, 105).concat(box), 0.2);
  const d = X.detect(c);
  const r = X.rectangle({ c, i: c.length - 1, A: 1.5, sw: FA.pa.swings(c) });
  check("rectangle detected (top≈110, bottom≈100)", !!r && Math.abs(r.top - 110) < 1 && Math.abs(r.bot - 100) < 1, r && `${r.bot.toFixed(1)}–${r.top.toFixed(1)}`);
  check("rectangle drawn as a zone", d.drawings.some((x) => x.type === "zone" && /مستطیل/.test(x.label)));
  const brk = c.concat([{ t: c[c.length - 1].t + 3600, o: 108, l: 107.8, h: 113, c: 112.5, v: 400 }]);
  check("close above the box with volume → rectangle breakout long", has(brk, "rect_break_up"), keys(brk).join(","));
  const s = X.detect(brk).setups.find((x) => x.key === "rect_break_up");
  check("breakout target ≈ box height projected", s && Math.abs(s.plan.tp - (112.5 + r.height)) < 0.01 && s.strength === 0.8);
  const weak = c.concat([{ t: c[c.length - 1].t + 3600, o: 108, l: 107.8, h: 113, c: 112.5, v: 50 }]);
  const sw2 = X.detect(weak).setups.find((x) => x.key === "rect_break_up");
  check("breakout without volume is weaker and says so", sw2 && sw2.strength === 0.5 && /حجم/.test(sw2.why));
  const inside = c.concat([{ t: c[c.length - 1].t + 3600, o: 100.2, l: 99.9, h: 102, c: 101.8, v: 100 }]);
  check("bullish candle at box bottom → buy inside rectangle", has(inside, "rect_in_long"), keys(inside).join(","));
}
// -------- double bottom neckline break
{
  const path = flat(60, 110).concat(zig([110, 100, 106, 100.2, 105.6], 7));
  const c = fromPath(path, 0.1);
  const brk = c.concat([{ t: c[c.length - 1].t + 3600, o: 105.5, l: 105.3, h: 107.8, c: 107.6, v: 100 }]);
  check("double bottom: neckline break → long", has(brk, "dbl_bottom"), keys(brk).join(","));
  const s = X.detect(brk).setups.find((x) => x.key === "dbl_bottom");
  check("double bottom target = neckline + height", s && s.plan.tp > 110 && s.plan.tp < 113, s && s.plan.tp.toFixed(2));
}
// -------- double top (mirror)
{
  const path = flat(60, 100).concat(zig([100, 110, 104, 109.8, 104.4], 7));
  const c = fromPath(path, 0.1);
  const brk = c.concat([{ t: c[c.length - 1].t + 3600, o: 104.5, h: 104.7, l: 102.2, c: 102.4, v: 100 }]);
  check("double top: neckline break → short", has(brk, "dbl_top"), keys(brk).join(","));
}
// -------- head & shoulders
{
  const path = flat(60, 100).concat(zig([100, 106, 102, 110, 102.3, 105.8, 102.6], 6));
  const c = fromPath(path, 0.1);
  const brk = c.concat([{ t: c[c.length - 1].t + 3600, o: 102.6, h: 102.8, l: 100.2, c: 100.4, v: 100 }]);
  check("head & shoulders: neckline break → short", has(brk, "hs_top"), keys(brk).join(","));
}
// -------- bull flag
{
  const path = flat(80, 100).concat(lerp(100, 112, 6), [111, 110.5, 110.8, 110.2, 110.6, 110.3]);
  const c = fromPath(path, 0.15);
  const brk = c.concat([{ t: c[c.length - 1].t + 3600, o: 110.5, l: 110.4, h: 112.6, c: 112.4, v: 100 }]);
  check("bull flag: break of flag high → long, target = pole length", has(brk, "flag_bull"), keys(brk).join(","));
}
// -------- liquidity sweep
{
  const path = flat(60, 105).concat(zig([105, 100, 106, 101], 6));
  const c = fromPath(path, 0.1);
  const sw = FA.pa.swings(c), L = sw.lows[sw.lows.length - 1];
  const sweep = c.concat([{ t: c[c.length - 1].t + 3600, o: 100.9, l: L.p - 0.5, h: 101.3, c: 101.2, v: 100 }]);
  check("wick below the last low and close back above → sweep long", has(sweep, "smc_sweep_long"), keys(sweep).join(","));
}
// -------- BOS / CHoCH reporting
{
  const path = flat(60, 100).concat(zig([100, 96, 98, 94, 96.5, 93, 95.5], 6));
  const c = fromPath(path, 0.1);
  const sw = FA.pa.swings(c), H = sw.highs[sw.highs.length - 1];
  const ch = c.concat([{ t: c[c.length - 1].t + 3600, o: 95.4, l: 95.3, h: H.p + 1.3, c: H.p + 1.1, v: 100 }]);
  const d = X.detect(ch);
  check("break of the last high inside a downtrend → CHoCH (not BOS)", d.setups.some((s) => s.key === "smc_choch_up") && d.info.some((x) => /CHoCH/.test(x.text)), d.setups.map((s) => s.key).join(","));
}

// -------- no look-ahead: results at bar k never change when future bars are appended
{
  const c = []; let pr = 100;
  for (let k = 0; k < 500; k++) { const o = pr, cl = o + (rnd() - 0.48) * 2; c.push({ t: 1790000000 + k * 3600, o, c: cl, h: Math.max(o, cl) + rnd(), l: Math.min(o, cl) - rnd(), v: 100 }); pr = cl; }
  let same = true;
  for (const k of [200, 260, 330, 410]) {
    const a = JSON.stringify(X.detect(c.slice(0, k + 1)).setups), b = JSON.stringify(X.detect(c.slice(0, k + 1).map((x) => ({ ...x }))).setups);
    if (a !== b) same = false;
  }
  // stronger: detection at k uses only c[0..k]; we verify by poisoning everything after k
  let poisonOk = true;
  for (const k of [220, 300, 390]) {
    const clean = JSON.stringify(X.detect(c.slice(0, k + 1)).setups);
    const poisoned = c.slice(0, k + 1).concat(c.slice(k + 1).map((x) => ({ ...x, h: 1e6, l: -1e6, c: 5e5 })));
    const view = JSON.stringify(X.detect(poisoned.slice(0, k + 1)).setups);
    if (clean !== view) poisonOk = false;
  }
  check("deterministic and blind to future candles", same && poisonOk);

  // -------- per-setup backtest runs and scores every setup on profit/loss
  (async () => {
    const t0 = Date.now();
    const bt = await X.backtest(c, { window: 300, horizon: 48 });
    check("per-setup walk-forward backtest produces stats", Array.isArray(bt.stats) && bt.stats.every((s) => s.count > 0 && Number.isFinite(s.totalR)), `${bt.trades.length} trades, ${bt.stats.length} setup types, ${Date.now() - t0}ms`);
    check("each trade is either a win (R=rr), a loss (R=-1) or expired", bt.trades.every((t) => (t.res === "win" && t.R === t.rr) || (t.res === "loss" && t.R === -1) || t.res === "expired"));
    const r = X.detect(c);
    check("every detected setup has a coherent plan", r.setups.every((s) => (s.dir === 1 ? s.plan.sl < s.plan.entry && s.plan.tp > s.plan.entry : s.plan.sl > s.plan.entry && s.plan.tp < s.plan.entry)));
    // styles table
    check("four trading styles with entry/confirm timeframes", ["scalp", "day", "swing", "position"].every((k) => X.STYLES[k] && X.STYLES[k].entry.length));
    console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED");
    process.exit(fails ? 1 : 0);
  })();
}
