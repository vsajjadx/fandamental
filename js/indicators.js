/* Fandamental — indicator engine (pure functions, no dependencies).
   All functions take plain arrays and return arrays aligned to the input (NaN where undefined). */
(function (g) {
  const FA = (g.FA = g.FA || {});
  const N = NaN;
  const ok = (x) => typeof x === "number" && x === x;
  const fill = (n, v) => new Array(n).fill(v === undefined ? N : v);
  const first = (a) => a.findIndex(ok);

  function sma(a, n) {
    const out = fill(a.length), s = first(a);
    if (s < 0) return out;
    let sum = 0;
    for (let i = s; i < a.length; i++) {
      sum += a[i];
      if (i - s >= n) sum -= a[i - n];
      if (i - s >= n - 1) out[i] = sum / n;
    }
    return out;
  }
  function ema(a, n, alpha) {
    alpha = alpha || 2 / (n + 1);
    const out = fill(a.length), s = first(a);
    if (s < 0 || a.length - s < n) return out;
    let prev = 0;
    for (let i = s; i < s + n; i++) prev += a[i];
    prev /= n;
    out[s + n - 1] = prev;
    for (let i = s + n; i < a.length; i++) {
      prev = alpha * a[i] + (1 - alpha) * prev;
      out[i] = prev;
    }
    return out;
  }
  const rma = (a, n) => ema(a, n, 1 / n);
  function wma(a, n) {
    const out = fill(a.length), s = first(a), den = (n * (n + 1)) / 2;
    if (s < 0) return out;
    for (let i = s + n - 1; i < a.length; i++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += a[i - k] * (n - k);
      out[i] = sum / den;
    }
    return out;
  }
  function hma(a, n) {
    const h = Math.max(1, Math.floor(n / 2)), r = Math.max(1, Math.round(Math.sqrt(n)));
    const w1 = wma(a, h), w2 = wma(a, n);
    return wma(a.map((_, i) => 2 * w1[i] - w2[i]), r);
  }
  function rollMax(a, n) {
    const out = fill(a.length);
    for (let i = n - 1; i < a.length; i++) {
      let m = -Infinity, bad = false;
      for (let k = 0; k < n; k++) { const v = a[i - k]; if (!ok(v)) { bad = true; break; } if (v > m) m = v; }
      if (!bad) out[i] = m;
    }
    return out;
  }
  function rollMin(a, n) {
    const out = fill(a.length);
    for (let i = n - 1; i < a.length; i++) {
      let m = Infinity, bad = false;
      for (let k = 0; k < n; k++) { const v = a[i - k]; if (!ok(v)) { bad = true; break; } if (v < m) m = v; }
      if (!bad) out[i] = m;
    }
    return out;
  }
  function rollStd(a, n) {
    const m = sma(a, n), out = fill(a.length);
    for (let i = n - 1; i < a.length; i++) {
      if (!ok(m[i])) continue;
      let s = 0;
      for (let k = 0; k < n; k++) s += (a[i - k] - m[i]) ** 2;
      out[i] = Math.sqrt(s / n);
    }
    return out;
  }
  function trueRange(h, l, c) {
    return h.map((_, i) => (i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
  }
  const atr = (h, l, c, n = 14) => rma(trueRange(h, l, c), n);

  function rsi(c, n = 14) {
    const up = fill(c.length), dn = fill(c.length);
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      up[i] = Math.max(d, 0);
      dn[i] = Math.max(-d, 0);
    }
    const ru = rma(up, n), rd = rma(dn, n);
    return c.map((_, i) => (ok(ru[i]) ? (rd[i] === 0 ? 100 : 100 - 100 / (1 + ru[i] / rd[i])) : N));
  }
  function macd(c, f = 12, s = 26, sg = 9) {
    const ef = ema(c, f), es = ema(c, s);
    const line = c.map((_, i) => ef[i] - es[i]);
    const signal = ema(line, sg);
    return { line, signal, hist: line.map((v, i) => v - signal[i]) };
  }
  function stoch(h, l, c, kp = 14, dp = 3, sm = 3) {
    const hh = rollMax(h, kp), ll = rollMin(l, kp);
    const raw = c.map((_, i) => (ok(hh[i]) && hh[i] !== ll[i] ? (100 * (c[i] - ll[i])) / (hh[i] - ll[i]) : N));
    const k = sma(raw, sm);
    return { k, d: sma(k, dp) };
  }
  function stochRsi(c, n = 14, kp = 3, dp = 3) {
    const r = rsi(c, n), hh = rollMax(r, n), ll = rollMin(r, n);
    const raw = r.map((v, i) => (ok(hh[i]) && hh[i] !== ll[i] ? (100 * (v - ll[i])) / (hh[i] - ll[i]) : N));
    const k = sma(raw, kp);
    return { k, d: sma(k, dp) };
  }
  function bollinger(c, n = 20, m = 2) {
    const mid = sma(c, n), sd = rollStd(c, n);
    const upper = mid.map((v, i) => v + m * sd[i]), lower = mid.map((v, i) => v - m * sd[i]);
    return {
      mid, upper, lower,
      pctB: c.map((v, i) => (v - lower[i]) / (upper[i] - lower[i])),
      bw: mid.map((v, i) => (upper[i] - lower[i]) / v),
    };
  }
  function adx(h, l, c, n = 14) {
    const pdm = fill(h.length), mdm = fill(h.length);
    for (let i = 1; i < h.length; i++) {
      const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
      pdm[i] = up > dn && up > 0 ? up : 0;
      mdm[i] = dn > up && dn > 0 ? dn : 0;
    }
    const a = atr(h, l, c, n), sp = rma(pdm, n), sm = rma(mdm, n);
    const pdi = a.map((v, i) => (100 * sp[i]) / v), mdi = a.map((v, i) => (100 * sm[i]) / v);
    const dx = pdi.map((v, i) => (100 * Math.abs(v - mdi[i])) / (v + mdi[i] || 1));
    return { adx: rma(dx, n), pdi, mdi };
  }
  function cci(h, l, c, n = 20) {
    const tp = c.map((_, i) => (h[i] + l[i] + c[i]) / 3), m = sma(tp, n), out = fill(c.length);
    for (let i = n - 1; i < c.length; i++) {
      if (!ok(m[i])) continue;
      let md = 0;
      for (let k = 0; k < n; k++) md += Math.abs(tp[i - k] - m[i]);
      md /= n;
      out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
    }
    return out;
  }
  function williamsR(h, l, c, n = 14) {
    const hh = rollMax(h, n), ll = rollMin(l, n);
    return c.map((v, i) => (ok(hh[i]) && hh[i] !== ll[i] ? (-100 * (hh[i] - v)) / (hh[i] - ll[i]) : N));
  }
  function mfi(h, l, c, v, n = 14) {
    const tp = c.map((_, i) => (h[i] + l[i] + c[i]) / 3), out = fill(c.length);
    for (let i = n; i < c.length; i++) {
      let pos = 0, neg = 0;
      for (let k = 0; k < n; k++) {
        const j = i - k, mf = tp[j] * v[j];
        if (tp[j] > tp[j - 1]) pos += mf; else if (tp[j] < tp[j - 1]) neg += mf;
      }
      out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    }
    return out;
  }
  function obv(c, v) {
    const out = [0];
    for (let i = 1; i < c.length; i++) out.push(out[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0));
    return out;
  }
  function vwap(h, l, c, v, t) {
    const out = fill(c.length);
    let day = -1, pv = 0, vv = 0;
    for (let i = 0; i < c.length; i++) {
      const d = Math.floor(t[i] / 86400);
      if (d !== day) { day = d; pv = 0; vv = 0; }
      pv += ((h[i] + l[i] + c[i]) / 3) * v[i];
      vv += v[i];
      out[i] = vv > 0 ? pv / vv : N;
    }
    return out;
  }
  function ichimoku(h, l, c, t = 9, k = 26, b = 52) {
    const mid = (n) => { const hh = rollMax(h, n), ll = rollMin(l, n); return hh.map((v, i) => (v + ll[i]) / 2); };
    const tenkan = mid(t), kijun = mid(k), spanBraw = mid(b);
    const spanAraw = tenkan.map((v, i) => (v + kijun[i]) / 2);
    const shift = (a) => a.map((_, i) => (i - k >= 0 ? a[i - k] : N));
    return { tenkan, kijun, spanA: shift(spanAraw), spanB: shift(spanBraw) };
  }
  function supertrend(h, l, c, n = 10, m = 3) {
    const a = atr(h, l, c, n), line = fill(c.length), dir = fill(c.length);
    let fub = N, flb = N, pd = 0;
    for (let i = 0; i < c.length; i++) {
      if (!ok(a[i])) continue;
      const hl2 = (h[i] + l[i]) / 2, ub = hl2 + m * a[i], lb = hl2 - m * a[i];
      if (pd === 0) { fub = ub; flb = lb; pd = c[i] >= hl2 ? 1 : -1; }
      else {
        fub = ub < fub || c[i - 1] > fub ? ub : fub;
        flb = lb > flb || c[i - 1] < flb ? lb : flb;
        pd = pd === -1 ? (c[i] > fub ? 1 : -1) : c[i] < flb ? -1 : 1;
      }
      dir[i] = pd;
      line[i] = pd === 1 ? flb : fub;
    }
    return { line, dir };
  }
  function psar(h, l, step = 0.02, max = 0.2) {
    const n = h.length, sar = fill(n), dir = fill(n);
    if (n < 3) return { sar, dir };
    let bull = true, af = step, ep = h[0], cur = l[0];
    sar[0] = cur; dir[0] = 1;
    for (let i = 1; i < n; i++) {
      cur = cur + af * (ep - cur);
      if (bull) {
        cur = Math.min(cur, l[i - 1], i >= 2 ? l[i - 2] : l[i - 1]);
        if (l[i] < cur) { bull = false; cur = ep; ep = l[i]; af = step; }
        else if (h[i] > ep) { ep = h[i]; af = Math.min(af + step, max); }
      } else {
        cur = Math.max(cur, h[i - 1], i >= 2 ? h[i - 2] : h[i - 1]);
        if (h[i] > cur) { bull = true; cur = ep; ep = h[i]; af = step; }
        else if (l[i] < ep) { ep = l[i]; af = Math.min(af + step, max); }
      }
      sar[i] = cur; dir[i] = bull ? 1 : -1;
    }
    return { sar, dir };
  }
  function keltner(h, l, c, n = 20, m = 2, an = 10) {
    const mid = ema(c, n), a = atr(h, l, c, an);
    return { mid, upper: mid.map((v, i) => v + m * a[i]), lower: mid.map((v, i) => v - m * a[i]) };
  }
  function donchian(h, l, n = 20) {
    const upper = rollMax(h, n), lower = rollMin(l, n);
    return { upper, lower, mid: upper.map((v, i) => (v + lower[i]) / 2) };
  }
  const roc = (c, n = 12) => c.map((v, i) => (i >= n ? (100 * (v - c[i - n])) / c[i - n] : N));
  const momentum = (c, n = 10) => c.map((v, i) => (i >= n ? v - c[i - n] : N));
  function aroon(h, l, n = 25) {
    const up = fill(h.length), down = fill(h.length);
    for (let i = n; i < h.length; i++) {
      let hi = i, lo = i;
      for (let k = 0; k <= n; k++) {
        if (h[i - k] > h[hi]) hi = i - k;
        if (l[i - k] < l[lo]) lo = i - k;
      }
      up[i] = (100 * (n - (i - hi))) / n;
      down[i] = (100 * (n - (i - lo))) / n;
    }
    return { up, down };
  }
  function awesome(h, l) {
    const m = h.map((v, i) => (v + l[i]) / 2), a = sma(m, 5), b = sma(m, 34);
    return a.map((v, i) => v - b[i]);
  }
  function cmf(h, l, c, v, n = 20) {
    const mfv = c.map((_, i) => (h[i] === l[i] ? 0 : (((c[i] - l[i]) - (h[i] - c[i])) / (h[i] - l[i])) * v[i])), out = fill(c.length);
    for (let i = n - 1; i < c.length; i++) {
      let a = 0, b = 0;
      for (let k = 0; k < n; k++) { a += mfv[i - k]; b += v[i - k]; }
      out[i] = b > 0 ? a / b : N;
    }
    return out;
  }
  function trix(c, n = 15) {
    const e = ema(ema(ema(c, n), n), n);
    return e.map((v, i) => (i > 0 && ok(e[i - 1]) ? (100 * (v - e[i - 1])) / e[i - 1] : N));
  }
  function ultimate(h, l, c) {
    const bp = [], tr = [];
    for (let i = 0; i < c.length; i++) {
      const pc = i === 0 ? c[0] : c[i - 1];
      bp.push(c[i] - Math.min(l[i], pc));
      tr.push(Math.max(h[i], pc) - Math.min(l[i], pc));
    }
    const sum = (a, n, i) => { let s = 0; for (let k = 0; k < n; k++) s += a[i - k]; return s; };
    return c.map((_, i) => {
      if (i < 27) return N;
      const a1 = sum(bp, 7, i) / (sum(tr, 7, i) || 1), a2 = sum(bp, 14, i) / (sum(tr, 14, i) || 1), a3 = sum(bp, 28, i) / (sum(tr, 28, i) || 1);
      return (100 * (4 * a1 + 2 * a2 + a3)) / 7;
    });
  }
  function forceIndex(c, v, n = 13) {
    return ema(c.map((x, i) => (i === 0 ? N : (x - c[i - 1]) * v[i])), n);
  }

  FA.ind = {
    ok, sma, ema, rma, wma, hma, rollMax, rollMin, rollStd, trueRange, atr, rsi, macd, stoch, stochRsi,
    bollinger, adx, cci, williamsR, mfi, obv, vwap, ichimoku, supertrend, psar, keltner, donchian,
    roc, momentum, aroon, awesome, cmf, trix, ultimate, forceIndex,
  };
})(typeof window !== "undefined" ? window : globalThis);
