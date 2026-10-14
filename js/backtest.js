/* Fandamental — walk-forward backtest of the signal engine, scored on PROFIT/LOSS.
   The final result is the sum of realized R (profit or loss) of every trade,
   NOT a buy/sell "accuracy". A correct test must include the losers. */
(function (g) {
  const FA = (g.FA = g.FA || {});
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const ok = (x) => typeof x === "number" && x === x;

  async function run(candles, opts = {}) {
    const win = opts.window || 300, horizon = opts.horizon || 48, minBars = opts.minBars || 220;
    const early = !!opts.early;
    const trades = [];
    let i = minBars, evals = 0;
    while (i < candles.length - 2) {
      const slice = candles.slice(Math.max(0, i - win + 1), i + 1);
      // walk-forward: the engine only sees the bars up to i (no lookahead, no repaint)
      const a = FA.signal.analyze(slice, { marketEntry: true, threshold: 0, early });
      evals++;
      if (a.direction !== "none" && a.plan) {
        const p = a.plan, s = p.side === "long" ? 1 : -1, end = Math.min(candles.length - 1, i + horizon);
        let res = "expired", exitIdx = end;
        for (let j = i + 1; j <= end; j++) {
          const x = candles[j];
          const hitSL = s === 1 ? x.l <= p.sl : x.h >= p.sl, hitTP = s === 1 ? x.h >= p.tps[0] : x.l <= p.tps[0];
          if (hitSL) { res = "loss"; exitIdx = j; break; } // if both inside one bar, assume the worse case
          if (hitTP) { res = "win"; exitIdx = j; break; }
        }
        const R = res === "win" ? p.rr[0] : res === "loss" ? -1 : (s * (candles[exitIdx].c - p.entry)) / p.risk;
        trades.push({ i, t: candles[i].t, side: p.side, confluence: a.confluence, res, R, rr: p.rr[0], entry: p.entry, sl: p.sl, tp1: p.tps[0] });
        i = exitIdx + 1;
      } else i++;
      if (evals % 15 === 0) { if (opts.onProgress) opts.onProgress((i - minBars) / Math.max(1, candles.length - minBars)); await tick(); }
    }
    return { trades, summary: [0, 50, 60, 70, 80].map((th) => bucket(trades, th)), bars: candles.length };
  }

  function bucket(trades, th) {
    const t = trades.filter((x) => x.confluence >= th);
    const wins = t.filter((x) => x.res === "win").length, losses = t.filter((x) => x.res === "loss").length, exp = t.length - wins - losses;
    const totalR = t.reduce((a, x) => a + (ok(x.R) ? x.R : 0), 0);
    const avgRR = t.length ? t.reduce((a, x) => a + x.rr, 0) / t.length : 0;
    const grossWin = t.filter((x) => x.R > 0).reduce((a, x) => a + x.R, 0);
    const grossLoss = -t.filter((x) => x.R < 0).reduce((a, x) => a + x.R, 0);
    return {
      threshold: th, count: t.length, wins, losses, expired: exp,
      winRate: wins + losses ? (100 * wins) / (wins + losses) : null,
      breakeven: avgRR ? 100 / (1 + avgRR) : null,
      avgR: t.length ? totalR / t.length : null, totalR,
      grossWin, grossLoss,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
      maxDD: maxDrawdown(t),
    };
  }

  /* max peak-to-trough drawdown of the cumulative R curve */
  function maxDrawdown(t) {
    let eq = 0, peak = 0, dd = 0;
    for (const x of t) { eq += ok(x.R) ? x.R : 0; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
    return dd;
  }

  FA.backtest = { run, bucket, maxDrawdown };
})(typeof window !== "undefined" ? window : globalThis);
