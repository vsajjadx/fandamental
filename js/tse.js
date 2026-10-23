/* Fandamental — Tehran Stock Exchange (TSETMC) layer.
   Data: cdn.tsetmc.com/api (works from Iranian IPs; outside Iran a personal relay is needed).
   Response formats were taken from real recorded responses (tests/fixtures/tsetmc).

   What it adds for بورس تهران:
     • the whole market watch (every share / fund), with P/E, EPS, base volume, price limits
     • retail vs institutional money flow (حقیقی/حقوقی): today for every symbol, and day-by-day history
       attached to each daily candle (c.rn = net retail money in rials, c.bp = retail buyer power,
       c.rv = traded value) so the existing engine — and the back-test — can use it without look-ahead
     • TEDPIX, equal-weight and sector indices as chartable symbols
     • share fundamentals (EPS, P/E, sector P/E, market cap, free float, base volume, daily price limits, 52-week range)
     • price adjustment for capital increases / dividends, so old prices do not create fake crashes */
(function (g) {
  "use strict";
  const FA = (g.FA = g.FA || {});
  const ok = (x) => typeof x === "number" && isFinite(x);
  const num = (x) => (x == null || x === "" || x === "-" ? NaN : +x);

  /** TSETMC uses Arabic ي / ك and odd spacing; normalise for display and matching. */
  function norm(s) {
    return String(s == null ? "" : s).replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/‌\s+|\s+‌/g, " ").replace(/\s{2,}/g, " ").trim();
  }
  const key = (s) => norm(s).replace(/[\s‌]/g, "");
  const dayTs = (d) => Math.floor(Date.parse(String(d).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") + "T00:00:00Z") / 1000);

  /** Instrument kind from its ISIN. */
  function kindOf(isin) {
    const s = String(isin || "");
    if (/^IRO9|^IROF|^IRS/.test(s)) return "option";
    if (/^IRO[1-7]/.test(s)) return "stock";
    if (/^IRT/.test(s)) return "fund";
    if (/^IRB/.test(s)) return "bond";
    return "other";
  }

  /* ------------------------------------------------------------ parsers (pure) */
  function parseMarketWatch(j) {
    return ((j && j.marketwatch) || []).map((r) => {
      const close = num(r.pcl), last = num(r.pdv), y = num(r.py), shares = num(r.ztd);
      return {
        ins: String(r.insCode), sym: norm(r.lva), name: norm(r.lvc), isin: r.insID || "", kind: kindOf(r.insID),
        last, close, yday: y, first: num(r.pf), high: num(r.pmx), low: num(r.pmn),
        lastPct: y > 0 && last > 0 ? (100 * (last - y)) / y : NaN, closePct: y > 0 && close > 0 ? (100 * (close - y)) / y : NaN,
        volume: num(r.qtj), value: num(r.qtc), trades: num(r.ztt), baseVol: num(r.bv), shares,
        eps: num(r.eps), pe: num(r.pe), sector: String(r.csv || "").trim(), limitMax: num(r.pMax), limitMin: num(r.pMin),
        mcap: shares > 0 && close > 0 ? shares * close : NaN,
      };
    }).filter((r) => r.ins && r.sym);
  }

  function parseClientTypeAll(j) {
    const m = new Map();
    ((j && j.clientTypeAllDto) || []).forEach((r) => m.set(String(r.insCode), {
      buyI: +r.buy_I_Volume || 0, buyN: +r.buy_N_Volume || 0, sellI: +r.sell_I_Volume || 0, sellN: +r.sell_N_Volume || 0,
      buyCountI: +r.buy_CountI || 0, sellCountI: +r.sell_CountI || 0, buyCountN: +r.buy_CountN || 0, sellCountN: +r.sell_CountN || 0,
    }));
    return m;
  }

  /** Money-flow metrics from one day of retail/institutional volumes. price = the day's price (to convert volume → rials). */
  function flowMetrics(ct, price) {
    if (!ct) return null;
    const perBuyer = ct.buyCountI > 0 ? ct.buyI / ct.buyCountI : NaN, perSeller = ct.sellCountI > 0 ? ct.sellI / ct.sellCountI : NaN;
    const total = ct.buyI + ct.buyN;
    return {
      buyPower: perBuyer > 0 && perSeller > 0 ? perBuyer / perSeller : NaN,            // retail: average buy size ÷ average sell size
      netRetailVol: ct.buyI - ct.sellI,                                               // > 0: money from institutions to retail (حقوقی به حقیقی)
      netRetailValue: ok(price) ? (ct.buyI - ct.sellI) * price : NaN,
      retailShare: total > 0 ? ct.buyI / total : NaN,
    };
  }

  function parseClientHistory(j) {
    return ((j && j.clientType) || []).map((r) => ({
      t: dayTs(r.recDate),
      buyIValue: +r.buy_I_Value || 0, sellIValue: +r.sell_I_Value || 0, buyNValue: +r.buy_N_Value || 0, sellNValue: +r.sell_N_Value || 0,
      buyIVol: +r.buy_I_Volume || 0, sellIVol: +r.sell_I_Volume || 0, buyICount: +r.buy_I_Count || 0, sellICount: +r.sell_I_Count || 0,
    })).filter((r) => isFinite(r.t)).sort((a, b) => a.t - b.t);
  }

  /** Attach the day's flow to each daily candle (same calendar day), never a later day → no look-ahead. */
  function attachFlow(candles, hist) {
    const by = new Map(hist.map((h) => [h.t, h]));
    let n = 0;
    const out = candles.map((c) => {
      const h = by.get(c.t);
      if (!h) return c;
      n++;
      const perB = h.buyICount > 0 ? h.buyIVol / h.buyICount : NaN, perS = h.sellICount > 0 ? h.sellIVol / h.sellICount : NaN;
      return { ...c, rn: h.buyIValue - h.sellIValue, rv: h.buyIValue + h.buyNValue, bp: perB > 0 && perS > 0 ? perB / perS : NaN };
    });
    return { candles: out, matched: n };
  }

  /** Backward price adjustment: every price BEFORE an adjustment date is scaled by adjusted/unadjusted close. */
  function applyAdjustments(candles, events) {
    const ev = (events || []).map((e) => ({ t: dayTs(e.dEven), r: +e.pClosing / +e.pClosingNotAdjusted }))
      .filter((e) => isFinite(e.t) && e.r > 0 && e.r < 1.0001 && e.r !== 1).sort((a, b) => b.t - a.t);
    if (!ev.length) return { candles, count: 0 };
    let k = 0, factor = 1;
    const out = new Array(candles.length);
    for (let i = candles.length - 1; i >= 0; i--) {
      const c = candles[i];
      while (k < ev.length && c.t < ev[k].t) { factor *= ev[k].r; k++; }
      out[i] = factor === 1 ? c : { ...c, o: c.o * factor, h: c.h * factor, l: c.l * factor, c: c.c * factor, v: c.v / factor };
    }
    return { candles: out, count: ev.filter((e) => e.t >= candles[0].t).length };
  }

  /** Index history → candles (TSETMC gives close / high / low; open = previous close). */
  function parseIndexHistory(j) {
    const rows = ((j && j.indexB2) || []).map((r) => ({ t: dayTs(r.dEven), c: +r.xNivInuClMresIbs, h: +r.xNivInuPhMresIbs, l: +r.xNivInuPbMresIbs }))
      .filter((r) => isFinite(r.t) && r.c > 0).sort((a, b) => a.t - b.t);
    return rows.map((r, i) => {
      const o = i ? rows[i - 1].c : r.c;
      const h = r.h > 0 ? Math.max(r.h, o, r.c) : Math.max(o, r.c), l = r.l > 0 ? Math.min(r.l, o, r.c) : Math.min(o, r.c);
      return { t: r.t, o, h, l, c: r.c, v: 0 };
    });
  }

  const SELECTED = { "32097828799138957": "شاخص کل", "67130298613737946": "شاخص کل هم‌وزن", "5798407779416661": "شاخص قیمت (وزنی-ارزشی)", "8384385859414435": "شاخص قیمت (هم‌وزن)", "49579049405614711": "شاخص آزاد شناور", "62752761908615603": "بازار اول", "71704855530629737": "بازار دوم" };
  function parseIndexAll(j) {
    return ((j && j.indexB1) || []).map((r) => ({
      ins: String(r.insCode), name: SELECTED[String(r.insCode)] || norm(r.lVal30), value: +r.xDrNivJIdx004, change: +r.indexChange, pct: +r.xVarIdxJRfV,
      high: +r.xPhNivJIdx004, low: +r.xPbNivJIdx004, selected: !!SELECTED[String(r.insCode)],
    })).filter((r) => r.ins && r.ins !== "null" && r.value > 0);
  }

  function parseInstrumentInfo(j) {
    const x = j && j.instrumentInfo;
    if (!x) return null;
    const eps = x.eps || {}, st = x.staticThreshold || {};
    const est = num(eps.estimatedEPS), real = num(eps.epsValue);
    return {
      ins: String(x.insCode), ticker: norm(x.lVal18AFC), name: norm(x.lVal30), isin: x.instrumentID || x.cIsin || "",
      sector: norm(x.sector && x.sector.lSecVal), market: norm([x.flowTitle, x.cgrValCotTitle].filter((v) => v && !/^-/.test(v)).join(" — ")),
      eps: ok(real) ? real : est, epsEstimated: !ok(real) && ok(est), sectorPE: num(eps.sectorPE), psr: num(eps.psr),
      shares: num(x.zTitad), baseVol: num(x.baseVol), freeFloat: num(x.kAjCapValCpsIdx),
      limitMax: num(st.psGelStaMax), limitMin: num(st.psGelStaMin), minWeek: num(x.minWeek), maxWeek: num(x.maxWeek),
      minYear: num(x.minYear), maxYear: num(x.maxYear), avgVolume: num(x.qTotTran5JAvg), kind: kindOf(x.instrumentID || x.cIsin),
    };
  }

  /** Derived valuation numbers for a price. */
  function valuation(info, price) {
    if (!info || !ok(price) || price <= 0) return null;
    return {
      pe: info.eps > 0 ? price / info.eps : NaN,
      mcap: info.shares > 0 ? info.shares * price : NaN,
      peVsSector: info.eps > 0 && info.sectorPE > 0 ? price / info.eps / info.sectorPE : NaN,
      fromYearHigh: info.maxYear > 0 ? (100 * (price - info.maxYear)) / info.maxYear : NaN,
      fromYearLow: info.minYear > 0 ? (100 * (price - info.minYear)) / info.minYear : NaN,
      atUpperLimit: info.limitMax > 0 && price >= info.limitMax,
      atLowerLimit: info.limitMin > 0 && price <= info.limitMin,
    };
  }

  function parseSectors(j) {
    const m = new Map();
    ((j && j.sectorSummeries) || []).forEach((r) => m.set(String(r.cSecVal).trim(), norm(r.lSecVal)));
    return m;
  }

  /** Exact ticker match from a search response (TSETMC returns many fuzzy matches). */
  function pickExact(searchJson, ticker) {
    const want = key(ticker);
    const rows = (searchJson && (searchJson.instrumentSearch || (searchJson.instrumentInfo ? [searchJson.instrumentInfo] : []))) || [];
    const hit = rows.find((r) => key(r.lVal18AFC) === want && !/^IRO9|^IRT|^IRB/.test(r.cIsin || ""))
      || rows.find((r) => key(r.lVal18AFC) === want);
    return hit ? { ins: String(hit.insCode), ticker: norm(hit.lVal18AFC), name: norm(hit.lVal30) } : null;
  }

  /* ------------------------------------------------------------ network (through FA.data.tseGet: direct + relays) */
  const cache = new Map();
  async function cached(path, ttlMs, ms) {
    const c = cache.get(path);
    if (c && Date.now() - c.t < ttlMs) return c.v;
    const v = await FA.data.tseGet(path, ms);
    cache.set(path, { t: Date.now(), v });
    return v;
  }
  const api = {
    marketWatch: () => cached("ClosingPrice/GetMarketWatch?market=0&industrialGroup=&paperTypes%5B0%5D=1&paperTypes%5B1%5D=2&paperTypes%5B2%5D=3&paperTypes%5B3%5D=4&paperTypes%5B4%5D=5&paperTypes%5B5%5D=6&paperTypes%5B6%5D=7&paperTypes%5B7%5D=8&paperTypes%5B8%5D=9&showTraded=false&withBestLimits=false&hEven=0&RefID=0", 60e3, 25000).then(parseMarketWatch),
    clientTypeAll: () => cached("ClientType/GetClientTypeAll", 60e3, 20000).then(parseClientTypeAll),
    clientHistory: (ins) => cached("ClientType/GetClientTypeHistory/" + ins, 30 * 60e3, 15000).then(parseClientHistory),
    adjustments: (ins) => cached("ClosingPrice/GetPriceAdjustList/" + ins, 6 * 3600e3, 12000).then((j) => (j && j.priceAdjust) || []),
    info: (ins) => cached("Instrument/GetInstrumentInfo/" + ins, 30 * 60e3, 12000).then(parseInstrumentInfo),
    indexAll: (flow) => cached("Index/GetIndexB1LastAll/All/" + flow, 60e3, 15000).then(parseIndexAll),
    indexHistory: (ins) => cached("Index/GetIndexB2History/" + ins, 30 * 60e3, 20000).then(parseIndexHistory),
    overview: (flow) => cached("MarketData/GetMarketOverview/" + flow, 60e3, 12000).then((j) => (j && j.marketOverview) || null),
    sectors: () => cached("MarketData/GetSectorsSummary", 24 * 3600e3, 12000).then(parseSectors),
    search: (q) => FA.data.tseGet("Instrument/GetInstrumentSearch/" + encodeURIComponent(q), 9000),
  };

  /* Ticker → insCode cache (hard-coded codes are verified once by an exact ticker search). */
  const LS = "fa_tse_codes";
  const codes = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } })();
  async function resolve(sym) {
    const t = String(sym.short || sym.id || "").replace(/^TSE-/, "");
    if (codes[t] && Date.now() - codes[t].at < 7 * 86400e3) return codes[t].ins;
    try {
      const hit = pickExact(await api.search(t), t);
      if (hit) { codes[t] = { ins: hit.ins, name: hit.name, at: Date.now() }; try { localStorage.setItem(LS, JSON.stringify(codes)); } catch (e) { /* ignore */ } return hit.ins; }
    } catch (e) { /* offline: fall back to the stored code */ }
    return sym.tse;
  }

  /** Called by FA.data.fetchCandles for Tehran symbols: adjusted daily candles + retail/institutional flow. */
  async function candles(sym, limit) {
    if (sym.tseIndex) {
      const c = await api.indexHistory(sym.tseIndex);
      if (c.length < 30) throw new Error("TSETMC: سابقه‌ی شاخص پیدا نشد");
      return { candles: c.slice(-Math.max(limit || 800, 300)), source: "TSETMC (شاخص)", note: "داده‌ی روزانه‌ی شاخص؛ شاخص حجم ندارد" };
    }
    const ins = await resolve(sym);
    if (ins !== sym.tse) sym.tse = ins;
    const raw = await FA.data.fromTsetmc(ins, limit || 500);
    const [adj, hist] = await Promise.allSettled([api.adjustments(ins), api.clientHistory(ins)]);
    const notes = ["داده‌ی روزانه"];
    let c = raw;
    if (adj.status === "fulfilled") {
      const a = applyAdjustments(c, adj.value);
      c = a.candles;
      notes.push(a.count ? `قیمت‌های گذشته برای ${a.count} افزایش سرمایه/سود نقدی تعدیل شد` : "تعدیل قیمت لازم نبود");
    } else notes.push("فهرست تعدیل قیمت دریافت نشد (قیمت‌های گذشته تعدیل‌نشده‌اند)");
    if (hist.status === "fulfilled" && hist.value.length) {
      const f = attachFlow(c, hist.value);
      c = f.candles;
      notes.push(`جریان حقیقی/حقوقی ${f.matched} روز`);
    } else notes.push("سابقه‌ی حقیقی/حقوقی دریافت نشد");
    return { candles: c, source: "TSETMC (بورس تهران)", note: notes.join(" · ") };
  }

  FA.tse = {
    norm, kindOf, parseMarketWatch, parseClientTypeAll, flowMetrics, parseClientHistory, attachFlow, applyAdjustments,
    parseIndexHistory, parseIndexAll, parseInstrumentInfo, valuation, parseSectors, pickExact, api, resolve, candles, SELECTED,
    TEDPIX: "32097828799138957", EQUAL: "67130298613737946",
  };
})(typeof window !== "undefined" ? window : globalThis);
