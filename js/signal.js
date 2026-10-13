/* Fandamental — signal engine.
   Combines ~30 indicators + price action (+ optional AI fundamental bias) into a direction,
   a "confluence" score (how many independent signals agree — NOT a probability), and a trade plan. */
(function (g) {
  const FA = (g.FA = g.FA || {});
  const I = FA.ind, P = FA.pa, ok = I.ok;
  const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

  function digitsFor(p) { return p >= 1000 ? 2 : p >= 100 ? 3 : p >= 10 ? 4 : p >= 1 ? 5 : 6; }
  function fmt(x, ref) { return ok(x) ? x.toFixed(digitsFor(ref === undefined ? Math.abs(x) : ref)) : "—"; }
  function verdict(s) { return s > 0.25 ? "buy" : s < -0.25 ? "sell" : "neutral"; }

  function buildSeries(c) {
    const t = c.map((x) => x.t), h = c.map((x) => x.h), l = c.map((x) => x.l), cl = c.map((x) => x.c), v = c.map((x) => x.v || 0);
    const hasVol = v.reduce((a, b) => a + b, 0) > 0;
    const S = { t, h, l, c: cl, v, hasVol };
    S.ema20 = I.ema(cl, 20); S.ema50 = I.ema(cl, 50); S.ema100 = I.ema(cl, 100); S.ema200 = I.ema(cl, 200);
    S.sma20 = I.sma(cl, 20); S.sma50 = I.sma(cl, 50); S.sma200 = I.sma(cl, 200); S.ema13 = I.ema(cl, 13); S.hma = I.hma(cl, 21);
    S.rsi = I.rsi(cl, 14); S.macd = I.macd(cl); S.stoch = I.stoch(h, l, cl); S.stochRsi = I.stochRsi(cl);
    S.bb = I.bollinger(cl); S.atr = I.atr(h, l, cl, 14); S.adx = I.adx(h, l, cl);
    S.cci = I.cci(h, l, cl); S.wr = I.williamsR(h, l, cl); S.ichi = I.ichimoku(h, l, cl);
    S.st = I.supertrend(h, l, cl); S.psar = I.psar(h, l); S.kc = I.keltner(h, l, cl); S.dc = I.donchian(h, l);
    S.roc = I.roc(cl); S.mom = I.momentum(cl); S.aroon = I.aroon(h, l); S.ao = I.awesome(h, l);
    S.trix = I.trix(cl); S.uo = I.ultimate(h, l, cl);
    if (hasVol) {
      S.mfi = I.mfi(h, l, cl, v); S.obv = I.obv(cl, v); S.obvMa = I.sma(S.obv, 20); S.cmf = I.cmf(h, l, cl, v);
      S.fi = I.forceIndex(cl, v); S.vwap = I.vwap(h, l, cl, v, t);
    }
    return S;
  }

  function analyze(candles, opt = {}) {
    const c = candles, n = c.length;
    if (n < 60) return { error: "تعداد کندل کافی نیست (حداقل ۶۰ کندل لازم است)." };
    const S = buildSeries(c), i = n - 1, price = S.c[i], A = S.atr[i];
    const items = [];
    const add = (key, name, group, value, score, w) => {
      if (!ok(score)) return;
      items.push({ key, name, group, value, score: clamp(score), w, verdict: verdict(score) });
    };
    const f = (x) => fmt(x, price);
    const f2 = (x) => (ok(x) ? x.toFixed(2) : "—");

    /* ---------- trend ---------- */
    {
      const es = [S.ema20[i], S.ema50[i], S.ema200[i]].filter(ok);
      let s = 0; es.forEach((e) => (s += price > e ? 1 : -1));
      const stack = (S.ema20[i] > S.ema50[i] ? 1 : -1) + (ok(S.ema200[i]) ? (S.ema50[i] > S.ema200[i] ? 1 : -1) : 0);
      add("ema", "EMA 20/50/200", "trend", `${f(S.ema20[i])} / ${f(S.ema50[i])} / ${f(S.ema200[i])}`, (s / es.length) * 0.6 + (stack / (ok(S.ema200[i]) ? 2 : 1)) * 0.4, 1.6);
      add("hma", "Hull MA 21", "trend", f(S.hma[i]), (price > S.hma[i] ? 0.4 : -0.4) + (S.hma[i] > S.hma[i - 1] ? 0.3 : -0.3), 1);
    }
    { const m = S.macd; add("macd", "MACD (12,26,9)", "trend", `${f2(m.line[i])} / ${f2(m.signal[i])}`, (m.line[i] > m.signal[i] ? 0.5 : -0.5) + (m.hist[i] > m.hist[i - 1] ? 0.3 : -0.3) + (m.line[i] > 0 ? 0.2 : -0.2), 1.5); }
    { const a = S.adx; add("adx", "ADX / DI", "trend", `ADX ${f2(a.adx[i])} (+${f2(a.pdi[i])}/-${f2(a.mdi[i])})`, sgn(a.pdi[i] - a.mdi[i]) * (a.adx[i] >= 20 ? 1 : 0.4), 1.5); }
    {
      const k = S.ichi, top = Math.max(k.spanA[i], k.spanB[i]), bot = Math.min(k.spanA[i], k.spanB[i]);
      if (ok(top)) add("ichi", "Ichimoku", "trend", price > top ? "بالای ابر" : price < bot ? "زیر ابر" : "داخل ابر", (price > top ? 0.7 : price < bot ? -0.7 : 0) + (k.tenkan[i] > k.kijun[i] ? 0.3 : -0.3), 1.5);
    }
    add("cross", "SMA 50/200", "trend", ok(S.sma200[i]) ? (S.sma50[i] > S.sma200[i] ? "ناحیه‌ی Golden Cross" : "ناحیه‌ی Death Cross") : "—", ok(S.sma200[i]) ? (S.sma50[i] > S.sma200[i] ? 0.6 : -0.6) : NaN, 1);
    add("st", "Supertrend (10,3)", "trend", S.st.dir[i] === 1 ? "صعودی" : "نزولی", S.st.dir[i], 1.4);
    add("psar", "Parabolic SAR", "trend", S.psar.dir[i] === 1 ? "صعودی" : "نزولی", S.psar.dir[i] * 0.8, 1);
    add("aroon", "Aroon (25)", "trend", `${f2(S.aroon.up[i])} / ${f2(S.aroon.down[i])}`, (S.aroon.up[i] - S.aroon.down[i]) / 100, 1);
    {
      const d = S.dc, pos = (price - d.lower[i]) / (d.upper[i] - d.lower[i]);
      add("dc", "Donchian (20)", "trend", `${(pos * 100).toFixed(0)}% از کانال`, (pos - 0.5) * 1.6, 0.9);
      const k = S.kc;
      add("kc", "Keltner Channel", "trend", price > k.upper[i] ? "شکست بالا" : price < k.lower[i] ? "شکست پایین" : "داخل کانال", price > k.upper[i] ? 0.8 : price < k.lower[i] ? -0.8 : ((price - k.mid[i]) / (k.upper[i] - k.mid[i])) * 0.5, 0.9);
    }

    /* ---------- oscillators / momentum ---------- */
    { const r = S.rsi[i]; add("rsi", "RSI (14)", "osc", f2(r), r < 30 ? 0.7 : r > 70 ? -0.7 : clamp((r - 50) / 30, -0.6, 0.6), 1.2); }
    { const k = S.stoch.k[i], d = S.stoch.d[i]; add("stoch", "Stochastic (14,3,3)", "osc", `${f2(k)} / ${f2(d)}`, k < 20 && k > d ? 0.8 : k > 80 && k < d ? -0.8 : sgn(k - d) * 0.4, 1); }
    { const k = S.stochRsi.k[i], d = S.stochRsi.d[i]; add("srsi", "Stoch RSI", "osc", `${f2(k)} / ${f2(d)}`, k < 20 && k > d ? 0.8 : k > 80 && k < d ? -0.8 : sgn(k - d) * 0.4, 0.9); }
    { const x = S.cci[i]; add("cci", "CCI (20)", "osc", f2(x), x < -100 && x > S.cci[i - 1] ? 0.7 : x > 100 && x < S.cci[i - 1] ? -0.7 : clamp(x / 200, -0.5, 0.5), 1); }
    { const x = S.wr[i]; add("wr", "Williams %R", "osc", f2(x), x < -80 ? 0.5 : x > -20 ? -0.5 : 0, 0.8); }
    { const b = S.bb, x = b.pctB[i]; add("bb", "Bollinger Bands", "osc", `%B ${f2(x)}`, x < 0 ? 0.5 : x > 1 ? -0.5 : (x - 0.5) * 0.8, 1); }
    { const bull = S.h[i] - S.ema13[i], bear = S.l[i] - S.ema13[i]; add("elder", "Elder Ray (13)", "osc", `${f2(bull)} / ${f2(bear)}`, (bull > 0 ? 0.3 : -0.3) + (bear > 0 ? 0.3 : -0.3) + (bear > S.l[i - 1] - S.ema13[i - 1] ? 0.2 : -0.2), 0.8); }
    add("roc", "ROC (12)", "osc", f2(S.roc[i]), sgn(S.roc[i]) * 0.5, 0.8);
    add("mom", "Momentum (10)", "osc", f(S.mom[i]), sgn(S.mom[i]) * 0.5, 0.7);
    add("ao", "Awesome Oscillator", "osc", f2(S.ao[i]), (S.ao[i] > 0 ? 0.4 : -0.4) + (S.ao[i] > S.ao[i - 1] ? 0.3 : -0.3), 0.9);
    add("trix", "TRIX (15)", "osc", S.trix[i] === S.trix[i] ? S.trix[i].toFixed(4) : "—", sgn(S.trix[i]) * 0.5, 0.7);
    { const x = S.uo[i]; add("uo", "Ultimate Oscillator", "osc", f2(x), x < 30 ? 0.6 : x > 70 ? -0.6 : ((x - 50) / 50) * 0.5, 0.8); }

    /* ---------- volume (only when the data source provides real volume) ---------- */
    if (S.hasVol) {
      { const x = S.mfi[i]; add("mfi", "MFI (14)", "vol", f2(x), x < 20 ? 0.6 : x > 80 ? -0.6 : (x - 50) / 60, 0.9); }
      add("obv", "OBV", "vol", S.obv[i].toFixed(0), S.obv[i] > S.obvMa[i] ? 0.5 : -0.5, 0.8);
      add("cmf", "Chaikin Money Flow", "vol", f2(S.cmf[i]), clamp(S.cmf[i] * 4), 0.8);
      add("fi", "Force Index (13)", "vol", S.fi[i].toFixed(0), sgn(S.fi[i]) * 0.5, 0.7);
      add("vwap", "VWAP (daily)", "vol", f(S.vwap[i]), price > S.vwap[i] ? 0.5 : -0.5, 0.9);
    }

    const sumScore = (arr) => { const w = arr.reduce((a, x) => a + x.w, 0); return w ? arr.reduce((a, x) => a + x.w * x.score, 0) / w : 0; };
    const tech = sumScore(items);

    /* ---------- price action ---------- */
    const sw = P.swings(c), st = P.structure(sw, c), lv = P.levels(c, sw, A), pats = P.patterns(c), fib = P.fibonacci(sw), piv = P.pivots(c);
    const paItems = [];
    const addPA = (key, name, value, score, w, note) => paItems.push({ key, name, group: "pa", value, score: clamp(score), w, verdict: verdict(score), note });
    {
      let s = st.trend === "up" ? 1 : st.trend === "down" ? -1 : 0;
      if (st.bos === "up") s += 0.5; if (st.bos === "down") s -= 0.5;
      addPA("structure", "ساختار بازار", st.trend === "up" ? "HH/HL (روند صعودی)" : st.trend === "down" ? "LH/LL (روند نزولی)" : "رنج / نامشخص", s, 1.5);
    }
    const sups = lv.filter((x) => x.price < price).sort((a, b) => b.price - a.price), ress = lv.filter((x) => x.price > price).sort((a, b) => a.price - b.price);
    {
      const ds = sups.length ? (price - sups[0].price) / A : Infinity, dr = ress.length ? (ress[0].price - price) / A : Infinity;
      let s = 0, txt = "فاصله از سطوح کلیدی";
      if (ds <= 0.8 && ds <= dr) { s = sups[0].touches >= 3 ? 0.8 : 0.6; txt = `نزدیک حمایت ${f(sups[0].price)}`; }
      else if (dr <= 0.8) { s = ress[0].touches >= 3 ? -0.8 : -0.6; txt = `نزدیک مقاومت ${f(ress[0].price)}`; }
      const ref = c[Math.max(0, i - 3)].c;
      for (const L of lv) {
        if (ref < L.price && price > L.price + 0.1 * A) { s = 0.7; txt = `شکست مقاومت ${f(L.price)}`; break; }
        if (ref > L.price && price < L.price - 0.1 * A) { s = -0.7; txt = `شکست حمایت ${f(L.price)}`; break; }
      }
      addPA("levels", "حمایت/مقاومت", txt, s, 1.2);
    }
    {
      let s = 0; const names = [];
      for (const p of pats.filter((x) => x.i >= n - 2 && x.dir !== 0)) {
        const near = lv.some((L) => Math.abs(L.price - price) <= A && ((p.dir === 1 && L.type === "support") || (p.dir === -1 && L.type === "resistance")));
        s += p.dir * p.strength * (near ? 1.3 : 1);
        names.push(p.fa);
      }
      addPA("candles", "الگوهای کندلی", names.length ? names.join("، ") : "الگوی مهمی نیست", s, 1);
    }
    if (fib) {
      const lvl = (r) => fib.levels.find((x) => x.r === r).price;
      const a = lvl(0.382), b = lvl(0.618);
      const inZone = price >= Math.min(a, b) && price <= Math.max(a, b);
      let s = 0;
      if (inZone && fib.dir === "up" && st.trend === "up") s = 0.6;
      if (inZone && fib.dir === "down" && st.trend === "down") s = -0.6;
      addPA("fib", "فیبوناچی (اصلاح 38–62%)", inZone ? "قیمت داخل ناحیه‌ی طلایی" : "خارج از ناحیه", s, 0.8);
    }
    if (piv) addPA("pivot", "پیوت کلاسیک", `P=${f(piv.P)}`, price > piv.P ? 0.3 : -0.3, 0.5);
    const pa = sumScore(paItems);

    /* ---------- fundamentals (optional, supplied by the AI module) ---------- */
    const fund = opt.fund && ok(opt.fund.score) ? opt.fund : null;
    const wT = 0.4, wP = 0.35, wF = fund ? 0.25 * clamp((fund.confidence || 50) / 100, 0, 1) : 0;
    const S_all = (wT * tech + wP * pa + (fund ? wF * fund.score : 0)) / (wT + wP + wF);
    const groups = [{ s: tech, w: wT }, { s: pa, w: wP }]; if (fund) groups.push({ s: fund.score, w: wF });
    const dirSign = sgn(S_all);
    const groupAgree = groups.reduce((a, x) => a + (sgn(x.s) === dirSign && Math.abs(x.s) >= 0.1 ? x.w : 0), 0) / groups.reduce((a, x) => a + x.w, 0);
    const all = items.concat(paItems), voters = all.filter((x) => Math.abs(x.score) >= 0.1);
    const indAgree = voters.length ? voters.filter((x) => sgn(x.score) === dirSign).length / voters.length : 0;
    let confluence = Math.round(100 * (0.35 * groupAgree + 0.25 * indAgree + 0.4 * Math.min(1, Math.abs(S_all) / 0.5)));
    let direction = S_all > 0.12 ? "long" : S_all < -0.12 ? "short" : "none";
    if (direction === "none") confluence = Math.min(confluence, 45);
    const buys = all.filter((x) => x.verdict === "buy").length, sells = all.filter((x) => x.verdict === "sell").length;

    /* ---------- trade plan ---------- */
    let plan = null;
    if (direction !== "none" && ok(A) && A > 0) plan = buildPlan(direction, price, A, lv, st, fib, S.ema20[i], !!opt.marketEntry);

    const warnings = [];
    if (S.adx.adx[i] < 18) warnings.push("ADX پایین است؛ بازار رنج/بی‌روند است و سیگنال‌های روندی قابل‌اعتماد نیستند.");
    if (!S.hasVol) warnings.push("منبع داده حجم واقعی ندارد؛ اندیکاتورهای حجمی در محاسبه نیامده‌اند.");
    if (!fund) warnings.push("تحلیل فاندامنتال AI اجرا نشده؛ فقط تکنیکال + پرایس‌اکشن لحاظ شده است.");
    if (Math.sign(tech) !== 0 && Math.sign(pa) !== 0 && Math.sign(tech) !== Math.sign(pa)) warnings.push("تکنیکال و پرایس‌اکشن هم‌جهت نیستند (واگرایی سیگنال).");
    if (fund && Math.sign(fund.score) !== 0 && dirSign !== 0 && Math.sign(fund.score) !== dirSign) warnings.push("جهت فاندامنتال مخالف جهت تکنیکال/پرایس‌اکشن است.");
    if (plan && plan.rr[0] < 1.2) warnings.push("نسبت ریسک به ریوارد تارگت اول ضعیف است.");

    const threshold = opt.threshold || 70;
    const tradeable = direction !== "none" && confluence >= threshold && !!plan && plan.rr[0] >= 1.2;

    return {
      price, atr: A, direction, confluence, tradeable, threshold, score: S_all,
      tech, pa, fund, plan, warnings, items, paItems, buys, sells,
      pa_data: { sw, st, levels: lv, patterns: pats, fib, pivots: piv, sups, ress },
      series: S, count: n, lastTime: c[i].t,
    };
  }

  function buildPlan(dir, price, A, lv, st, fib, ema20, market) {
    const s = dir === "long" ? 1 : -1;
    const cands = [ema20, ...lv.map((l) => l.price)];
    if (fib) fib.levels.filter((x) => x.r === 0.5 || x.r === 0.618).forEach((x) => cands.push(x.price));
    const pull = cands.filter((p) => ok(p) && s * (price - p) >= 0.25 * A && s * (price - p) <= 1.3 * A).sort((a, b) => Math.abs(price - a) - Math.abs(price - b));
    const limit = pull.length && !market ? pull[0] : null;
    const entry = limit !== null ? limit : price;
    // stop: behind the nearest structure on the other side, bounded to 1.0–2.5 ATR
    const behind = lv.map((l) => l.price).concat([st.lastLow && s === 1 ? st.lastLow.p : null, st.lastHigh && s === -1 ? st.lastHigh.p : null].filter(ok))
      .filter((p) => s * (entry - p) > 0.1 * A).sort((a, b) => Math.abs(entry - a) - Math.abs(entry - b));
    let dist = behind.length ? Math.abs(entry - behind[0]) + 0.3 * A : 1.5 * A;
    dist = clamp(dist, 1.0 * A, 2.5 * A);
    const sl = entry - s * dist;
    const ahead = lv.map((l) => l.price).filter((p) => s * (p - entry) >= 1.0 * dist).sort((a, b) => Math.abs(a - entry) - Math.abs(b - entry));
    let tp1 = ahead.find((p) => s * (p - entry) >= 1.2 * dist && s * (p - entry) <= 3 * dist);
    if (tp1 === undefined) tp1 = entry + s * 1.5 * dist;
    let tp2 = ahead.find((p) => s * (p - tp1) >= 0.7 * dist);
    if (tp2 === undefined) tp2 = entry + s * 2.5 * dist;
    let tp3 = entry + s * 4 * dist;
    if (s * (tp3 - tp2) < 0.5 * dist) tp3 = tp2 + s * dist;
    const tps = [tp1, tp2, tp3];
    return {
      side: dir, entry, entryZone: [entry - 0.15 * A, entry + 0.15 * A], isLimit: limit !== null, market: price, sl, risk: dist, tps,
      rr: tps.map((t) => (s * (t - entry)) / dist),
    };
  }

  FA.signal = { analyze, buildSeries, fmt, digitsFor, verdict };
})(typeof window !== "undefined" ? window : globalThis);
