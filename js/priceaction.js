/* Fandamental — price action engine: swings, structure, support/resistance, candle patterns, fibonacci, pivots. */
(function (g) {
  const FA = (g.FA = g.FA || {});

  function swings(c, L = 3, R = 3) {
    const highs = [], lows = [];
    for (let i = L; i < c.length - R; i++) {
      let hi = true, lo = true;
      for (let k = 1; k <= L; k++) { if (c[i - k].h >= c[i].h) hi = false; if (c[i - k].l <= c[i].l) lo = false; }
      for (let k = 1; k <= R; k++) { if (c[i + k].h > c[i].h) hi = false; if (c[i + k].l < c[i].l) lo = false; }
      if (hi) highs.push({ i, p: c[i].h });
      if (lo) lows.push({ i, p: c[i].l });
    }
    return { highs, lows };
  }

  function structure(sw, c) {
    const H = sw.highs.slice(-3), Lw = sw.lows.slice(-3), last = c[c.length - 1];
    const res = { trend: "range", hh: false, hl: false, lh: false, ll: false, bos: null, lastHigh: null, lastLow: null };
    if (H.length >= 2 && Lw.length >= 2) {
      res.hh = H[H.length - 1].p > H[H.length - 2].p;
      res.lh = !res.hh;
      res.hl = Lw[Lw.length - 1].p > Lw[Lw.length - 2].p;
      res.ll = !res.hl;
      if (res.hh && res.hl) res.trend = "up";
      else if (res.lh && res.ll) res.trend = "down";
    }
    if (H.length) res.lastHigh = H[H.length - 1];
    if (Lw.length) res.lastLow = Lw[Lw.length - 1];
    if (res.lastHigh && last.c > res.lastHigh.p) res.bos = "up";
    if (res.lastLow && last.c < res.lastLow.p) res.bos = "down";
    return res;
  }

  /* Cluster swing prices into support/resistance zones. */
  function levels(c, sw, atrV, lookback = 250) {
    const from = Math.max(0, c.length - lookback);
    const pts = [...sw.highs, ...sw.lows].filter((s) => s.i >= from).sort((a, b) => a.p - b.p);
    const tol = Math.max(atrV * 0.6, 1e-9), clusters = [];
    for (const s of pts) {
      const cl = clusters[clusters.length - 1];
      if (cl && s.p - cl.max <= tol) { cl.pts.push(s); cl.max = s.p; }
      else clusters.push({ pts: [s], max: s.p });
    }
    const price = c[c.length - 1].c;
    return clusters
      .map((cl) => {
        const avg = cl.pts.reduce((a, s) => a + s.p, 0) / cl.pts.length;
        const recency = cl.pts.reduce((a, s) => a + (s.i - from) / (c.length - from), 0) / cl.pts.length;
        return { price: avg, touches: cl.pts.length, score: cl.pts.length + recency, type: avg < price ? "support" : "resistance" };
      })
      .filter((l) => l.touches >= 2 || l.score > 1.6)
      .sort((a, b) => a.price - b.price);
  }

  function patterns(c, trendLookback = 5) {
    const out = [], n = c.length;
    const info = (k) => {
      const x = c[k], body = Math.abs(x.c - x.o), range = x.h - x.l;
      return { body, range, up: x.h - Math.max(x.o, x.c), lo: Math.min(x.o, x.c) - x.l, bull: x.c > x.o, bear: x.c < x.o };
    };
    for (let i = Math.max(trendLookback + 1, n - 3); i < n; i++) {
      const a = info(i), p = info(i - 1), x = c[i], px = c[i - 1];
      if (a.range === 0) continue;
      const downBefore = c[i - trendLookback].c > c[i - 1].c, upBefore = c[i - trendLookback].c < c[i - 1].c;
      if (a.body <= 0.1 * a.range) out.push({ i, name: "Doji", fa: "دوجی (بلاتکلیفی)", dir: 0, strength: 0.3 });
      if (downBefore && a.lo >= 2 * a.body && a.up <= 0.6 * a.body + 1e-12 && a.body > 0) out.push({ i, name: "Hammer", fa: "چکش (برگشت صعودی)", dir: 1, strength: 0.7 });
      if (upBefore && a.up >= 2 * a.body && a.lo <= 0.6 * a.body + 1e-12 && a.body > 0) out.push({ i, name: "Shooting Star", fa: "ستاره‌ی ثاقب (برگشت نزولی)", dir: -1, strength: 0.7 });
      if (a.lo >= 0.6 * a.range && x.c >= x.l + 0.55 * a.range) out.push({ i, name: "Bull Pin Bar", fa: "پین‌بار صعودی", dir: 1, strength: 0.6 });
      if (a.up >= 0.6 * a.range && x.c <= x.h - 0.55 * a.range) out.push({ i, name: "Bear Pin Bar", fa: "پین‌بار نزولی", dir: -1, strength: 0.6 });
      if (p.bear && a.bull && x.o <= px.c && x.c >= px.o && a.body > p.body) out.push({ i, name: "Bullish Engulfing", fa: "انگالف صعودی", dir: 1, strength: 0.9 });
      if (p.bull && a.bear && x.o >= px.c && x.c <= px.o && a.body > p.body) out.push({ i, name: "Bearish Engulfing", fa: "انگالف نزولی", dir: -1, strength: 0.9 });
      if (i >= 2) {
        const pp = info(i - 2), ppx = c[i - 2];
        const mid = (ppx.o + ppx.c) / 2;
        if (pp.bear && pp.body > 0.5 * pp.range && p.body < 0.35 * pp.body && a.bull && x.c > mid) out.push({ i, name: "Morning Star", fa: "ستاره‌ی صبحگاهی", dir: 1, strength: 1 });
        if (pp.bull && pp.body > 0.5 * pp.range && p.body < 0.35 * pp.body && a.bear && x.c < mid) out.push({ i, name: "Evening Star", fa: "ستاره‌ی شامگاهی", dir: -1, strength: 1 });
        const strong = (k) => info(k).body > 0.5 * info(k).range;
        if (c[i].c > c[i - 1].c && c[i - 1].c > c[i - 2].c && [i, i - 1, i - 2].every((k) => info(k).bull && strong(k))) out.push({ i, name: "Three White Soldiers", fa: "سه سرباز سفید", dir: 1, strength: 0.8 });
        if (c[i].c < c[i - 1].c && c[i - 1].c < c[i - 2].c && [i, i - 1, i - 2].every((k) => info(k).bear && strong(k))) out.push({ i, name: "Three Black Crows", fa: "سه کلاغ سیاه", dir: -1, strength: 0.8 });
      }
      if (x.h < px.h && x.l > px.l) out.push({ i, name: "Inside Bar", fa: "اینساید بار", dir: 0, strength: 0.2 });
    }
    return out;
  }

  function fibonacci(sw) {
    const H = sw.highs[sw.highs.length - 1], Lw = sw.lows[sw.lows.length - 1];
    if (!H || !Lw) return null;
    const up = Lw.i < H.i, hi = H.p, lo = Lw.p, d = hi - lo;
    const ratios = [0.236, 0.382, 0.5, 0.618, 0.786];
    const levels = ratios.map((r) => ({ r, price: up ? hi - r * d : lo + r * d }));
    const ext = [1.272, 1.618].map((r) => ({ r, price: up ? lo + r * d : hi - r * d }));
    return { dir: up ? "up" : "down", high: hi, low: lo, levels, ext };
  }

  function pivots(c, t) {
    const dayOf = (s) => Math.floor(s / 86400), last = dayOf(c[c.length - 1].t);
    let prev = null;
    const grp = c.filter((x) => dayOf(x.t) < last);
    if (grp.length) {
      const pd = dayOf(grp[grp.length - 1].t), g2 = grp.filter((x) => dayOf(x.t) === pd);
      prev = { h: Math.max(...g2.map((x) => x.h)), l: Math.min(...g2.map((x) => x.l)), c: g2[g2.length - 1].c };
    } else if (c.length > 1) {
      const x = c[c.length - 2]; prev = { h: x.h, l: x.l, c: x.c };
    }
    if (!prev) return null;
    const P = (prev.h + prev.l + prev.c) / 3;
    return { P, R1: 2 * P - prev.l, S1: 2 * P - prev.h, R2: P + (prev.h - prev.l), S2: P - (prev.h - prev.l), R3: prev.h + 2 * (P - prev.l), S3: prev.l - 2 * (prev.h - P) };
  }

  FA.pa = { swings, structure, levels, patterns, fibonacci, pivots };
})(typeof window !== "undefined" ? window : globalThis);
