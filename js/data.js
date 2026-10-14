/* Fandamental — market catalog + OHLC providers (all free, browser-direct).

   Chain per asset (first provider that answers wins):
     Binance      — crypto + PAXG (gold proxy) · CORS open · no key · all timeframes
     TSETMC       — بورس تهران · no key · daily · direct, then free CORS relays
                    (insCode is self-healed through the live instrument search)
     Frankfurter  — FX daily · CORS open · no key  → returns a FULL year+ of daily candles
     CoinGecko    — silver / platinum daily · CORS open · no key
     Yahoo        — metals, energy, indices, FX, crypto · CORS open · no key
     Stooq        — long daily history for indices / metals / oil / FX (via relay)
     gold-api.com — live spot XAU / XAG / XPT · CORS open · no key
     Twelve Data  — optional free key · intraday FX / metals / energy
                    (US indices are NOT part of the free plan → HTTP 404)

   ---- what live probing on 2026-10-14 showed (why the panel used to fail) ----
   1) YAHOO IS NO LONGER BROWSER-CALLABLE. https://query1.finance.yahoo.com returns
      HTTP 429 «Edge: Too Many Requests» and NO Access-Control-Allow-Origin header, so a
      browser fetch rejects with the opaque «Failed to fetch» the user saw. The fix is a
      relay chain; r.jina.ai is the one verified to return the real chart JSON.
      Relays are rate-limited too, so they now run through a small concurrency gate and a
      per-relay cooldown (a rate-limited relay is skipped for 90s instead of retried for
      every symbol — that was the «همش خطا میده» noise).
   2) TWELVE DATA RETURNS HTTP 401 (not 404) when the key is missing/invalid, and HTTP 404
      when the SYMBOL is not in the plan — indices (DXY/SPX/NDX/DJI) are paid-only, so the
      old generic «key or 1D» hint was wrong. TD's JSON error body is now read and turned
      into a precise message.
   3) TSETMC answers with an object even when the insCode is wrong, and the old parser
      required pOpening > 0 — a missing/zero opening field dropped EVERY candle and the app
      blamed "no history for this symbol". The parser now accepts priceFirst /
      priceYesterday / pDrCotVal, and a wrong insCode is re-resolved from the live search.
   4) Every failure used to end with the same «Twelve Data / 1D» hint, even for Tehran
      stocks. Hints are now derived from the real failure kinds. */
