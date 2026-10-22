/* Fandamental — setups engine: trading styles and classic price-action / smart-money setups as explicit,
   testable rules.

   Families
     trend     trendlines: pullback to an up-trendline, break of an up-trendline,
               rejection at a down-trendline, break of a down-trendline, triangle (converging lines)
     sr        support bounce, resistance rejection, breakout + retest (role reversal)
     range     rectangle: trade inside the box, rectangle breakout (volume-confirmed when volume exists)
     smc       BOS / CHoCH, order block retest, fair value gap (FVG) fill, liquidity sweep
     cont      continuation structures: bull / bear flag
     rev       reversal structures: double top / bottom, head & shoulders / inverse

   No look-ahead: every rule only reads candles up to the last one, and swing points are used only once
   they are confirmed (FA.pa.swings needs 3 bars on each side). Every setup has a stop and a target, so
   it can be back-tested on its own (FA.setups.backtest) before anybody relies on it.
   Nothing here is a profit guarantee; the backtest tab shows how each setup really did. */
(function (g) {
  "use strict";
  const FA = (g.FA = g.FA || {});
  const ok = (x) => typeof x === "number" && isFinite(x);
  const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));

  const FAMILY = {
    trend: "خط روند", sr: "حمایت و مقاومت", range: "روند خنثی / مستطیل", smc: "اسمارت مانی", cont: "ساختار ادامه‌دهنده", rev: "ساختار برگشتی",
  };
  const NAMES = {
    tl_up_pullback: "پولبک به خط روند صعودی", tl_up_break: "شکست خط روند صعودی",
    tl_dn_pullback: "برگشت قیمت به خط روند نزولی", tl_dn_break: "شکست خط روند نزولی",
    tri_break_up: "شکست مثلث به بالا", tri_break_dn: "شکست مثلث به پایین",
    sr_support: "برگشت از ناحیه‌ی حمایت", sr_resistance: "برگشت از ناحیه‌ی مقاومت",
    sr_retest_up: "شکست مقاومت و پولبک (تبدیل به حمایت)", sr_retest_dn: "شکست حمایت و پولبک (تبدیل به مقاومت)",
    rect_in_long: "خرید در کف مستطیل", rect_in_short: "فروش در سقف مستطیل",
    rect_break_up: "شکست مستطیل به بالا", rect_break_dn: "شکست مستطیل به پایین",
    smc_bos_up: "شکست ساختار صعودی (BOS)", smc_bos_dn: "شکست ساختار نزولی (BOS)",
    smc_choch_up: "تغییر کاراکتر به صعودی (CHoCH)", smc_choch_dn: "تغییر کاراکتر به نزولی (CHoCH)",
    smc_ob_long: "برگشت به اوردر بلاک صعودی", smc_ob_short: "برگشت به اوردر بلاک نزولی",
    smc_fvg_long: "پر شدن FVG صعودی", smc_fvg_short: "پر شدن FVG نزولی",
    smc_sweep_long: "جمع‌آوری نقدینگی زیر کف (Sweep)", smc_sweep_short: "جمع‌آوری نقدینگی بالای سقف (Sweep)",
    flag_bull: "پرچم صعودی (ادامه‌دهنده)", flag_bear: "پرچم نزولی (ادامه‌دهنده)",
    dbl_bottom: "کف دوقلو (برگشتی نزولی به صعودی)", dbl_top: "سقف دوقلو (برگشتی صعودی به نزولی)",
    hs_top: "سر و شانه (برگشتی صعودی به نزولی)", hs_bottom: "سر و شانه‌ی معکوس (برگشتی نزولی به صعودی)",
  };
  const FAMILY_OF = (key) => (key.startsWith("tl_") || key.startsWith("tri_") ? "trend" : key.startsWith("sr_") ? "sr" : key.startsWith("rect_") ? "range"
    : key.startsWith("smc_") ? "smc" : key.startsWith("flag_") ? "cont" : "rev");

  /* Trading styles → which timeframe to enter on and which higher timeframes to confirm with. */
  const STYLES = {
    scalp: { name: "اسکالپ", entry: ["5m"], confirm: ["15m", "1h"], hold: "چند دقیقه تا حداکثر یک ساعت", note: "معاملات زیاد و سود کم در هر معامله؛ اسپرد و کارمزد سهم بزرگی از سود را می‌خورد و تمرکز کامل لازم است." },
    day: { name: "ترید روزانه", entry: ["15m", "1h"], confirm: ["4h"], hold: "داخل همان روز (پوزیشن شب باز نمی‌ماند)", note: "روند تایم ۴ ساعته جهت را تعیین می‌کند و ورود روی ۱۵ دقیقه/۱ ساعته است." },
    swing: { name: "سوئینگ", entry: ["1h", "4h"], confirm: ["1d"], hold: "چند روز تا چند هفته", note: "روی موج‌های بازار معامله می‌کند؛ حد ضرر بزرگ‌تر و حجم کمتر، مناسب کسی که تمام‌وقت پای چارت نیست." },
    position: { name: "پوزیشن تریدینگ", entry: ["1d"], confirm: [], hold: "چند هفته تا چند ماه", note: "روند بلندمدت + تحلیل بنیادی؛ تایم هفتگی برای تأیید در منابع رایگان اپ موجود نیست." },
  };

  /* ------------------------------------------------------------ context */
  function context(c, opt = {}) {
    const n = c.length, i = n - 1;
    const I = FA.ind, P = FA.pa;
    const h = c.map((x) => x.h), l = c.map((x) => x.l), cl = c.map((x) => x.c), v = c.map((x) => x.v || 0);
    const atrArr = opt.atrArr || I.atr(h, l, cl, 14);
    const A = ok(opt.atr) ? opt.atr : atrArr[i];
    const sw = opt.sw || P.swings(c);
    const st = opt.st || P.structure(sw, c);
    const lv = opt.levels || P.levels(c, sw, A);
    const pats = opt.patterns || P.patterns(c);
    const hasVol = v.reduce((a, b) => a + b, 0) > 0;
    let volAvg = null;
    if (hasVol && n > 21) { let s = 0; for (let k = i - 20; k < i; k++) s += v[k]; volAvg = s / 20; }
    return { c, n, i, A, sw, st, lv, pats, hasVol, volAvg, v };
  }

  /* ------------------------------------------------------------ helpers */
  /** Trade plan from an entry, a stop (or a list of stops: structural first, then closer fallbacks) and a target. */
  function plan(dir, entry, sl, tpCand, A) {
    if (Array.isArray(sl)) {
      for (const s of sl) { const p = plan(dir, entry, s, tpCand, A); if (p) return p; }
      return null;
    }
    let risk = Math.abs(entry - sl);
    if (!ok(risk) || !ok(entry) || dir * (entry - sl) <= 0) return null;
    if (risk < 0.5 * A) { sl = entry - dir * 0.5 * A; risk = 0.5 * A; }
    if (risk > 3.5 * A) return null;                       // stop too far from the setup → not a clean trade
    let tp = ok(tpCand) && dir * (tpCand - entry) >= 1.2 * risk ? tpCand : entry + dir * 2 * risk;
    return { side: dir === 1 ? "long" : "short", entry, sl, tp, risk, rr: (dir * (tp - entry)) / risk };
  }
  const bodyInfo = (x) => { const r = x.h - x.l, b = Math.abs(x.c - x.o); return { r, b, up: x.h - Math.max(x.o, x.c), lo: Math.min(x.o, x.c) - x.l, bull: x.c > x.o, bear: x.c < x.o }; };
  const nextAbove = (lv, p) => lv.filter((L) => L.price > p).sort((a, b) => a.price - b.price)[0];
  const nextBelow = (lv, p) => lv.filter((L) => L.price < p).sort((a, b) => b.price - a.price)[0];

  /** Best trendline through confirmed swing points (kind "up" on lows, "down" on highs), valid up to bar i-1. */
  function trendline(ctx, kind) {
    const { c, i, A, sw } = ctx, pts = (kind === "up" ? sw.lows : sw.highs).slice(-7), s = kind === "up" ? 1 : -1;
    let best = null;
    for (let b = pts.length - 1; b >= Math.max(1, pts.length - 2); b--) {
      for (let a = b - 1; a >= 0; a--) {
        const P1 = pts[a], P2 = pts[b];
        if (P2.i - P1.i < 5 || s * (P2.p - P1.p) <= 0) continue;
        const slope = (P2.p - P1.p) / (P2.i - P1.i);
        if (Math.abs(slope) > 1.5 * A) continue;
        const at = (k) => P1.p + slope * (k - P1.i);
        let valid = true;
        for (let k = P1.i + 1; k <= i - 1; k++) if (s * (c[k].c - at(k)) < -0.25 * A) { valid = false; break; }
        if (!valid) continue;
        const touches = pts.filter((q) => q.i >= P1.i && Math.abs(q.p - at(q.i)) <= 0.35 * A).length;
        const cand = { kind, i1: P1.i, p1: P1.p, i2: P2.i, p2: P2.p, slope, at, touches };
        if (!best || touches > best.touches || (touches === best.touches && P1.i > best.i1)) best = cand;
      }
    }
    return best;
  }

  /** Rectangle (range) over the bars before the current one. */
  function rectangle(ctx) {
    const { c, i, A, sw } = ctx, W = 40, from = Math.max(0, i - W);
    if (i - from < 20) return null;
    let top = -Infinity, bot = Infinity;
    for (let k = from; k <= i - 1; k++) { top = Math.max(top, c[k].h); bot = Math.min(bot, c[k].l); }
    const hgt = top - bot;
    if (hgt < 2 * A || hgt > 10 * A) return null;
    const hs = sw.highs.filter((q) => q.i >= from && q.i <= i - 1 && top - q.p <= 0.5 * A).length;
    const ls = sw.lows.filter((q) => q.i >= from && q.i <= i - 1 && q.p - bot <= 0.5 * A).length;
    if (hs < 2 || ls < 2) return null;
    return { from, to: i - 1, top, bot, height: hgt, mid: (top + bot) / 2, touchesTop: hs, touchesBot: ls };
  }

  /* ------------------------------------------------------------ detection */
  function detect(c, opt = {}) {
    if (!c || c.length < 60) return { setups: [], info: [], drawings: [], error: "کندل کافی نیست" };
    const ctx = context(c, opt), { i, A, sw, st, lv, pats } = ctx;
    const x = c[i], px = c[i - 1], B = bodyInfo(x), out = [], info = [], drawings = [];
    if (!ok(A) || A <= 0) return { setups: [], info: [], drawings: [], error: "ATR نامعتبر" };
    const add = (key, dir, strength, p, why) => { if (p) out.push({ key, family: FAMILY_OF(key), name: NAMES[key], dir, strength, plan: p, why }); };
    const patNow = pats.filter((p) => p.i >= i - 1 && p.dir !== 0);
    const bullCandle = patNow.some((p) => p.dir === 1) || (B.lo >= 0.5 * B.r && x.c > x.o) || (B.bull && B.b > 0.5 * B.r);
    const bearCandle = patNow.some((p) => p.dir === -1) || (B.up >= 0.5 * B.r && x.c < x.o) || (B.bear && B.b > 0.5 * B.r);
    const lastH = sw.highs[sw.highs.length - 1], lastL = sw.lows[sw.lows.length - 1];

    /* ---- trendlines (up / down / triangle) */
    const up = trendline(ctx, "up"), dn = trendline(ctx, "down");
    const tri = up && dn && up.i1 > i - 120 && dn.i1 > i - 120 && up.at(i) < dn.at(i) && (dn.at(i) - up.at(i)) < (dn.at(Math.max(up.i1, dn.i1)) - up.at(Math.max(up.i1, dn.i1)));
    if (up) {
      const v = up.at(i), vp = up.at(i - 1);
      drawings.push({ type: "line", i1: up.i1, p1: up.p1, i2: i, p2: v, color: "#2ebd85", label: `خط روند صعودی (${up.touches} برخورد)` });
      info.push({ family: "trend", text: `خط روند صعودی معتبر با ${up.touches} برخورد؛ مقدار فعلی ${fmt(v)}` });
      if (x.l <= v + 0.3 * A && x.c > v && px.c >= vp - 0.15 * A && bullCandle)
        add("tl_up_pullback", 1, 0.7, plan(1, x.c, Math.min(x.l, v) - 0.4 * A, lastH && lastH.p > x.c ? lastH.p : null, A), `کف کندل به خط روند صعودی (${fmt(v)}) رسید و با کندل صعودی بالای آن بسته شد.`);
      if (x.c < v - 0.15 * A && px.c >= vp - 0.15 * A) {
        const k = tri ? "tri_break_dn" : "tl_up_break", sup = nextBelow(lv, x.c);
        add(k, -1, tri ? 0.8 : 0.6, plan(-1, x.c, Math.max(x.h, v) + 0.3 * A, sup && sup.price, A), `کندل با فاصله زیر خط روند صعودی (${fmt(v)}) بسته شد${tri ? " (ضلع پایین مثلث)" : ""}؛ نشانه‌ی ضعف روند صعودی.`);
      }
    }
    if (dn) {
      const v = dn.at(i), vp = dn.at(i - 1);
      drawings.push({ type: "line", i1: dn.i1, p1: dn.p1, i2: i, p2: v, color: "#f6465d", label: `خط روند نزولی (${dn.touches} برخورد)` });
      info.push({ family: "trend", text: `خط روند نزولی معتبر با ${dn.touches} برخورد؛ مقدار فعلی ${fmt(v)}` });
      if (x.h >= v - 0.3 * A && x.c < v && px.c <= vp + 0.15 * A && bearCandle)
        add("tl_dn_pullback", -1, 0.7, plan(-1, x.c, Math.max(x.h, v) + 0.4 * A, lastL && lastL.p < x.c ? lastL.p : null, A), `سقف کندل به خط روند نزولی (${fmt(v)}) رسید و با کندل نزولی زیر آن بسته شد.`);
      if (x.c > v + 0.15 * A && px.c <= vp + 0.15 * A) {
        const k = tri ? "tri_break_up" : "tl_dn_break", res = nextAbove(lv, x.c);
        add(k, 1, tri ? 0.8 : 0.6, plan(1, x.c, Math.min(x.l, v) - 0.3 * A, res && res.price, A), `کندل با فاصله بالای خط روند نزولی (${fmt(v)}) بسته شد${tri ? " (ضلع بالای مثلث)" : ""}؛ نشانه‌ی پایان روند نزولی.`);
      }
    }
    if (tri) info.push({ family: "trend", text: "دو خط روند همگرا: الگوی مثلث (شکست هر ضلع، ستاپ «شکست مثلث» است)." });

    /* ---- support / resistance zones */
    const sup = lv.filter((L) => L.price <= x.c + 0.3 * A).sort((a, b) => b.price - a.price)[0];
    const res = lv.filter((L) => L.price >= x.c - 0.3 * A).sort((a, b) => a.price - b.price)[0];
    if (sup && x.l <= sup.price + 0.5 * A && x.c > sup.price && x.l >= sup.price - 1.0 * A && bullCandle) {
      const r = nextAbove(lv, sup.price + 0.5 * A);
      add("sr_support", 1, sup.touches >= 3 ? 0.7 : 0.55, plan(1, x.c, Math.min(x.l, sup.price) - 0.4 * A, r && r.price, A), `قیمت به ناحیه‌ی حمایت ${fmt(sup.price)} (${sup.touches} برخورد) رسید و با کندل برگشتی صعودی پس زده شد.`);
    }
    if (res && x.h >= res.price - 0.5 * A && x.c < res.price && x.h <= res.price + 1.0 * A && bearCandle) {
      const s2 = nextBelow(lv, res.price - 0.5 * A);
      add("sr_resistance", -1, res.touches >= 3 ? 0.7 : 0.55, plan(-1, x.c, Math.max(x.h, res.price) + 0.4 * A, s2 && s2.price, A), `قیمت به ناحیه‌ی مقاومت ${fmt(res.price)} (${res.touches} برخورد) رسید و با کندل برگشتی نزولی پس زده شد.`);
    }
    for (const L of lv) {   // breakout + retest (role reversal)
      let brokeUp = -1, brokeDn = -1;
      for (let k = Math.max(1, i - 15); k <= i - 2; k++) {
        if (c[k - 1].c <= L.price && c[k].c > L.price + 0.2 * A) brokeUp = k;
        if (c[k - 1].c >= L.price && c[k].c < L.price - 0.2 * A) brokeDn = k;
      }
      if (brokeUp > 0) {
        let held = true, ran = false;
        for (let k = brokeUp + 1; k <= i - 1; k++) { if (c[k].c < L.price - 0.2 * A) held = false; if (c[k].h > L.price + 0.8 * A) ran = true; }
        if (held && ran && x.l <= L.price + 0.35 * A && x.c > L.price && bullCandle) {
          const r = nextAbove(lv, L.price + A);
          add("sr_retest_up", 1, 0.8, plan(1, x.c, Math.min(x.l, L.price) - 0.4 * A, r ? r.price : null, A), `مقاومت ${fmt(L.price)} شکسته شد، قیمت برگشت و آن را به‌عنوان حمایت تست کرد (تبدیل نقش).`);
          break;
        }
      }
      if (brokeDn > 0) {
        let held = true, ran = false;
        for (let k = brokeDn + 1; k <= i - 1; k++) { if (c[k].c > L.price + 0.2 * A) held = false; if (c[k].l < L.price - 0.8 * A) ran = true; }
        if (held && ran && x.h >= L.price - 0.35 * A && x.c < L.price && bearCandle) {
          const s2 = nextBelow(lv, L.price - A);
          add("sr_retest_dn", -1, 0.8, plan(-1, x.c, Math.max(x.h, L.price) + 0.4 * A, s2 ? s2.price : null, A), `حمایت ${fmt(L.price)} شکسته شد، قیمت برگشت و آن را به‌عنوان مقاومت تست کرد (تبدیل نقش).`);
          break;
        }
      }
    }

    /* ---- rectangle / neutral trend */
    const box = rectangle(ctx);
    if (box) {
      drawings.push({ type: "zone", i1: box.from, i2: i, top: box.top, bottom: box.bot, color: "#f5a623", label: "مستطیل (روند خنثی)" });
      info.push({ family: "range", text: `بازار در مستطیل ${fmt(box.bot)} – ${fmt(box.top)} (سقف ${box.touchesTop}، کف ${box.touchesBot} برخورد)` });
      const volOk = !ctx.hasVol || (ctx.volAvg && ctx.v[i] > 1.2 * ctx.volAvg);
      const volTxt = ctx.hasVol ? (volOk ? " با حجم بالاتر از میانگین" : " (بدون افزایش حجم؛ احتمال شکست جعلی بیشتر)") : " (منبع داده حجم ندارد)";
      if (x.c > box.top + 0.2 * A && px.c <= box.top + 0.2 * A)
        add("rect_break_up", 1, volOk ? 0.8 : 0.5, plan(1, x.c, [box.top - 0.5 * A, x.l - 0.3 * A], x.c + box.height, A), `بسته شدن کندل بالای سقف مستطیل ${fmt(box.top)}${volTxt}؛ هدف = ارتفاع مستطیل.`);
      else if (x.c < box.bot - 0.2 * A && px.c >= box.bot - 0.2 * A)
        add("rect_break_dn", -1, volOk ? 0.8 : 0.5, plan(-1, x.c, [box.bot + 0.5 * A, x.h + 0.3 * A], x.c - box.height, A), `بسته شدن کندل زیر کف مستطیل ${fmt(box.bot)}${volTxt}؛ هدف = ارتفاع مستطیل.`);
      else if (x.c <= box.bot + 0.25 * box.height && x.c >= box.bot && bullCandle)
        add("rect_in_long", 1, 0.5, plan(1, x.c, box.bot - 0.4 * A, box.top - 0.1 * box.height, A), `قیمت در کف مستطیل (${fmt(box.bot)}) با کندل صعودی؛ هدف سقف مستطیل.`);
      else if (x.c >= box.top - 0.25 * box.height && x.c <= box.top && bearCandle)
        add("rect_in_short", -1, 0.5, plan(-1, x.c, box.top + 0.4 * A, box.bot + 0.1 * box.height, A), `قیمت در سقف مستطیل (${fmt(box.top)}) با کندل نزولی؛ هدف کف مستطیل.`);
    }

    /* ---- smart money: BOS / CHoCH, order block, FVG, liquidity sweep */
    const conf = (k) => ({ highs: sw.highs.filter((q) => q.i + 3 < k), lows: sw.lows.filter((q) => q.i + 3 < k) });
    let lastEvent = null;
    for (let k = Math.max(5, i - 30); k <= i; k++) {
      const s = conf(k), H = s.highs[s.highs.length - 1], L = s.lows[s.lows.length - 1];
      if (!H || !L) continue;
      const trend = s.highs.length >= 2 && s.lows.length >= 2
        ? (H.p > s.highs[s.highs.length - 2].p && L.p > s.lows[s.lows.length - 2].p ? 1 : H.p < s.highs[s.highs.length - 2].p && L.p < s.lows[s.lows.length - 2].p ? -1 : 0) : 0;
      if (c[k].c > H.p && c[k - 1].c <= H.p) lastEvent = { k, dir: 1, kind: trend === -1 ? "choch" : "bos", level: H.p, from: H.i };
      if (c[k].c < L.p && c[k - 1].c >= L.p) lastEvent = { k, dir: -1, kind: trend === 1 ? "choch" : "bos", level: L.p, from: L.i };
    }
    if (lastEvent) {
      const e = lastEvent, nm = e.kind === "choch" ? (e.dir === 1 ? "CHoCH صعودی" : "CHoCH نزولی") : (e.dir === 1 ? "BOS صعودی" : "BOS نزولی");
      info.push({ family: "smc", text: `${nm}: شکست سطح ${fmt(e.level)} ${i - e.k === 0 ? "در همین کندل" : (i - e.k) + " کندل پیش"}` });
      drawings.push({ type: "line", i1: e.from, p1: e.level, i2: e.k, p2: e.level, color: e.dir === 1 ? "#2ebd85" : "#f6465d", label: e.kind === "choch" ? "CHoCH" : "BOS", dash: true });
      if (e.k === i) {
        const key = `smc_${e.kind}_${e.dir === 1 ? "up" : "dn"}`;
        const tgt = e.dir === 1 ? nextAbove(lv, x.c) : nextBelow(lv, x.c);
        const stopRef = e.dir === 1 ? (lastL ? lastL.p : x.l) : (lastH ? lastH.p : x.h);
        add(key, e.dir, e.kind === "choch" ? 0.5 : 0.4, plan(e.dir, x.c, [stopRef - e.dir * 0.2 * A, e.level - e.dir * 0.5 * A, (e.dir === 1 ? x.l : x.h) - e.dir * 0.3 * A], tgt && tgt.price, A),
          e.kind === "choch" ? `اولین شکست سقف/کف خلاف روند قبلی (${fmt(e.level)})؛ احتمال تغییر روند — هنوز تأیید کامل نیست.` : `شکست سقف/کف قبلی (${fmt(e.level)}) در جهت روند؛ ادامه‌ی روند.`);
      }
      // order block: last opposite candle before the impulse that made this break
      let ob = null;
      for (let k = e.k - 1; k >= Math.max(1, e.k - 10); k--) { if (e.dir === 1 ? c[k].c < c[k].o : c[k].c > c[k].o) { ob = { k, top: c[k].h, bot: c[k].l }; break; } }
      if (ob && e.k < i) {
        let broken = false;
        for (let k = e.k + 1; k <= i - 1; k++) if (e.dir === 1 ? c[k].c < ob.bot : c[k].c > ob.top) broken = true;
        if (!broken) {
          drawings.push({ type: "zone", i1: ob.k, i2: i, top: ob.top, bottom: ob.bot, color: e.dir === 1 ? "#2ebd85" : "#f6465d", label: e.dir === 1 ? "اوردر بلاک صعودی" : "اوردر بلاک نزولی" });
          info.push({ family: "smc", text: `اوردر بلاک ${e.dir === 1 ? "صعودی" : "نزولی"} ${fmt(ob.bot)} – ${fmt(ob.top)}` });
          if (e.dir === 1 && x.l <= ob.top && x.c >= ob.bot && x.c > x.o) {
            const r = nextAbove(lv, x.c);
            add("smc_ob_long", 1, 0.7, plan(1, x.c, ob.bot - 0.3 * A, Math.max(e.level, r ? r.price : 0) || null, A), `قیمت به اوردر بلاک صعودی (${fmt(ob.bot)} – ${fmt(ob.top)}) برگشت و صعودی بسته شد.`);
          }
          if (e.dir === -1 && x.h >= ob.bot && x.c <= ob.top && x.c < x.o) {
            const s2 = nextBelow(lv, x.c);
            add("smc_ob_short", -1, 0.7, plan(-1, x.c, ob.top + 0.3 * A, s2 ? Math.min(e.level, s2.price) : e.level, A), `قیمت به اوردر بلاک نزولی (${fmt(ob.bot)} – ${fmt(ob.top)}) برگشت و نزولی بسته شد.`);
          }
        }
      }
    }
    for (let k = i - 2; k >= Math.max(2, i - 30); k--) {   // most recent unfilled fair value gap
      const bull = c[k - 1].h < c[k + 1].l && c[k + 1].l - c[k - 1].h >= 0.3 * A;
      const bear = c[k - 1].l > c[k + 1].h && c[k - 1].l - c[k + 1].h >= 0.3 * A;
      if (!bull && !bear) continue;
      const top = bull ? c[k + 1].l : c[k - 1].l, bot = bull ? c[k - 1].h : c[k + 1].h;
      let filled = false;
      for (let j = k + 2; j <= i - 1; j++) if (bull ? c[j].l <= bot : c[j].h >= top) filled = true;
      if (filled) continue;
      drawings.push({ type: "zone", i1: k - 1, i2: i, top, bottom: bot, color: bull ? "#48dbfb" : "#ff9f43", label: bull ? "FVG صعودی" : "FVG نزولی" });
      info.push({ family: "smc", text: `شکاف ارزش منصفانه (FVG) ${bull ? "صعودی" : "نزولی"} پر‌نشده: ${fmt(bot)} – ${fmt(top)}` });
      if (bull && st.trend !== "down" && x.l <= top && x.c >= bot && x.c > x.o)
        add("smc_fvg_long", 1, 0.5, plan(1, x.c, bot - 0.4 * A, lastH && lastH.p > x.c ? lastH.p : null, A), `قیمت به FVG صعودی (${fmt(bot)} – ${fmt(top)}) برگشت و صعودی بسته شد.`);
      if (bear && st.trend !== "up" && x.h >= bot && x.c <= top && x.c < x.o)
        add("smc_fvg_short", -1, 0.5, plan(-1, x.c, top + 0.4 * A, lastL && lastL.p < x.c ? lastL.p : null, A), `قیمت به FVG نزولی (${fmt(bot)} – ${fmt(top)}) برگشت و نزولی بسته شد.`);
      break;
    }
    if (lastL && x.l < lastL.p - 0.05 * A && x.c > lastL.p && B.lo >= B.b)
      add("smc_sweep_long", 1, 0.7, plan(1, x.c, x.l - 0.3 * A, lastH && lastH.p > x.c ? lastH.p : null, A), `سایه‌ی کندل زیر کف قبلی ${fmt(lastL.p)} رفت (جمع‌آوری حد ضررها) و دوباره بالای آن بسته شد.`);
    if (lastH && x.h > lastH.p + 0.05 * A && x.c < lastH.p && B.up >= B.b)
      add("smc_sweep_short", -1, 0.7, plan(-1, x.c, x.h + 0.3 * A, lastL && lastL.p < x.c ? lastL.p : null, A), `سایه‌ی کندل بالای سقف قبلی ${fmt(lastH.p)} رفت (جمع‌آوری حد ضررها) و دوباره زیر آن بسته شد.`);

    /* ---- continuation: flags */
    for (const s of [1, -1]) {
      let done = false;
      for (let p1 = i - 4; p1 >= Math.max(10, i - 16) && !done; p1--) {
        for (let p0 = p1 - 3; p0 >= Math.max(1, p1 - 10); p0--) {
          const pole = s === 1 ? c[p1].h - c[p0].l : c[p0].h - c[p1].l;
          if (pole < 3 * A) continue;
          let fh = -Infinity, fl = Infinity;
          for (let k = p1 + 1; k <= i - 1; k++) { fh = Math.max(fh, c[k].h); fl = Math.min(fl, c[k].l); }
          const poleEnd = s === 1 ? c[p1].h : c[p1].l;
          const retr = s === 1 ? poleEnd - fl : fh - poleEnd;
          if (retr > 0.5 * pole || fh - fl > 0.6 * pole || (s === 1 ? fh > poleEnd + 0.2 * A : fl < poleEnd - 0.2 * A)) continue;
          drawings.push({ type: "zone", i1: p1, i2: i, top: fh, bottom: fl, color: "#a29bfe", label: s === 1 ? "پرچم صعودی" : "پرچم نزولی" });
          info.push({ family: "cont", text: `${s === 1 ? "پرچم صعودی" : "پرچم نزولی"}: میله ${fmt(pole)} و اصلاح ${Math.round((100 * retr) / pole)}٪` });
          if (s === 1 && x.c > fh) add("flag_bull", 1, 0.8, plan(1, x.c, [fl - 0.2 * A, fh - 0.5 * A], x.c + pole, A), `شکست سقف پرچم ${fmt(fh)} بعد از یک حرکت قوی صعودی؛ هدف = طول میله.`);
          if (s === -1 && x.c < fl) add("flag_bear", -1, 0.8, plan(-1, x.c, [fh + 0.2 * A, fl + 0.5 * A], x.c - pole, A), `شکست کف پرچم ${fmt(fl)} بعد از یک حرکت قوی نزولی؛ هدف = طول میله.`);
          done = true; break;
        }
      }
    }

    /* ---- reversal: double top / bottom, head & shoulders */
    const Hs = sw.highs.slice(-3), Ls = sw.lows.slice(-3);
    const minBetween = (a, b, key) => { let m = key === "l" ? Infinity : -Infinity; for (let k = a + 1; k < b; k++) m = key === "l" ? Math.min(m, c[k].l) : Math.max(m, c[k].h); return m; };
    if (Hs.length >= 2) {
      const [H1, H2] = Hs.slice(-2), neck = minBetween(H1.i, H2.i, "l"), height = Math.max(H1.p, H2.p) - neck;
      if (Math.abs(H1.p - H2.p) <= 0.5 * A && H2.i - H1.i >= 5 && height >= 1.5 * A && i - H2.i <= 30) {
        drawings.push({ type: "line", i1: H1.i, p1: neck, i2: i, p2: neck, color: "#f6465d", label: "خط گردن سقف دوقلو", dash: true });
        info.push({ family: "rev", text: `سقف دوقلو در ${fmt(Math.max(H1.p, H2.p))}؛ خط گردن ${fmt(neck)}` });
        if (x.c < neck - 0.1 * A && px.c >= neck - 0.1 * A) add("dbl_top", -1, 0.8, plan(-1, x.c, [neck + Math.max(A, Math.min(0.5 * height, 3 * A)), neck + 0.5 * A], neck - height, A), `شکست خط گردن ${fmt(neck)} سقف دوقلو؛ هدف = ارتفاع الگو.`);
      }
    }
    if (Ls.length >= 2) {
      const [L1, L2] = Ls.slice(-2), neck = minBetween(L1.i, L2.i, "h"), height = neck - Math.min(L1.p, L2.p);
      if (Math.abs(L1.p - L2.p) <= 0.5 * A && L2.i - L1.i >= 5 && height >= 1.5 * A && i - L2.i <= 30) {
        drawings.push({ type: "line", i1: L1.i, p1: neck, i2: i, p2: neck, color: "#2ebd85", label: "خط گردن کف دوقلو", dash: true });
        info.push({ family: "rev", text: `کف دوقلو در ${fmt(Math.min(L1.p, L2.p))}؛ خط گردن ${fmt(neck)}` });
        if (x.c > neck + 0.1 * A && px.c <= neck + 0.1 * A) add("dbl_bottom", 1, 0.8, plan(1, x.c, [neck - Math.max(A, Math.min(0.5 * height, 3 * A)), neck - 0.5 * A], neck + height, A), `شکست خط گردن ${fmt(neck)} کف دوقلو؛ هدف = ارتفاع الگو.`);
      }
    }
    if (Hs.length === 3) {
      const [Ls1, Hd, Rs] = Hs, n1 = minBetween(Ls1.i, Hd.i, "l"), n2 = minBetween(Hd.i, Rs.i, "l");
      if (Hd.p - Math.max(Ls1.p, Rs.p) >= 0.5 * A && Math.abs(Ls1.p - Rs.p) <= A && i - Rs.i <= 30) {
        const neckAt = (k) => n1 + ((n2 - n1) / Math.max(1, Rs.i - Ls1.i)) * (k - Ls1.i), height = Hd.p - (n1 + n2) / 2;
        drawings.push({ type: "line", i1: Ls1.i, p1: neckAt(Ls1.i), i2: i, p2: neckAt(i), color: "#f6465d", label: "خط گردن سر و شانه", dash: true });
        info.push({ family: "rev", text: `سر و شانه: سر ${fmt(Hd.p)}، خط گردن ${fmt(neckAt(i))}` });
        if (x.c < neckAt(i) - 0.1 * A && px.c >= neckAt(i - 1) - 0.1 * A) add("hs_top", -1, 0.9, plan(-1, x.c, [Rs.p + 0.2 * A, neckAt(i) + 0.5 * A], neckAt(i) - height, A), `شکست خط گردن سر و شانه؛ هدف = فاصله‌ی سر تا خط گردن.`);
      }
    }
    if (Ls.length === 3) {
      const [Ls1, Hd, Rs] = Ls, n1 = minBetween(Ls1.i, Hd.i, "h"), n2 = minBetween(Hd.i, Rs.i, "h");
      if (Math.min(Ls1.p, Rs.p) - Hd.p >= 0.5 * A && Math.abs(Ls1.p - Rs.p) <= A && i - Rs.i <= 30) {
        const neckAt = (k) => n1 + ((n2 - n1) / Math.max(1, Rs.i - Ls1.i)) * (k - Ls1.i), height = (n1 + n2) / 2 - Hd.p;
        drawings.push({ type: "line", i1: Ls1.i, p1: neckAt(Ls1.i), i2: i, p2: neckAt(i), color: "#2ebd85", label: "خط گردن سر و شانه‌ی معکوس", dash: true });
        info.push({ family: "rev", text: `سر و شانه‌ی معکوس: سر ${fmt(Hd.p)}، خط گردن ${fmt(neckAt(i))}` });
        if (x.c > neckAt(i) + 0.1 * A && px.c <= neckAt(i - 1) + 0.1 * A) add("hs_bottom", 1, 0.9, plan(1, x.c, [Rs.p - 0.2 * A, neckAt(i) - 0.5 * A], neckAt(i) + height, A), `شکست خط گردن سر و شانه‌ی معکوس؛ هدف = فاصله‌ی سر تا خط گردن.`);
      }
    }

    info.unshift({ family: "struct", text: st.trend === "up" ? "ساختار بازار: صعودی (سقف‌ها و کف‌های بالاتر)" : st.trend === "down" ? "ساختار بازار: نزولی (سقف‌ها و کف‌های پایین‌تر)" : "ساختار بازار: خنثی / نامشخص" });
    const score = clamp(out.reduce((a, s) => a + s.dir * s.strength, 0) * 0.6);
    return { setups: out, info, drawings, score };
  }

  function fmt(x) { return FA.signal && FA.signal.fmt ? FA.signal.fmt(x) : ok(x) ? String(+x.toPrecision(7)) : "—"; }

  /* ------------------------------------------------------------ walk-forward backtest of each setup */
  async function backtest(candles, opts = {}) {
    const win = opts.window || 300, horizon = opts.horizon || 48, minBars = opts.minBars || 220;
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const trades = [], busyUntil = {};
    for (let i = minBars; i < candles.length - 2; i++) {
      const slice = candles.slice(Math.max(0, i - win + 1), i + 1);   // only the past: no look-ahead
      const d = detect(slice);
      for (const s of d.setups) {
        if ((busyUntil[s.key] || 0) > i) continue;
        const p = s.plan, dir = s.dir, end = Math.min(candles.length - 1, i + horizon);
        let res = "expired", exitIdx = end;
        for (let j = i + 1; j <= end; j++) {
          const x = candles[j];
          if (dir === 1 ? x.l <= p.sl : x.h >= p.sl) { res = "loss"; exitIdx = j; break; }   // both in one bar → assume the loss
          if (dir === 1 ? x.h >= p.tp : x.l <= p.tp) { res = "win"; exitIdx = j; break; }
        }
        const R = res === "win" ? p.rr : res === "loss" ? -1 : (dir * (candles[exitIdx].c - p.entry)) / p.risk;
        trades.push({ key: s.key, i, res, R, rr: p.rr });
        busyUntil[s.key] = exitIdx + 1;
      }
      if (i % 25 === 0) { if (opts.onProgress) opts.onProgress((i - minBars) / Math.max(1, candles.length - minBars)); await tick(); }
    }
    const byKey = {};
    trades.forEach((t) => (byKey[t.key] = byKey[t.key] || []).push(t));
    const stats = Object.entries(byKey).map(([key, t]) => {
      const wins = t.filter((x) => x.res === "win").length, losses = t.filter((x) => x.res === "loss").length;
      const totalR = t.reduce((a, x) => a + x.R, 0), gw = t.filter((x) => x.R > 0).reduce((a, x) => a + x.R, 0), gl = -t.filter((x) => x.R < 0).reduce((a, x) => a + x.R, 0);
      const avgRR = t.reduce((a, x) => a + x.rr, 0) / t.length;
      return { key, name: NAMES[key], family: FAMILY_OF(key), count: t.length, wins, losses, winRate: wins + losses ? (100 * wins) / (wins + losses) : null,
        breakeven: 100 / (1 + avgRR), avgR: totalR / t.length, totalR, profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : null };
    }).sort((a, b) => b.totalR - a.totalR);
    return { trades, stats, bars: candles.length };
  }

  FA.setups = { detect, backtest, trendline, rectangle, plan, STYLES, FAMILY, NAMES, FAMILY_OF };
})(typeof window !== "undefined" ? window : globalThis);
