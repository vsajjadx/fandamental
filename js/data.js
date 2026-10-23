/* Fandamental — market catalog + OHLC providers (all free, browser-direct).
   Chain per asset (first provider that answers wins; mirrors inside one step are HEDGED, not serial):
     Binance + Nobitex + Wallex — crypto + PAXG (gold proxy) · Nobitex/Wallex are hosted in Iran (work without VPN)
     TSETMC       — بورس تهران · no key · daily · direct, then free CORS relays
     Frankfurter  — FX daily · CORS open · no key  → returns a FULL year+ of daily candles
     CoinGecko    — silver / platinum daily · CORS open · no key
     Yahoo        — metals, energy, indices, FX, crypto fallback · CORS open · no key
     gold-api.com — live spot XAU / XAG / XPT · CORS open · no key
     Twelve Data  — optional free key · intraday FX / metals / indices / energy */
(function (g) {
  const FA = (g.FA = g.FA || {});

  /* ---------------- catalog ---------------- */
  const SYMBOLS = [
    { id: "EURUSD", name: "EUR/USD", group: "فارکس", tv: "OANDA:EURUSD", td: "EUR/USD", yh: "EURUSD=X", fx: ["EUR", "USD"] },
    { id: "GBPUSD", name: "GBP/USD", group: "فارکس", tv: "OANDA:GBPUSD", td: "GBP/USD", yh: "GBPUSD=X", fx: ["GBP", "USD"] },
    { id: "USDJPY", name: "USD/JPY", group: "فارکس", tv: "OANDA:USDJPY", td: "USD/JPY", yh: "USDJPY=X", fx: ["USD", "JPY"] },
    { id: "USDCHF", name: "USD/CHF", group: "فارکس", tv: "OANDA:USDCHF", td: "USD/CHF", yh: "USDCHF=X", fx: ["USD", "CHF"] },
    { id: "AUDUSD", name: "AUD/USD", group: "فارکس", tv: "OANDA:AUDUSD", td: "AUD/USD", yh: "AUDUSD=X", fx: ["AUD", "USD"] },
    { id: "USDCAD", name: "USD/CAD", group: "فارکس", tv: "OANDA:USDCAD", td: "USD/CAD", yh: "USDCAD=X", fx: ["USD", "CAD"] },
    { id: "NZDUSD", name: "NZD/USD", group: "فارکس", tv: "OANDA:NZDUSD", td: "NZD/USD", yh: "NZDUSD=X", fx: ["NZD", "USD"] },
    { id: "EURGBP", name: "EUR/GBP", group: "فارکس", tv: "OANDA:EURGBP", td: "EUR/GBP", yh: "EURGBP=X", fx: ["EUR", "GBP"] },
    { id: "EURJPY", name: "EUR/JPY", group: "فارکس", tv: "OANDA:EURJPY", td: "EUR/JPY", yh: "EURJPY=X", fx: ["EUR", "JPY"] },
    { id: "GBPJPY", name: "GBP/JPY", group: "فارکس", tv: "OANDA:GBPJPY", td: "GBP/JPY", yh: "GBPJPY=X", fx: ["GBP", "JPY"] },
    { id: "XAUUSD", name: "طلا (XAU/USD)", group: "فلزات و کالا", tv: "OANDA:XAUUSD", td: "XAU/USD", bn: "PAXGUSDT", spot: "XAU", yh: "GC=F", cg: "pax-gold", cgNote: "طلای توکنیزه (PAXG) به‌عنوان پروکسی قیمت طلا" },
    { id: "XAGUSD", name: "نقره (XAG/USD)", group: "فلزات و کالا", tv: "OANDA:XAGUSD", td: "XAG/USD", spot: "XAG", yh: "SI=F", cg: "kinesis-silver", cgNote: "نقره‌ی توکنیزه (KAG) به‌عنوان پروکسی قیمت نقره" },
    { id: "XPTUSD", name: "پلاتین (XPT/USD)", group: "فلزات و کالا", tv: "OANDA:XPTUSD", td: "XPT/USD", spot: "XPT", yh: "PL=F", cg: "gram-platinum", cgScale: 31.1034768, cgNote: "قیمت گرمی × ۳۱٫۱۰۳۵ = قیمت یک اونس" },
    { id: "USOIL", name: "نفت WTI", group: "فلزات و کالا", tv: "TVC:USOIL", td: "WTI/USD", yh: "CL=F" },
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
    { id: "DXY", name: "شاخص دلار (DXY)", group: "شاخص‌ها", tv: "TVC:DXY", td: "DXY", yh: "DX-Y.NYB" },
    { id: "SPX", name: "S&P 500", group: "شاخص‌ها", tv: "FOREXCOM:SPXUSD", td: "SPX", yh: "^GSPC" },
    { id: "NDX", name: "Nasdaq 100", group: "شاخص‌ها", tv: "FOREXCOM:NSXUSD", td: "NDX", yh: "^NDX" },
    { id: "DJI", name: "Dow Jones", group: "شاخص‌ها", tv: "FOREXCOM:DJI", td: "DJI", yh: "^DJI" },
    // بورس تهران — ۲۳ نماد پرتراورد با insCode تاییدشده + جستجوی زنده‌ی TSETMC برای هر نماد دیگر
    { id: "TSE-فولاد", name: "فولاد مبارکه اصفهان", group: "بورس تهران", tv: "", tse: "46348559193224090", td: "", yh: "" },
    { id: "TSE-فملی", name: "ملی صنایع مس ایران", group: "بورس تهران", tv: "", tse: "35425587644337450", td: "", yh: "" },
    { id: "TSE-شپنا", name: "پالایش نفت اصفهان", group: "بورس تهران", tv: "", tse: "7745894403636165", td: "", yh: "" },
    { id: "TSE-شبندر", name: "پالایش نفت بندرعباس", group: "بورس تهران", tv: "", tse: "35366681030756042", td: "", yh: "" },
    { id: "TSE-خودرو", name: "ایران خودرو", group: "بورس تهران", tv: "", tse: "65883838195688438", td: "", yh: "" },
    { id: "TSE-وبملت", name: "بانک ملت", group: "بورس تهران", tv: "", tse: "778253364357513", td: "", yh: "" },
    { id: "TSE-وتجارت", name: "بانک تجارت", group: "بورس تهران", tv: "", tse: "63917421733088077", td: "", yh: "" },
    { id: "TSE-وپاسار", name: "بانک پاسارگاد", group: "بورس تهران", tv: "", tse: "9536587154100457", td: "", yh: "" },
    { id: "TSE-وبصادر", name: "بانک صادرات ایران", group: "بورس تهران", tv: "", tse: "28320293733348826", td: "", yh: "" },
    { id: "TSE-شستا", name: "سرمایه‌گذاری تأمین اجتماعی", group: "بورس تهران", tv: "", tse: "2400322364771558", td: "", yh: "" },
    { id: "TSE-خساپا", name: "سایپا", group: "بورس تهران", tv: "", tse: "44891482026867833", td: "", yh: "" },
    { id: "TSE-ذوب", name: "ذوب آهن اصفهان", group: "بورس تهران", tv: "", tse: "71483646978964608", td: "", yh: "" },
    { id: "TSE-کگل", name: "معدنی و صنعتی گل‌گهر", group: "بورس تهران", tv: "", tse: "35700344742885862", td: "", yh: "" },
    { id: "TSE-غگل", name: "گلوکوزان", group: "بورس تهران", tv: "", tse: "22299894048845903", td: "", yh: "" },
    { id: "TSE-بپاس", name: "بیمه پاسارگاد", group: "بورس تهران", tv: "", tse: "51971068201094874", td: "", yh: "" },
    { id: "TSE-فنورد", name: "نورد و قطعات فولادی", group: "بورس تهران", tv: "", tse: "56324206651661881", td: "", yh: "" },
    { id: "TSE-کچاد", name: "معدنی و صنعتی چادرملو", group: "بورس تهران", tv: "", tse: "18027801615184692", td: "", yh: "" },
    { id: "TSE-پارسان", name: "گسترش نفت و گاز پارسیان", group: "بورس تهران", tv: "", tse: "23441366113375722", td: "", yh: "" },
    { id: "TSE-همراه", name: "ارتباطات سیار ایران (همراه اول)", group: "بورس تهران", tv: "", tse: "68635710163497089", td: "", yh: "" },
    { id: "TSE-شتران", name: "پالایش نفت تهران", group: "بورس تهران", tv: "", tse: "51617145873056483", td: "", yh: "" },
    { id: "TSE-خمهر", name: "مهرکام‌پارس", group: "بورس تهران", tv: "", tse: "17330546482145553", td: "", yh: "" },
    { id: "TSE-کگهر", name: "سنگ آهن گهرزمین", group: "بورس تهران", tv: "", tse: "30703140537034664", td: "", yh: "" },
    { id: "TSE-وبهمن", name: "سرمایه‌گذاری بهمن", group: "بورس تهران", tv: "", tse: "18063426072758458", td: "", yh: "" },
  ];

  const TIMEFRAMES = [
    { id: "5m", label: "5m", bn: "5m", td: "5min", tv: "5", sec: 300 },
    { id: "15m", label: "15m", bn: "15m", td: "15min", tv: "15", sec: 900 },
    { id: "1h", label: "1H", bn: "1h", td: "1h", tv: "60", sec: 3600 },
    { id: "4h", label: "4H", bn: "4h", td: "4h", tv: "240", sec: 14400 },
    { id: "1d", label: "1D", bn: "1d", td: "1day", tv: "D", sec: 86400 },
  ];

  /* کد نمادهای هاردکد قدیمی حذف شد — فهرست کامل و تاییدشده داخل SYMBOLS است؛
     هر نماد دیگری با جستجوی زنده‌ی tseSearch اضافه می‌شود. */

  /* ---------------- tiny fetch helpers ---------------- */
  async function getJson(url, ms = 15000, headers, signal) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
    let ext = null;
    if (signal) { if (signal.aborted) ctl.abort(); else { ext = () => ctl.abort(); signal.addEventListener("abort", ext, { once: true }); } }
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: headers || {} });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      throw e && e.name === "AbortError" ? new Error(signal && signal.aborted ? "لغو شد" : "زمان انتظار تمام شد") : e;
    } finally { clearTimeout(timer); if (signal && ext) signal.removeEventListener("abort", ext); }
  }

  /* Hedged requests.  Behind filtering a blocked host usually HANGS instead of failing, so a plain
     "try A, then B, then C" chain costs (timeout × hosts) before anything works.  Here the first
     task starts at once; the next one starts after `gap` ms OR as soon as the previous one fails,
     whichever is first; the first task that resolves wins and the rest are aborted.
     Each task is (signal) => Promise. Rejects (with all reasons) only if every task failed. */
  function hedge(fns, gap = 1200) {
    const ctl = new AbortController(), started = [], errs = [], timers = [];
    return new Promise((resolve, reject) => {
      let failed = 0, finished = false;
      const launch = (i) => {
        if (i >= fns.length || started[i] || finished) return;
        started[i] = true;
        Promise.resolve().then(() => fns[i](ctl.signal)).then(
          (v) => { if (finished) return; finished = true; timers.forEach(clearTimeout); ctl.abort(); resolve(v); },
          (e) => {
            if (finished) return;
            errs.push(e && e.message ? e.message : String(e));
            if (++failed === fns.length) { finished = true; timers.forEach(clearTimeout); reject(new Error(errs.join(" ؛ "))); }
            else launch(i + 1);
          });
        if (i + 1 < fns.length) timers.push(setTimeout(() => launch(i + 1), gap));
      };
      if (!fns.length) { reject(new Error("هیچ منبعی تعریف نشده")); return; }
      launch(0);
    });
  }
  /* optional personal CORS relay (e.g. your own Cloudflare Worker / server) set in Settings.
     Template: ".../?url=" (url appended, encoded) or ".../x/{url}". Used only as extra fallbacks. */
  const cfg = { relay: "" };
  function setRelay(t) {
    t = String(t || "").trim();
    cfg.relay = /^https?:\/\/\S+$/i.test(t) && (t.includes("{url}") || /[=?\/]$/.test(t)) ? t : "";
    return cfg.relay;
  }
  const viaRelay = (u) => (cfg.relay.includes("{url}") ? cfg.relay.replace("{url}", encodeURIComponent(u)) : cfg.relay + encodeURIComponent(u));
  function jsonTasks(urls, ms, parse) {
    const all = urls.slice();
    if (cfg.relay) urls.forEach((u) => all.push(viaRelay(u)));
    return all.map((u) => (signal) => getJson(u, ms, undefined, signal).then(parse || ((x) => x)));
  }
  const RELAY = [
    (u) => u,
    (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
    (u) => "https://api.cors.lol/?url=" + encodeURIComponent(u),
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // null / "" must NOT become 0 (Yahoo pads holidays with null) — that bug fed fake zero-price candles
  const num = (x) => { if (x === null || x === undefined || x === "") return NaN; const v = +x; return isFinite(v) ? v : NaN; };

  /* ---------------- Binance (crypto + PAXG gold proxy) ---------------- */
  function parseBinance(rows) {
    return (rows || []).map((r) => ({ t: Math.floor(r[0] / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
  }
  async function fromBinance(bn, tf, limit) {
    const q = "symbol=" + bn + "&interval=" + tf.bn + "&limit=" + Math.min(limit, 1000);
    try {
      return await hedge(jsonTasks(["https://data-api.binance.vision/api/v3/klines?" + q, "https://api.binance.com/api/v3/klines?" + q], 14000,
        (rows) => { const c = parseBinance(rows); if (!c.length) throw new Error("پاسخ خالی"); return c; }), 1200);
    } catch (e) { throw new Error("Binance در دسترس نبود (" + e.message + ")"); }
  }

  /* ---------------- Iranian crypto feeds (Nobitex / Wallex) ----------------
     TradingView-UDF endpoints hosted inside Iran → reachable without VPN, no key. */
  function parseUdf(j) {
    if (!j || j.s !== "ok" || !Array.isArray(j.t) || !Array.isArray(j.c)) throw new Error("UDF: " + ((j && (j.s || j.errmsg)) || "پاسخ نامعتبر"));
    const at = (a, i) => (Array.isArray(a) ? num(a[i]) : NaN);
    return j.t.map((t, i) => ({ t: +t, o: at(j.o, i), h: at(j.h, i), l: at(j.l, i), c: at(j.c, i), v: at(j.v, i) || 0 }))
      .filter((x) => isFinite(x.t) && isFinite(x.c) && x.c > 0 && isFinite(x.o) && x.o > 0)
      .map((x) => ({ t: x.t, o: x.o, h: isFinite(x.h) ? Math.max(x.h, x.o, x.c) : Math.max(x.o, x.c), l: isFinite(x.l) ? Math.min(x.l, x.o, x.c) : Math.min(x.o, x.c), c: x.c, v: x.v }))
      .sort((a, b) => a.t - b.t);
  }
  function udfUrls(bn, tf, limit) {
    const to = Math.floor(Date.now() / 1000), from = to - Math.min(limit, 1000) * tf.sec;
    const q = "?symbol=" + bn + "&resolution=" + tf.tv + "&from=" + from + "&to=" + to;
    return { Nobitex: "https://api.nobitex.ir/market/udf/history" + q, Wallex: "https://api.wallex.ir/v1/udf/history" + q };
  }
  /* crypto / PAXG: Binance mirrors + Nobitex + Wallex, hedged — first valid answer wins */
  async function fromCrypto(bn, tf, limit) {
    const u = udfUrls(bn, tf, limit);
    const tag = (name, fn) => (signal) => fn(signal).then((candles) => { if (!candles || candles.length < 60) throw new Error(name + ": تنها " + ((candles && candles.length) || 0) + " کندل"); return { candles, source: name }; });
    const q = "symbol=" + bn + "&interval=" + tf.bn + "&limit=" + Math.min(limit, 1000);
    const bin = (host) => tag("Binance", (sg) => getJson(host + "/api/v3/klines?" + q, 14000, undefined, sg).then(parseBinance));
    const udf = (name) => tag(name, (sg) => getJson(u[name], 12000, undefined, sg).then(parseUdf));
    const tasks = [bin("https://data-api.binance.vision"), udf("Nobitex"), udf("Wallex"), bin("https://api.binance.com")];
    if (cfg.relay) tasks.push(tag("Binance", (sg) => getJson(viaRelay("https://data-api.binance.vision/api/v3/klines?" + q), 16000, undefined, sg).then(parseBinance)));
    try { return await hedge(tasks, 1000); } catch (e) { throw new Error("کریپتو: هیچ منبعی پاسخ نداد (" + e.message + ")"); }
  }

  /* ---------------- Twelve Data (optional free key) ---------------- */
  function parseTwelve(j) {
    if (j.status === "error" || !j.values) throw new Error("Twelve Data: " + (j.message || "پاسخ نامعتبر"));
    return j.values.map((r) => ({
      t: Math.floor(Date.parse(r.datetime.length > 10 ? r.datetime.replace(" ", "T") + "Z" : r.datetime + "T00:00:00Z") / 1000),
      o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: r.volume ? +r.volume : 0,
    })).sort((a, b) => a.t - b.t);
  }
  async function fromTwelve(sym, tf, limit, key) {
    const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(sym) + "&interval=" + tf.td + "&outputsize=" + Math.min(limit, 5000) + "&order=ASC&timezone=UTC&apikey=" + encodeURIComponent(key);
    const j = await getJson(url, 18000);
    if (j.code === 401) throw new Error("کلید Twelve Data نامعتبر است (401)");
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
    let candles;
    try {
      candles = await hedge(jsonTasks(urls, 15000, (j) => { const c = parseFrankfurter(j, a, b); if (c.length < 60) throw new Error("تنها " + c.length + " کندل"); return c; }), 1500);
    } catch (e) { throw new Error("Frankfurter: " + (e && e.message ? e.message : "سابقه‌ی خالی")); }
    return { candles: candles.slice(-Math.max(120, Math.min(limit, 1000))), note: "داده‌ی روزانه‌ی رایگان Frankfurter (بدون کندل دقیقه‌ای)؛ برای تایم‌فریم پایین‌تر کلید Twelve Data لازم است." };
  }

  /* ---------------- CoinGecko (silver / platinum daily, CORS open, no key) ---------------- */
  function parseCoinGecko(j, scale) {
    if (!j || !j.prices || !j.prices.length) throw new Error("CoinGecko: پاسخ نامعتبر");
    const k = scale && isFinite(scale) ? scale : 1, out = [];
    const vol = new Map((j.total_volumes || []).map((x) => [Math.floor(x[0] / 1000), +x[1]]));
    for (let i = 0; i < j.prices.length; i++) {
      const t = Math.floor(j.prices[i][0] / 1000), c = +j.prices[i][1] * k;
      if (!isFinite(t) || !isFinite(c)) continue;
      const o = out.length ? out[out.length - 1].c : c;
      const v = vol.get(t);   // real 24h traded volume in USD (same timestamp as the price point)
      out.push({ t, o, h: Math.max(o, c), l: Math.min(o, c), c, v: isFinite(v) && v > 0 ? v : 0 });
    }
    if (!out.length) throw new Error("CoinGecko: سابقه‌ی خالی");
    return out;
  }
  async function fromCoinGecko(cg, limit, scale) {
    const days = Math.max(90, Math.min(365, Math.ceil(limit / 2)));
    const url = "https://api.coingecko.com/api/v3/coins/" + cg + "/market_chart?vs_currency=usd&days=" + days + "&interval=daily";
    return hedge(jsonTasks([url], 22000, (j) => parseCoinGecko(j, scale)), 1500);
  }

  /* ---------------- Yahoo Finance (metals / energy / indices / FX / crypto) ---------------- */
  function rangeForTf(id) {
    return ({
      "5m": { interval: "5m", range: "1mo" },
      "15m": { interval: "15m", range: "1mo" },
      "1h": { interval: "60m", range: "3mo" },
      "4h": { interval: "60m", range: "6mo" },
      "1d": { interval: "1d", range: "2y" },
    })[id] || { interval: "1d", range: "2y" };
  }
  function parseYahoo(j) {
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res || !res.timestamp || !res.indicators || !res.indicators.quote) throw new Error("ساختار پاسخ Yahoo ناشناخته است");
    const q = res.indicators.quote[0], ts = res.timestamp, out = [];
    for (let i = 0; i < ts.length; i++) {
      const o = num(q.open ? q.open[i] : NaN), h = num(q.high ? q.high[i] : NaN), l = num(q.low ? q.low[i] : NaN), c = num(q.close ? q.close[i] : NaN);
      if (![o, h, l, c].every((x) => isFinite(x))) continue;
      out.push({ t: Math.floor(ts[i]), o, h, l, c, v: isFinite(num(q.volume ? q.volume[i] : NaN)) ? +q.volume[i] : 0 });
    }
    if (!out.length) throw new Error("Yahoo داده‌ای برنگرداند");
    return out;
  }
  async function fromYahoo(ySym, tf, limit) {
    const r = rangeForTf(tf.id);
    const q = "?interval=" + r.interval + "&range=" + r.range;
    let j;
    const urls = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"].map((h) => h + "/v8/finance/chart/" + encodeURIComponent(ySym) + q);
    try { j = await hedge(jsonTasks(urls, 16000, (x) => { parseYahoo(x); return x; }), 1500); } catch (e) { throw new Error("Yahoo پاسخ نداد (" + e.message + ")"); }
    return parseYahoo(j).slice(-Math.max(120, Math.min(limit, 1000)));
  }

  /* ---------------- gold-api.com (live spot, CORS open, no key) ---------------- */
  async function spotPrice(sym) {
    if (!sym || !sym.spot) return null;
    try {
      return await hedge(jsonTasks(["https://api.gold-api.com/price/" + sym.spot, "https://api.goldprice.dev/v1/spot/" + sym.spot], 10000, (j) => {
        if (!j || !isFinite(+j.price)) throw new Error("قیمت نامعتبر");
        return { price: +j.price, src: j.updated_at !== undefined ? "goldprice.dev" : "gold-api.com", at: j.updatedAt || j.updated_at || "" };
      }), 1500);
    } catch (e) { /* optional nicety */ }
    return null;
  }

  /* ---------------- TSETMC (بورس تهران، بدون کلید) ----------------
     مستقیم از cdn.tsetmc.com (کامل‌ترین حالت از IP ایران) و در صورت بسته بودن،
     از سه رله‌ی رایگان CORS عبور می‌کنیم. */
  async function tseGet(path, ms) {
    const tasks = RELAY.map((wrap) => (signal) => getJson(wrap("https://cdn.tsetmc.com/api/" + path), ms || 9000, undefined, signal)
      .then((j) => { if (!j || typeof j !== "object") throw new Error("پاسخ نامعتبر"); return j; }));
    if (cfg.relay) tasks.push((signal) => getJson(viaRelay("https://cdn.tsetmc.com/api/" + path), ms || 9000, undefined, signal));
    try { return await hedge(tasks, 2500); }
    catch (e) { throw new Error("TSETMC پاسخ نداد. این سرویس معمولاً فقط از IP ایران باز می‌شود؛ از بیرون ایران رله‌ی شخصی (تنظیمات)، VPN ایران یا فایل CSV لازم است (" + (e && e.message ? e.message : "بدون پاسخ") + ")"); }
  }
  async function tseSearch(term) {
    const j = await tseGet("Instrument/GetInstrumentSearch/" + encodeURIComponent(term), 9000);
    const rows = j.instrumentSearch || [];
    return rows.map((r) => ({ insCode: String(r.insCode), name: r.lVal30 || r.lVal18AFC || "", ticker: r.lVal18AFC || "" }));
  }
  function parseTsetmc(j) {
    const rows = (j && j.closingPriceDaily) || [];
    // real cdn.tsetmc.com fields: priceFirst (open), qTotTran5J (volume), zTotTran (trades). Older field names kept as fallback.
    return rows.filter((r) => !(r.zTotTran === 0 || r.zTotTran === "0")).map((r) => {
      const c = num(r.pClosing), o = num(r.priceFirst != null ? r.priceFirst : r.pOpening);
      const oo = isFinite(o) && o > 0 ? o : num(r.priceYesterday);
      const h = num(r.priceMax), l = num(r.priceMin);
      return {
        t: Math.floor(Date.parse(String(r.dEven).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") + "T00:00:00Z") / 1000),
        o: oo, h: Math.max(h > 0 ? h : c, c, oo), l: Math.min(l > 0 ? l : c, c, oo), c, v: +(r.qTotTran5J != null ? r.qTotTran5J : r.qTotTran || 0),
      };
    }).filter((x) => isFinite(x.t) && isFinite(x.c) && x.c > 0 && isFinite(x.o) && x.o > 0).sort((a, b) => a.t - b.t);
  }
  async function fromTsetmc(insCode, limit) {
    const j = await tseGet("ClosingPrice/GetClosingPriceDailyList/" + insCode + "/" + Math.min(limit, 500), 10000);
    const c = parseTsetmc(j);
    if (!c.length) throw new Error("TSETMC: سابقه‌ای برای این نماد پیدا نشد");
    return c;
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
    // the Tehran exchange publishes daily candles only (TSETMC) — never label daily data as 5m/1H
    if (sym && (sym.tse || sym.tseIndex) && tf.id !== "1d") {
      return { tf: TIMEFRAMES.find((t) => t.id === "1d") || tf, changed: true, reason: "بورس تهران فقط داده‌ی روزانه دارد؛ تایم‌فریم به 1D تغییر کرد." };
    }
    if (!sym || tf.id === "1d" || sym.bn || sym.tse || hasKey) return { tf, changed: false };
    const d1 = TIMEFRAMES.find((t) => t.id === "1d") || tf;
    return { tf: d1, changed: true, reason: "منابع رایگان برای «" + sym.name + "» فقط کندل روزانه می‌دهند؛ تایم‌فریم به 1D تغییر کرد. برای تایم‌فریم‌های دقیق‌تر کلید رایگان Twelve Data را در تنظیمات وارد کنید." };
  }

  /* ---------------- main entry ---------------- */
  async function fetchCandles(sym, tf, keys, limit = 800) {
    const errors = [];
    const tried = [];
    const fail = (label, e) => { tried.push(label); errors.push(label + ": " + (e && e.message ? e.message : e)); };
    const okRun = (c) => Array.isArray(c) && c.length >= 60;

    // 1) crypto + gold (PAXG proxy): Binance mirrors + Iranian feeds (Nobitex/Wallex), hedged
    if (sym.bn) {
      try {
        const r = await fromCrypto(sym.bn, tf, limit);
        return { candles: r.candles, source: r.source, note: sym.bn === "PAXGUSDT" ? "طلای توکنیزه (PAXG) به‌عنوان پروکسی قیمت طلا" : "" };
      } catch (e) { fail("Crypto", e); }
    }
    // 2) TSETMC — بورس تهران
    if (sym.tse || sym.tseIndex) {
      try {
        // js/tse.js: adjusted prices + retail/institutional flow + indices; plain daily list if it is not loaded
        if (FA.tse && FA.tse.candles) return await FA.tse.candles(sym, limit);
        const c = await fromTsetmc(sym.tse, limit);
        return { candles: c, source: "TSETMC (بورس تهران)", note: "داده‌ی روزانه؛ فقط از داخل ایران (یا با رله‌ی رایگان) در دسترس است." };
      } catch (e) { fail("TSETMC", e); }
    }
    // 3) Frankfurter — FX daily (a full year+ of candles, not 40 days)
    if (sym.fx) {
      try {
        const r = await fromFrankfurter(sym.fx, limit);
        if (okRun(r.candles)) return { candles: r.candles, source: "Frankfurter (رایگان)", note: r.note };
        fail("Frankfurter", new Error("تنها " + r.candles.length + " کندل"));
      } catch (e) { fail("Frankfurter", e); }
    }
    // 4) CoinGecko — silver / platinum daily
    if (sym.cg) {
      try {
        const c = await fromCoinGecko(sym.cg, limit, sym.cgScale);
        if (okRun(c)) return { candles: c, source: "CoinGecko (رایگان)", note: (sym.cgNote ? sym.cgNote + " · " : "") + "داده‌ی روزانه‌ی رایگان" };
        fail("CoinGecko", new Error("تنها " + c.length + " کندل"));
      } catch (e) { fail("CoinGecko", e); }
    }
    // 5) Yahoo — metals, oil, indices, FX, crypto fallback
    if (sym.yh) {
      try {
        const c = await fromYahoo(sym.yh, tf, limit);
        if (okRun(c)) return { candles: c, source: "Yahoo Finance (" + sym.yh + ")", note: rangeForTf(tf.id).interval === "1d" ? "داده‌ی روزانه" : "" };
        fail("Yahoo", new Error("تنها " + c.length + " کندل"));
      } catch (e) { fail("Yahoo", e); }
    }
    // 6) Twelve Data — only with the user's free key
    if (keys && keys.twelve && sym.td) {
      try {
        const c = await fromTwelve(sym.td, tf, limit, keys.twelve);
        if (okRun(c)) return { candles: c, source: "Twelve Data", note: "" };
        fail("Twelve Data", new Error("تنها " + c.length + " کندل"));
      } catch (e) { fail("Twelve Data", e); }
    }
    if (!tried.length) errors.push("برای این دارایی هیچ منبع رایگانی تنظیم نشده است.");
    else errors.push("راه‌حل: کلید رایگان Twelve Data را در تنظیمات وارد کنید یا تایم‌فریم را 1D بگذارید.");
    throw new Error(errors.join(" | "));
  }

  FA.data = {
    SYMBOLS, TIMEFRAMES, fetchCandles, parseCsv, getJson, sleep, num, RELAY, hedge, setRelay, jsonTasks, fromCrypto, parseUdf, udfUrls,
    fromBinance, fromTwelve, fromFrankfurter, fromCoinGecko, fromYahoo, fromTsetmc, tseSearch, tseGet, spotPrice,
    parseBinance, parseTwelve, parseFrankfurter, parseCoinGecko, parseYahoo, parseTsetmc, rangeForTf, resolveTimeframe,
  };
})(typeof window !== "undefined" ? window : globalThis);