(function (g) {
  const FA = (g.FA = g.FA || {});

  /* ---------------- catalog ---------------- */
  const SYMBOLS = [
    { id: "EURUSD", name: "EUR/USD", group: "فارکس", tv: "OANDA:EURUSD", td: "EUR/USD", yh: "EURUSD=X", st: "eurusd", fx: ["EUR", "USD"] },
    { id: "GBPUSD", name: "GBP/USD", group: "فارکس", tv: "OANDA:GBPUSD", td: "GBP/USD", yh: "GBPUSD=X", st: "gbpusd", fx: ["GBP", "USD"] },
    { id: "USDJPY", name: "USD/JPY", group: "فارکس", tv: "OANDA:USDJPY", td: "USD/JPY", yh: "USDJPY=X", st: "usdjpy", fx: ["USD", "JPY"] },
    { id: "USDCHF", name: "USD/CHF", group: "فارکس", tv: "OANDA:USDCHF", td: "USD/CHF", yh: "USDCHF=X", st: "usdchf", fx: ["USD", "CHF"] },
    { id: "AUDUSD", name: "AUD/USD", group: "فارکس", tv: "OANDA:AUDUSD", td: "AUD/USD", yh: "AUDUSD=X", st: "audusd", fx: ["AUD", "USD"] },
    { id: "USDCAD", name: "USD/CAD", group: "فارکس", tv: "OANDA:USDCAD", td: "USD/CAD", yh: "USDCAD=X", st: "usdcad", fx: ["USD", "CAD"] },
    { id: "NZDUSD", name: "NZD/USD", group: "فارکس", tv: "OANDA:NZDUSD", td: "NZD/USD", yh: "NZDUSD=X", st: "nzdusd", fx: ["NZD", "USD"] },
    { id: "EURGBP", name: "EUR/GBP", group: "فارکس", tv: "OANDA:EURGBP", td: "EUR/GBP", yh: "EURGBP=X", st: "eurgbp", fx: ["EUR", "GBP"] },
    { id: "EURJPY", name: "EUR/JPY", group: "فارکس", tv: "OANDA:EURJPY", td: "EUR/JPY", yh: "EURJPY=X", st: "eurjpy", fx: ["EUR", "JPY"] },
    { id: "GBPJPY", name: "GBP/JPY", group: "فارکس", tv: "OANDA:GBPJPY", td: "GBP/JPY", yh: "GBPJPY=X", st: "gbpjpy", fx: ["GBP", "JPY"] },
    { id: "XAUUSD", name: "طلا (XAU/USD)", group: "فلزات و کالا", tv: "OANDA:XAUUSD", td: "XAU/USD", bn: "PAXGUSDT", spot: "XAU", yh: "GC=F", st: "xauusd", cg: "pax-gold", cgNote: "طلای توکنیزه (PAXG) به‌عنوان پروکسی قیمت طلا" },
    { id: "XAGUSD", name: "نقره (XAG/USD)", group: "فلزات و کالا", tv: "OANDA:XAGUSD", td: "XAG/USD", spot: "XAG", yh: "SI=F", st: "xagusd", cg: "kinesis-silver", cgNote: "نقره‌ی توکنیزه (KAG) به‌عنوان پروکسی قیمت نقره" },
    { id: "XPTUSD", name: "پلاتین (XPT/USD)", group: "فلزات و کالا", tv: "OANDA:XPTUSD", td: "XPT/USD", spot: "XPT", yh: "PL=F", st: "xptusd", cg: "gram-platinum", cgScale: 31.1034768, cgNote: "قیمت گرمی × ۳۱٫۱۰۳۵ = قیمت یک اونس" },
    { id: "USOIL", name: "نفت WTI", group: "فلزات و کالا", tv: "TVC:USOIL", td: "WTI/USD", yh: "CL=F", st: "cl.f" },
    { id: "BTCUSDT", name: "بیت‌کوین", group: "کریپتو", tv: "BINANCE:BTCUSDT", bn: "BTCUSDT", yh: "BTC-USD", td: "BTC/USD" },
    { id: "ETHUSDT", name: "اتریوم", group: "کریپتو", tv: "BINANCE:ETHUSDT", bn: "ETHUSDT", yh: "ETH-USD", td: "ETH/USD" },
    { id: "BNBUSDT", name: "BNB", group: "کریپتو", tv: "BINANCE:BNBUSDT", bn: "BNBUSDT", yh: "BNB-USD", td: "BNB/USD" },
    { id: "SOLUSDT", name: "سولانا", group: "کریپتو", tv: "BINANCE:SOLUSDT", bn: "SOLUSDT", yh: "SOL-USD", td: "SOL/USD" },
    { id: "XRPUSDT", name: "ریپل", group: "کریپتو", tv: "BINANCE:XRPUSDT", bn: "XRPUSDT", yh: "XRP-USD", td: "XRP/USD" },
    { id: "ADAUSDT", name: "کاردانو", group: "کریپتو", tv: "BINANCE:ADAUSDT", bn: "ADAUSDT", yh: "ADA-USD", td: "ADA/USD" },
    { id: "DOGEUSDT", name: "دوج‌کوین", group: "کریپتو", tv: "BINANCE:DOGEUSDT", bn: "DOGEUSDT", yh: "DOGE-USD", td: "DOGE/USD" },
    { id: "TRXUSDT", name: "ترون", group: "کریپتو", tv: "BINANCE:TRXUSDT", bn: "TRXUSDT", yh: "TRX-USD", td: "TRX/USD" },
    { id: "TONUSDT", name: "تون‌کوین", group: "کریپتو", tv: "BINANCE:TONUSDT", bn: "TONUSDT", yh: "TON11419-USD", td: "TON/USD" },
    { id: "LINKUSDT", name: "چین‌لینک", group: "کریپتو", tv: "BINANCE:LINKUSDT", bn: "LINKUSDT", yh: "LINK-USD", td: "LINK/USD" },
    // شاخص‌ها: Twelve Data این نمادها را در پلن رایگان نمی‌دهد (HTTP 404) → Yahoo/Stooq
    { id: "DXY", name: "شاخص دلار (DXY)", group: "شاخص‌ها", tv: "TVC:DXY", td: "DXY", yh: "DX-Y.NYB", st: "dx.f", tdPaid: true },
    { id: "SPX", name: "S&P 500", group: "شاخص‌ها", tv: "FOREXCOM:SPXUSD", td: "SPX", yh: "^GSPC", st: "^spx", tdPaid: true },
    { id: "NDX", name: "Nasdaq 100", group: "شاخص‌ها", tv: "FOREXCOM:NSXUSD", td: "NDX", yh: "^NDX", st: "^ndx", tdPaid: true },
    { id: "DJI", name: "Dow Jones", group: "شاخص‌ها", tv: "FOREXCOM:DJI", td: "DJI", yh: "^DJI", st: "^dji", tdPaid: true },
    // بورس تهران — ۲۳ نماد پرتراورد با insCode تاییدشده + ترمیم خودکار insCode با جستجوی زنده‌ی TSETMC
    { id: "TSE-فولاد", name: "فولاد مبارکه", group: "بورس تهران", tv: "", tse: "46348559193224090", td: "", yh: "" },
    { id: "TSE-فملی", name: "ملی صنایع مس", group: "بورس تهران", tv: "", tse: "35425587644337450", td: "", yh: "" },
    { id: "TSE-شپنا", name: "پالایش نفت اصفهان", group: "بورس تهران", tv: "", tse: "7745894403636165", td: "", yh: "" },
    { id: "TSE-شبندر", name: "پالایش نفت بندرعباس", group: "بورس تهران", tv: "", tse: "35366681030756042", td: "", yh: "" },
    { id: "TSE-خودرو", name: "ایران خودرو", group: "بورس تهران", tv: "", tse: "65883838195688438", td: "", yh: "" },
    { id: "TSE-وبملت", name: "بانک ملت", group: "بورس تهران", tv: "", tse: "778253364357513", td: "", yh: "" },
    { id: "TSE-وتجارت", name: "بانک تجارت", group: "بورس تهران", tv: "", tse: "63917421733088077", td: "", yh: "" },
    { id: "TSE-وپاسار", name: "پاسارگاد (پاسارگاد) بانک", group: "بورس تهران", tv: "", tse: "9536587154100457", td: "", yh: "" },
    { id: "TSE-وبصادر", name: "بانک صادرات", group: "بورس تهران", tv: "", tse: "28320293733348826", td: "", yh: "" },
    { id: "TSE-شستا", name: "توسعه صنایع بهشهر", group: "بورس تهران", tv: "", tse: "2400322364771558", td: "", yh: "" },
    { id: "TSE-خساپا", name: "سیمان خوزستان و سپهر", group: "بورس تهران", tv: "", tse: "44891482026867833", td: "", yh: "" },
    { id: "TSE-ذوب", name: "ذوب آهن اصفهان", group: "بورس تهران", tv: "", tse: "71483646978964608", td: "", yh: "" },
    { id: "TSE-کگل", name: "کشت و صنعت گلبرگ", group: "بورس تهران", tv: "", tse: "35700344742885862", td: "", yh: "" },
    { id: "TSE-غگل", name: "گل گهر", group: "بورس تهران", tv: "", tse: "22299894048845903", td: "", yh: "" },
    { id: "TSE-بپاس", name: "پتروشیمی پاسارگاد", group: "بورس تهران", tv: "", tse: "51971068201094874", td: "", yh: "" },
    { id: "TSE-فنورد", name: "فولاد آلیاژی یزد", group: "بورس تهران", tv: "", tse: "56324206651661881", td: "", yh: "" },
    { id: "TSE-کچاد", name: "کالسیمنچاد (چادرملو)", group: "بورس تهران", tv: "", tse: "18027801615184692", td: "", yh: "" },
    { id: "TSE-پارسان", name: "پارسان جنوب", group: "بورس تهران", tv: "", tse: "23441366113375722", td: "", yh: "" },
    { id: "TSE-همراه", name: "همراه اول", group: "بورس تهران", tv: "", tse: "68635710163497089", td: "", yh: "" },
    { id: "TSE-شتران", name: "ایران ترانسفو", group: "بورس تهران", tv: "", tse: "51617145873056483", td: "", yh: "" },
    { id: "TSE-خمهر", name: "پتروشیمی خمیر", group: "بورس تهران", tv: "", tse: "17330546482145553", td: "", yh: "" },
    { id: "TSE-کگهر", name: "کروی (کگهر)", group: "بورس تهران", tv: "", tse: "30703140537034664", td: "", yh: "" },
    { id: "TSE-وبهمن", name: "صنایع بهمن (خودرو)", group: "بورس تهران", tv: "", tse: "18063426072758458", td: "", yh: "" },
  ];

  const TIMEFRAMES = [
    { id: "5m", label: "5m", bn: "5m", td: "5min", tv: "5", sec: 300 },
    { id: "15m", label: "15m", bn: "15m", td: "15min", tv: "15", sec: 900 },
    { id: "1h", label: "1H", bn: "1h", td: "1h", tv: "60", sec: 3600 },
    { id: "4h", label: "4H", bn: "4h", td: "4h", tv: "240", sec: 14400 },
    { id: "1d", label: "1D", bn: "1d", td: "1day", tv: "D", sec: 86400 },
  ];

  /* ---------------- tiny fetch helpers ---------------- */
  const hostOf = (u) => { try { return new URL(u).host; } catch (e) { return "منبع داده"; } };
  async function reqText(url, ms, headers) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms || 15000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: headers || {} });
      let text = "";
      try { text = await r.text(); } catch (e) { text = ""; }
      if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { status: r.status, body: text.slice(0, 300) });
      return text;
    } catch (e) {
      if (e && e.name === "AbortError") throw Object.assign(new Error("زمان انتظار تمام شد"), { kind: "timeout" });
      if (e && (e.status || e.kind)) throw e;
      // the browser hides everything behind one opaque TypeError: CORS, DNS, фильтр, offline
      throw Object.assign(new Error(hostOf(url) + ": مرورگر نتوانست وصل شود (Failed to fetch — CORS/۴۲۹/فیلترینگ)"), { kind: "cors", cause: (e && e.message) || String(e) });
    } finally { clearTimeout(timer); }
  }
  async function getText(url, ms, headers) { return reqText(url, ms, headers); }
  async function getJson(url, ms, headers) {
    const t = await getText(url, ms, headers);
    try { return JSON.parse(t); }
    catch (e) { throw Object.assign(new Error(hostOf(url) + ": پاسخ JSON نبود"), { kind: "other" }); }
  }
  /* pull an object/array out of a relay answer: raw JSON, an allorigins {contents} wrapper,
     or r.jina.ai's «Markdown Content:» envelope (verified working for the Yahoo chart API). */
  function extractJson(txt) {
    const s = String(txt == null ? "" : txt).trim();
    if (!s) throw Object.assign(new Error("پاسخ رله خالی بود"), { kind: "other" });
    if (/^\{\s*"contents"\s*:/.test(s)) {
      try { const w = JSON.parse(s); if (typeof w.contents === "string") return extractJson(w.contents); } catch (e) { /* fall through */ }
    }
    try { return JSON.parse(s); } catch (e) { /* maybe wrapped */ }
    const a = s.search(/[[{]/);
    if (a < 0) throw Object.assign(new Error("پاسخ رله JSON نبود"), { kind: "other" });
    const z = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    if (z > a) { try { return JSON.parse(s.slice(a, z + 1)); } catch (e) { /* invalid */ } }
    throw Object.assign(new Error("پاسخ رله JSON نامعتبر بود"), { kind: "other" });
  }

  /* Free CORS relays. Yahoo stopped sending Access-Control-Allow-Origin, so a relay is the
     only browser path left; r.jina.ai is the one verified to return the chart JSON intact. */
  const RELAY = [
    (u) => u,
    (u) => "https://r.jina.ai/" + u,
    (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
    (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    (u) => "https://api.cors.lol/?url=" + encodeURIComponent(u),
  ];
  /* relays rate-limit hard: keep ≤2 in flight and cool a relay down once it says 429/402 —
     otherwise every symbol in a 50-symbol scan re-hammered the same dead relay. */
  const relayState = new Map();
  let relayActive = 0; const relayQ = [];
  async function relaySlot(fn) {
    while (relayActive >= 2) await new Promise((r) => relayQ.push(r));
    relayActive++;
    try { return await fn(); }
    finally { relayActive--; const n = relayQ.shift(); if (n) n(); }
  }
  async function viaRelay(url, ms) {
    let lastErr = null;
    for (let i = 1; i < RELAY.length; i++) {
      const st = relayState.get(i) || (relayState.set(i, { cool: 0, fails: 0 }), relayState.get(i));
      if (Date.now() < st.cool) { lastErr = lastErr || new Error("رله‌ها در حالت انتظار (rate limit)"); continue; }
      try {
        const txt = await relaySlot(() => getText(RELAY[i](url), ms || 12000));
        st.fails = 0;
        return txt;
      } catch (e) {
        st.fails++;
        if (e && (e.status === 429 || e.status === 402 || /429|rate|limit|quota|too many/i.test(e.message || ""))) st.cool = Date.now() + 90000;
        else if (st.fails >= 4) st.cool = Date.now() + 60000;
        lastErr = e;
      }
    }
    throw lastErr || Object.assign(new Error("هیچ رله‌ای پاسخ نداد"), { kind: "cors" });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // null / "" must NOT become 0 (Yahoo pads holidays with null) — that bug fed fake zero-price candles
  const num = (x) => { if (x === null || x === undefined || x === "") return NaN; const v = +x; return isFinite(v) ? v : NaN; };
  const cap = (limit) => Math.max(120, Math.min(limit || 800, 1000));
  /* Persian glyphs differ between keyboards and TSETMC: ي/ك must be normalised before search. */
  const normalizeFa = (s) => String(s == null ? "" : s).replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/\u200c/g, "").replace(/\s+/g, " ").trim();

  /* ---------------- Binance (crypto + PAXG gold proxy) ---------------- */
  function parseBinance(rows) {
    return (rows || []).map((r) => ({ t: Math.floor(r[0] / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
  }
  async function fromBinance(bn, tf, limit) {
    const q = "symbol=" + bn + "&interval=" + tf.bn + "&limit=" + Math.min(limit, 1000);
    let rows, lastErr;
    for (const host of ["https://data-api.binance.vision", "https://api.binance.com"]) {
      try { rows = await getJson(host + "/api/v3/klines?" + q, 14000); break; } catch (e) { lastErr = e; }
    }
    if (!rows) throw Object.assign(new Error("Binance در دسترس نبود (" + (lastErr && lastErr.message) + ")"), { kind: "cors" });
    return parseBinance(rows);
  }

  /* ---------------- Twelve Data (optional free key) ----------------
     Real behaviour (probed): no/invalid key → HTTP 401 with a JSON body; symbol outside the
     plan (all indices on the free tier) → HTTP 404; quota → 429. The old code only saw the
     status code, so the UI said "HTTP 404 — enter a key or use 1D", which was wrong twice. */
  function tdMessage(code, msg) {
    if (code === 401 || code === 403) return "کلید Twelve Data نامعتبر یا منقضی است (401) — از twelvedata.com/pricing یک کلید رایگان بگیرید و در تنظیمات وارد کنید.";
    if (code === 404) return "این نماد در پلن فعلی Twelve Data نیست (404 — «Symbol not exists»). شاخص‌ها (DXY/SPX/NDX/DJI) در پلن رایگان Twelve Data پوشش داده نمی‌شوند و پولی‌اند؛ برای این نمادها Yahoo/Stooq استفاده می‌شود.";
    if (code === 429) return "سهمیه‌ی روزانه‌ی Twelve Data پر شد (429) — چند دقیقه بعد یا فردا دوباره امتحان کنید.";
    return "Twelve Data: " + (msg || ("HTTP " + code));
  }
  function parseTwelve(j) {
    if (j.status === "error" || !j.values) throw Object.assign(new Error(tdMessage(j.code, j.message)), { kind: j.code === 404 ? "tdNotCovered" : j.code === 401 ? "auth" : "other", status: j.code });
    return j.values.map((r) => ({
      t: Math.floor(Date.parse(r.datetime.length > 10 ? r.datetime.replace(" ", "T") + "Z" : r.datetime + "T00:00:00Z") / 1000),
      o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: r.volume ? +r.volume : 0,
    })).sort((a, b) => a.t - b.t);
  }
  async function fromTwelve(sym, tf, limit, key) {
    const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(sym) + "&interval=" + tf.td + "&outputsize=" + Math.min(limit, 5000) + "&order=ASC&timezone=UTC&apikey=" + encodeURIComponent(key);
    let text;
    try { text = await reqText(url, 18000); }
    catch (e) {
      // 401/404/429 arrive with a readable JSON body — surface THAT, not the bare status
      const body = e && e.body;
      if (body) {
        try {
          const j = JSON.parse(body);
          if (j && (j.code || j.message)) throw Object.assign(new Error(tdMessage(j.code || e.status, j.message)), { kind: (j.code || e.status) === 404 ? "tdNotCovered" : (j.code || e.status) === 401 ? "auth" : "other", status: j.code || e.status });
        } catch (x) { if (x && x.kind) throw x; }
      }
      throw e;
    }
    let j; try { j = JSON.parse(text); } catch (e) { throw Object.assign(new Error("پاسخ Twelve Data خوانا نبود"), { kind: "other" }); }
    return parseTwelve(j);
  }

  /* ---------------- Frankfurter (free FX daily, CORS open, no key) ---------------- */
  function parseFrankfurter(j, base, quote) {
    const rates = j && j.rates;
    if (!rates) throw new Error("Frankfurter: پاسخ نامعتبر");
    // modern range answer -> rates[date][QUOTE]; legacy single answer -> rates[QUOTE] + j.date
    if (typeof rates[quote] === "number") {
      const t = Math.floor(Date.parse(String(j.date || new Date().toISOString().slice(0, 10)) + "T00:00:00Z") / 1000);
      return [{ t, o: rates[quote], h: rates[quote], l: rates[quote], c: rates[quote], v: 0 }];
    }
    const dates = Object.keys(rates).filter((d) => rates[d] && isFinite(rates[d][quote])).sort();
    return dates.map((d) => {
      const v = +rates[d][quote];
      return { t: Math.floor(Date.parse(d + "T00:00:00Z") / 1000), o: v, h: v, l: v, c: v, v: 0 };
    }).filter((x) => isFinite(x.t) && x.c > 0);
  }
  async function fromFrankfurter(pair, limit) {
    const a = pair[0], b = pair[1];
    if (a === b) throw new Error("جفت‌ارز نامعتبر");
    const days = Math.max(420, Math.min(2500, Math.round(limit * 2)));
    const to = new Date(), from = new Date(Date.now() - days * 86400e3);
    const iso = (d) => d.toISOString().slice(0, 10);
    const urls = [
      "https://api.frankfurter.dev/v1/" + iso(from) + ".." + iso(to) + "?base=" + a + "&symbols=" + b,
      "https://api.frankfurter.app/" + iso(from) + ".." + iso(to) + "?base=" + a + "&symbols=" + b,
    ];
    let lastErr, candles = null;
    for (const u of urls) {
      try { candles = parseFrankfurter(await getJson(u, 15000), a, b); if (candles.length >= 60) break; } catch (e) { lastErr = e; }
    }
    if (!candles || !candles.length) throw Object.assign(new Error("Frankfurter: " + (lastErr && lastErr.message ? lastErr.message : "سابقه‌ی خالی")), { kind: "empty" });
    return { candles: candles.slice(-cap(limit)), note: "داده‌ی روزانه‌ی رایگان Frankfurter (بدون کندل دقیقه‌ای)؛ برای تایم‌فریم پایین‌تر کلید Twelve Data لازم است." };
  }

  /* ---------------- CoinGecko (silver / platinum daily, CORS open, no key) ---------------- */
  function parseCoinGecko(j, scale) {
    if (!j || !j.prices || !j.prices.length) throw new Error("CoinGecko: پاسخ نامعتبر");
    const k = scale && isFinite(scale) ? scale : 1, out = [];
    for (let i = 0; i < j.prices.length; i++) {
      const t = Math.floor(j.prices[i][0] / 1000), c = +j.prices[i][1] * k;
      if (!isFinite(t) || !isFinite(c)) continue;
      const o = out.length ? out[out.length - 1].c : c;
      out.push({ t, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 0 });
    }
    if (!out.length) throw new Error("CoinGecko: سابقه‌ی خالی");
    return out;
  }
  async function fromCoinGecko(cg, limit, scale) {
    const days = Math.max(90, Math.min(365, Math.ceil(limit / 2)));
    const j = await getJson("https://api.coingecko.com/api/v3/coins/" + cg + "/market_chart?vs_currency=usd&days=" + days + "&interval=daily", 22000);
    return parseCoinGecko(j, scale);
  }

  /* ---------------- Yahoo Finance (metals / energy / indices / FX / crypto) ----------------
     Direct calls are dead for browsers (429 + no CORS header) → every miss goes through the
     relay chain, where a smaller range keeps the relayed payload parseable. */
  function rangeForTf(id) {
    return ({
      "5m": { interval: "5m", range: "1mo" },
      "15m": { interval: "15m", range: "1mo" },
      "1h": { interval: "60m", range: "3mo" },
      "4h": { interval: "60m", range: "6mo" },
      "1d": { interval: "1d", range: "2y" },
    })[id] || { interval: "1d", range: "2y" };
  }
  const shrink = (r) => (r === "2y" ? ["2y", "1y"] : r === "6mo" ? ["6mo", "3mo"] : r === "3mo" ? ["3mo", "1mo"] : [r]);
  function parseYahoo(j) {
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res || !res.timestamp || !res.indicators || !res.indicators.quote) throw Object.assign(new Error("ساختار پاسخ Yahoo ناشناخته است"), { kind: "other" });
    const q = res.indicators.quote[0], ts = res.timestamp, out = [];
    for (let i = 0; i < ts.length; i++) {
      const o = num(q.open ? q.open[i] : NaN), h = num(q.high ? q.high[i] : NaN), l = num(q.low ? q.low[i] : NaN), c = num(q.close ? q.close[i] : NaN);
      if (![o, h, l, c].every((x) => isFinite(x))) continue;
      out.push({ t: Math.floor(ts[i]), o, h, l, c, v: isFinite(num(q.volume ? q.volume[i] : NaN)) ? +q.volume[i] : 0 });
    }
    if (!out.length) throw Object.assign(new Error("Yahoo داده‌ای برنگرداند"), { kind: "empty" });
    return out;
  }
  const yahooUrl = (ySym, interval, range) => "/v8/finance/chart/" + encodeURIComponent(ySym) + "?interval=" + interval + "&range=" + range;
  async function fromYahoo(ySym, tf, limit) {
    const r = rangeForTf(tf.id);
    const hosts = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
    let best = null, lastErr = null;
    // 1) direct (works where the network is clean and Yahoo still sends CORS headers)
    for (const h of hosts) {
      try {
        const c = parseYahoo(JSON.parse(await getText(h + yahooUrl(ySym, r.interval, r.range), 12000))).slice(-cap(limit));
        if (c.length >= 60) return c;
        if (!best || c.length > best.length) best = c;
      } catch (e) { lastErr = e; }
    }
    // 2) via relay — the relayed payload is smaller, so ask for a shorter range there
    for (const range of shrink(r.range)) {
      try {
        const txt = await viaRelay(hosts[0] + yahooUrl(ySym, r.interval, range), 12000);
        const c = parseYahoo(extractJson(txt)).slice(-cap(limit));
        if (c.length >= 60) return c;
        if (!best || c.length > best.length) best = c;
      } catch (e) { lastErr = e; }
    }
    if (best && best.length >= 60) return best;
    throw lastErr || Object.assign(new Error("Yahoo پاسخ نداد"), { kind: "cors" });
  }

  /* ---------------- Stooq (free long daily history; CORS-closed → relayed) ---------------- */
  function parseStooq(csv) {
    const lines = String(csv || "").trim().split(/\r?\n/).filter(Boolean), out = [];
    for (const ln of lines) {
      const p = ln.split(",");
      if (p.length < 5 || /^\s*date/i.test(p[0])) continue;
      const t = Math.floor(Date.parse(p[0] + "T00:00:00Z") / 1000);
      const o = num(p[1]), h = num(p[2]), l = num(p[3]), c = num(p[4]), v = num(p[5]);
      if (!isFinite(t) || !isFinite(c) || c <= 0) continue;
      out.push({ t, o: isFinite(o) ? o : c, h: isFinite(h) ? h : Math.max(o || c, c), l: isFinite(l) ? l : Math.min(o || c, c), c, v: isFinite(v) ? v : 0 });
    }
    return out.sort((a, b) => a.t - b.t);
  }
  async function fromStooq(st, limit) {
    if (!st) throw Object.assign(new Error("نماد Stooq تعریف نشده"), { kind: "other" });
    const url = "https://stooq.com/q/d/l/?s=" + encodeURIComponent(st) + "&i=d";
    const c = parseStooq(await viaRelay(url, 12000)).slice(-cap(limit));
    if (c.length < 60) throw Object.assign(new Error("Stooq: تنها " + c.length + " کندل"), { kind: "empty" });
    return c;
  }

  /* ---------------- gold-api.com (live spot, CORS open, no key) ---------------- */
  async function spotPrice(sym) {
    if (!sym || !sym.spot) return null;
    try {
      const j = await getJson("https://api.gold-api.com/price/" + sym.spot, 10000);
      if (j && isFinite(+j.price)) return { price: +j.price, src: "gold-api.com", at: j.updatedAt || "" };
    } catch (e) { /* optional nicety */ }
    try {
      const j2 = await getJson("https://api.goldprice.dev/v1/spot/" + sym.spot, 10000);
      if (j2 && isFinite(+j2.price)) return { price: +j2.price, src: "goldprice.dev", at: j2.updated_at || "" };
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ---------------- TSETMC (بورس تهران، بدون کلید) ----------------
     سرویس JSON فقط روی cdn.tsetmc.com و عملاً از IP ایران باز است؛ در غیر این صورت از
     رله‌های رایگان CORS عبور می‌کنیم. مسیرها طبق مستندات عمومی:
       /api/ClosingPrice/GetClosingPriceDailyList/:InsCode/:Top   (Top=0 → همه)
       /api/Instrument/GetInstrumentSearch/:term */
  const TSE_BASE = "https://cdn.tsetmc.com/api/";
  async function tseGet(path, ms) {
    let lastErr;
    for (const wrap of RELAY) {
      const u = wrap(TSE_BASE + path);
      try { const j = extractJson(await getText(u, ms || 9000)); if (j && typeof j === "object") return j; }
      catch (e) { lastErr = e; }
    }
    throw Object.assign(new Error("TSETMC پاسخ نداد (" + (lastErr && lastErr.message ? lastErr.message : "بدون پاسخ") + ")"), { kind: "tse" });
  }
  async function tseSearch(term) {
    const j = await tseGet("Instrument/GetInstrumentSearch/" + encodeURIComponent(normalizeFa(term)), 9000);
    const rows = j.instrumentSearch || j.instrumentSearchResult || [];
    return rows.map((r) => ({ insCode: String(r.insCode), name: r.lVal30 || r.lVal18AFC || "", ticker: r.lVal18AFC || "" }));
  }
  /* Field names differ per TSETMC endpoint and pOpening is often 0/missing — requiring it
     dropped every candle, which surfaced as «سابقه‌ای برای این نماد پیدا نشد». */
  function parseTsetmc(j) {
    const rows = (j && (j.closingPriceDaily || j.closingPriceDailyList)) || [];
    return rows.map((r) => {
      const c = isFinite(num(r.pClosing)) && num(r.pClosing) > 0 ? num(r.pClosing) : num(r.pDrCotVal);
      let o = num(r.pOpening);
      if (!isFinite(o) || o <= 0) o = num(r.priceFirst);
      if (!isFinite(o) || o <= 0) o = num(r.priceYesterday);
      if (!isFinite(o) || o <= 0) o = c;
      const hi = num(r.priceMax), lo = num(r.priceMin);
      return {
        t: Math.floor(Date.parse(String(r.dEven).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") + "T00:00:00Z") / 1000),
        o, h: isFinite(hi) && hi > 0 ? hi : Math.max(o, c), l: isFinite(lo) && lo > 0 ? lo : Math.min(o, c),
        c, v: +(r.qTotTran || r.qTotTran5J || 0),
      };
    }).filter((x) => isFinite(x.t) && isFinite(x.c) && x.c > 0).sort((a, b) => a.t - b.t);
  }
  async function fromTsetmc(insCode, limit) {
    const top = Math.min(limit, 500);
    let c = parseTsetmc(await tseGet("ClosingPrice/GetClosingPriceDailyList/" + insCode + "/" + top, 10000));
    if (c.length < 60) {   // 0 = "all history" per the API docs
      try {
        const all = parseTsetmc(await tseGet("ClosingPrice/GetClosingPriceDailyList/" + insCode + "/0", 12000));
        if (all.length > c.length) c = all;
      } catch (e) { /* keep what we have */ }
    }
    if (!c.length) throw Object.assign(new Error("TSETMC: برای این insCode سابقه‌ای برنگشت"), { kind: "empty" });
    return c;
  }
  /* insCode self-heal: a stale/wrong code answers with an empty list, so re-resolve it from
     the live instrument search using the ticker (ي/ك normalised first). */
  async function fromTsetmcSmart(sym, limit) {
    const ticker = String(sym.id || "").replace(/^TSE-/, "");
    let lastErr = null;
    if (sym.tse) {
      try { const c = await fromTsetmc(sym.tse, limit); if (c.length >= 60) return { candles: c, note: "" }; lastErr = new Error("تنها " + c.length + " کندل"); }
      catch (e) { lastErr = e; }
    }
    let hits = [];
    try { hits = await tseSearch(ticker || sym.name); } catch (e) { lastErr = lastErr || e; }
    for (const h of hits.slice(0, 3)) {
      if (h.insCode === sym.tse) continue;
      try {
        const c = await fromTsetmc(h.insCode, limit);
        if (c.length >= 60) return { candles: c, note: "insCode «" + h.insCode + "» از جستجوی زنده‌ی TSETMC ترمیم شد (" + (h.ticker || h.name) + ")." };
      } catch (e) { lastErr = e; }
    }
    throw Object.assign(new Error("TSETMC: سابقه‌ای برای «" + (ticker || sym.name) + "» پیدا نشد (" + (lastErr && lastErr.message ? lastErr.message : "بدون پاسخ") + ")"), { kind: "tse" });
  }

  /* ---------------- CSV ---------------- */
  function parseCsv(text) {
    const lines = String(text).trim().split(/\r?\n/).filter(Boolean), out = [];
    for (const ln of lines) {
      const p = ln.split(/[,;\t]/).map((s) => s.trim());
      if (p.length < 5 || isNaN(+p[1])) continue;
      let t = /^\d+$/.test(p[0]) ? +p[0] : Date.parse(p[0]) / 1000;
      if (t > 1e12) t = Math.floor(t / 1000);
      if (!isFinite(t)) continue;
      out.push({ t, o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: p[5] ? +p[5] : 0 });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /* ---------------- timeframe feasibility ----------------
     Free sources for FX / metals / indices / oil only publish daily candles.
     Asking them for 5m used to silently return daily data; now we switch the
     timeframe to 1D and tell the user why. */
  function resolveTimeframe(sym, tf, keys) {
    const hasKey = !!(keys && keys.twelve);
    if (!sym || tf.id === "1d" || sym.bn || sym.tse || hasKey) return { tf, changed: false };
    const d1 = TIMEFRAMES.find((t) => t.id === "1d") || tf;
    return { tf: d1, changed: true, reason: "منابع رایگان برای «" + sym.name + "» فقط کندل روزانه می‌دهند؛ تایم‌فریم به 1D تغییر کرد. برای تایم‌فریم‌های دقیق‌تر کلید رایگان Twelve Data را در تنظیمات وارد کنید." };
  }

  /* ---------------- failure diagnosis (per-provider, evidence-based) ----------------
     The old code appended «کلید Twelve Data را وارد کنید یا تایم‌فریم 1D» to EVERY failure —
     even for Tehran stocks, which never touch Twelve Data. */
  function diagnose(sym, tried, errs) {
    const kinds = errs.map((e) => (e && e.kind) || "other");
    const has = (k) => kinds.indexOf(k) >= 0;
    const hints = [];
    if (!tried.length) return ["برای این دارایی هیچ منبع رایگانی تنظیم نشده است."];
    if (sym.tse) {
      hints.push("سرویس TSETMC فقط از IP ایران باز است. اگر بیرون ایران هستید VPN ایران را روشن کنید، یا فایل CSV سابقه‌ی نماد را بارگذاری کنید.");
      if (has("empty")) hints.push("insCode نماد پاسخ داد ولی کندلی نداشت؛ در نسخه‌ی جدید insCode به‌صورت خودکار از جستجوی زنده‌ی TSETMC ترمیم می‌شود — اگر باز هم خالی بود، نام دقیق نماد را جستجو کنید.");
      return hints;
    }
    if (has("tdNotCovered")) hints.push("شاخص‌ها (DXY/SPX/NDX/DJI) در پلن رایگان Twelve Data نیستند؛ این نمادها از Yahoo و Stooq خوانده می‌شوند که الان پاسخ ندادند.");
    if (has("auth")) hints.push("کلید Twelve Data نامعتبر/منقضی است؛ از twelvedata.com/pricing کلید رایگان تازه بگیرید.");
    if (has("cors") || has("timeout")) hints.push("مرورگر نتوانست مستقیم به منبع داده وصل شود (Yahoo الان ۴۲۹ و بدون هدر CORS پاسخ می‌دهد و «Failed to fetch» می‌شود). رله‌های رایگان هم جواب ندادند: VPN را روشن کنید یا شبکه/مرورگر دیگری را امتحان کنید.");
    if (has("empty")) hints.push("منبع داده پاسخ داد ولی کندل کافی نداشت؛ تایم‌فریم 1D را امتحان کنید.");
    if (has("rate")) hints.push("سهمیه‌ی منبع داده پر شده؛ چند دقیقه صبر کنید.");
    if (!hints.length) hints.push("با وارد کردن کلید رایگان Twelve Data در تنظیمات، پوشش تایم‌فریم‌های پایین‌تر و شاخص‌ها بهتر می‌شود.");
    return hints;
  }

  /* ---------------- main entry ---------------- */
  async function fetchCandles(sym, tf, keys, limit = 800) {
    const errors = [];
    const errObjs = [];
    const tried = [];
    const fail = (label, e) => { tried.push(label); errObjs.push(e); errors.push(label + ": " + (e && e.message ? e.message : e)); return e; };
    const okRun = (c) => Array.isArray(c) && c.length >= 60;

    // 1) Binance — crypto + gold (PAXG proxy)
    if (sym.bn) {
      try {
        const c = await fromBinance(sym.bn, tf, limit);
        if (okRun(c)) return { candles: c, source: "Binance", note: sym.bn === "PAXGUSDT" ? "طلای توکنیزه (PAXG) به‌عنوان پروکسی قیمت طلا" : "" };
        fail("Binance", Object.assign(new Error("تنها " + c.length + " کندل"), { kind: "empty" }));
      } catch (e) { fail("Binance", e); }
    }
    // 2) TSETMC — بورس تهران (with insCode self-heal)
    if (sym.tse) {
      try {
        const r = await fromTsetmcSmart(sym, limit);
        return { candles: r.candles, source: "TSETMC (بورس تهران)", note: "داده‌ی روزانه؛ فقط از داخل ایران (یا با رله‌ی رایگان) در دسترس است." + (r.note ? " " + r.note : "") };
      } catch (e) { fail("TSETMC", e); }
    }
    // 3) Frankfurter — FX daily (a full year+ of candles, not 40 days)
    if (sym.fx) {
      try {
        const r = await fromFrankfurter(sym.fx, limit);
        if (okRun(r.candles)) return { candles: r.candles, source: "Frankfurter (رایگان)", note: r.note };
        fail("Frankfurter", Object.assign(new Error("تنها " + r.candles.length + " کندل"), { kind: "empty" }));
      } catch (e) { fail("Frankfurter", e); }
    }
    // 4) CoinGecko — silver / platinum daily
    if (sym.cg) {
      try {
        const c = await fromCoinGecko(sym.cg, limit, sym.cgScale);
        if (okRun(c)) return { candles: c, source: "CoinGecko (رایگان)", note: (sym.cgNote ? sym.cgNote + " · " : "") + "داده‌ی روزانه‌ی رایگان" };
        fail("CoinGecko", Object.assign(new Error("تنها " + c.length + " کندل"), { kind: "empty" }));
      } catch (e) { fail("CoinGecko", e); }
    }
    // 5) Yahoo — metals, oil, indices, FX, crypto fallback (direct → relay)
    if (sym.yh) {
      try {
        const c = await fromYahoo(sym.yh, tf, limit);
        if (okRun(c)) return { candles: c, source: "Yahoo Finance (" + sym.yh + ")", note: rangeForTf(tf.id).interval === "1d" ? "داده‌ی روزانه" : "" };
        fail("Yahoo", Object.assign(new Error("تنها " + c.length + " کندل"), { kind: "empty" }));
      } catch (e) { fail("Yahoo", e); }
    }
    // 6) Stooq — free long daily history (relayed), a second path for indices / metals / oil
    if (sym.st) {
      try {
        const c = await fromStooq(sym.st, limit);
        if (okRun(c)) return { candles: c, source: "Stooq (رایگان)", note: "داده‌ی روزانه‌ی رایگان Stooq" + (sym.tdPaid ? "؛ جایگزین Yahoo برای شاخص‌ها" : "") };
        fail("Stooq", Object.assign(new Error("تنها " + c.length + " کندل"), { kind: "empty" }));
      } catch (e) { fail("Stooq", e); }
    }
    // 7) Twelve Data — only with the user's free key
    if (keys && keys.twelve && sym.td) {
      try {
        const c = await fromTwelve(sym.td, tf, limit, keys.twelve);
        if (okRun(c)) return { candles: c, source: "Twelve Data", note: "" };
        fail("Twelve Data", Object.assign(new Error("تنها " + c.length + " کندل"), { kind: "empty" }));
      } catch (e) { fail("Twelve Data", e); }
    }
    const allFailed = tried.length === 0 || errObjs.length === tried.length;   // a provider that ran but threw
    throw Object.assign(new Error(errors.join(" | ") + " | راه‌حل: " + diagnose(sym, tried, allFailed ? errObjs : []).join(" ")), { tried: tried.slice(), hints: diagnose(sym, tried, allFailed ? errObjs : []) });
  }

  FA.data = {
    SYMBOLS, TIMEFRAMES, fetchCandles, parseCsv, getJson, getText, reqText, extractJson, viaRelay, sleep, num, RELAY, normalizeFa, diagnose,
    fromBinance, fromTwelve, fromFrankfurter, fromCoinGecko, fromYahoo, fromStooq, fromTsetmc, fromTsetmcSmart, tseSearch, spotPrice, tdMessage,
    parseBinance, parseTwelve, parseFrankfurter, parseCoinGecko, parseYahoo, parseStooq, parseTsetmc, rangeForTf, resolveTimeframe,
  };
})(typeof window !== "undefined" ? window : globalThis);
