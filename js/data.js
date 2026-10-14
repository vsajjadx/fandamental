/* Fandamental — market catalog + OHLC data providers (all free, browser-direct).
   - Binance (crypto)          — CORS open, no key.
   - Frankfurter (FX daily)    — CORS open, no key.
   - CoinGecko (silver/platinum daily) — CORS open, no key.
   - Twelve Data (optional key) — forex, metals, indices, energy.
   - TSETMC (بورس تهران)       — مستقیم از cdn.tsetmc.com؛ بدون کلید. فقط از داخل ایران قابل دسترس است. */
(function (g) {
  const FA = (g.FA = g.FA || {});

  const SYMBOLS = [
    // Forex
    { id: "EURUSD", name: "EUR/USD", group: "فارکس", tv: "OANDA:EURUSD", td: "EUR/USD", fx: ["EUR", "USD"] },
    { id: "GBPUSD", name: "GBP/USD", group: "فارکس", tv: "OANDA:GBPUSD", td: "GBP/USD", fx: ["GBP", "USD"] },
    { id: "USDJPY", name: "USD/JPY", group: "فارکس", tv: "OANDA:USDJPY", td: "USD/JPY", fx: ["USD", "JPY"] },
    { id: "USDCHF", name: "USD/CHF", group: "فارکس", tv: "OANDA:USDCHF", td: "USD/CHF", fx: ["USD", "CHF"] },
    { id: "AUDUSD", name: "AUD/USD", group: "فارکس", tv: "OANDA:AUDUSD", td: "AUD/USD", fx: ["AUD", "USD"] },
    { id: "USDCAD", name: "USD/CAD", group: "فارکس", tv: "OANDA:USDCAD", td: "USD/CAD", fx: ["USD", "CAD"] },
    { id: "NZDUSD", name: "NZD/USD", group: "فارکس", tv: "OANDA:NZDUSD", td: "NZD/USD", fx: ["NZD", "USD"] },
    { id: "EURGBP", name: "EUR/GBP", group: "فارکس", tv: "OANDA:EURGBP", td: "EUR/GBP", fx: ["EUR", "GBP"] },
    { id: "EURJPY", name: "EUR/JPY", group: "فارکس", tv: "OANDA:EURJPY", td: "EUR/JPY", fx: ["EUR", "JPY"] },
    { id: "GBPJPY", name: "GBP/JPY", group: "فارکس", tv: "OANDA:GBPJPY", td: "GBP/JPY", fx: ["GBP", "JPY"] },
    // Metals & commodities
    { id: "XAUUSD", name: "طلا (XAU/USD)", group: "فلزات و کالا", tv: "OANDA:XAUUSD", td: "XAU/USD", bn: "PAXGUSDT", cg: "pax-gold", fxUSD: true },
    { id: "XAGUSD", name: "نقره (XAG/USD)", group: "فلزات و کالا", tv: "OANDA:XAGUSD", td: "XAG/USD", cg: "silver-one" },
    { id: "XPTUSD", name: "پلاتین (XPT/USD)", group: "فلزات و کالا", tv: "OANDA:XPTUSD", td: "XPT/USD", cg: "platinum" },
    { id: "USOIL", name: "نفت WTI", group: "فلزات و کالا", tv: "TVC:USOIL", td: "WTI/USD" },
    // Crypto
    { id: "BTCUSDT", name: "بیت‌کوین", group: "کریپتو", tv: "BINANCE:BTCUSDT", bn: "BTCUSDT", td: "BTC/USD" },
    { id: "ETHUSDT", name: "اتریوم", group: "کریپتو", tv: "BINANCE:ETHUSDT", bn: "ETHUSDT", td: "ETH/USD" },
    { id: "BNBUSDT", name: "BNB", group: "کریپتو", tv: "BINANCE:BNBUSDT", bn: "BNBUSDT", td: "BNB/USD" },
    { id: "SOLUSDT", name: "سولانا", group: "کریپتو", tv: "BINANCE:SOLUSDT", bn: "SOLUSDT", td: "SOL/USD" },
    { id: "XRPUSDT", name: "ریپل", group: "کریپتو", tv: "BINANCE:XRPUSDT", bn: "XRPUSDT", td: "XRP/USD" },
    { id: "ADAUSDT", name: "کاردانو", group: "کریپتو", tv: "BINANCE:ADAUSDT", bn: "ADAUSDT", td: "ADA/USD" },
    { id: "DOGEUSDT", name: "دوج‌کوین", group: "کریپتو", tv: "BINANCE:DOGEUSDT", bn: "DOGEUSDT", td: "DOGE/USD" },
    { id: "TRXUSDT", name: "ترون", group: "کریپتو", tv: "BINANCE:TRXUSDT", bn: "TRXUSDT", td: "TRX/USD" },
    { id: "TONUSDT", name: "تون‌کوین", group: "کریپتو", tv: "BINANCE:TONUSDT", bn: "TONUSDT", td: "TON/USD" },
    { id: "LINKUSDT", name: "چین‌لینک", group: "کریپتو", tv: "BINANCE:LINKUSDT", bn: "LINKUSDT", td: "LINK/USD" },
    // Indices & energy — daily; multi-timeframe needs a Twelve Data key
    { id: "DXY", name: "شاخص دلار (DXY)", group: "شاخص‌ها", tv: "TVC:DXY", td: "DXY" },
    { id: "SPX", name: "S&P 500", group: "شاخص‌ها", tv: "FOREXCOM:SPXUSD", td: "SPX" },
    { id: "NDX", name: "Nasdaq 100", group: "شاخص‌ها", tv: "FOREXCOM:NSXUSD", td: "NDX" },
    { id: "DJI", name: "Dow Jones", group: "شاخص‌ها", tv: "FOREXCOM:DJI", td: "DJI" },
    // بورس تهران — با جستجوی زنده‌ی TSETMC هر نمادی قابل افزودن است
    { id: "TSE-فولاد", name: "فولاد مبارکه", group: "بورس تهران", tv: "", tse: "46348559193224090", td: "" },
  ];

  const TIMEFRAMES = [
    { id: "5m", label: "5m", bn: "5m", td: "5min", tv: "5", sec: 300 },
    { id: "15m", label: "15m", bn: "15m", td: "15min", tv: "15", sec: 900 },
    { id: "1h", label: "1H", bn: "1h", td: "1h", tv: "60", sec: 3600 },
    { id: "4h", label: "4H", bn: "4h", td: "4h", tv: "240", sec: 14400 },
    { id: "1d", label: "1D", bn: "1d", td: "1day", tv: "D", sec: 86400 },
  ];

  const TSE_IDS = { "فولاد": "46348559193224090" };

  async function getJson(url, ms = 15000, headers) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: headers || {} });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- Binance (crypto) ---------- */
  async function fromBinance(bn, tf, limit) {
    const q = `symbol=${bn}&interval=${tf.bn}&limit=${Math.min(limit, 1000)}`;
    let rows, lastErr;
    for (const host of ["https://data-api.binance.vision", "https://api.binance.com"]) {
      try { rows = await getJson(`${host}/api/v3/klines?${q}`); break; } catch (e) { lastErr = e; }
    }
    if (!rows) throw new Error("دسترسی به Binance ممکن نشد (" + (lastErr && lastErr.message) + ").");
    return rows.map((r) => ({ t: Math.floor(r[0] / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
  }

  /* ---------- Twelve Data (optional key) ---------- */
  async function fromTwelve(sym, tf, limit, key) {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${tf.td}&outputsize=${Math.min(limit, 5000)}&order=ASC&timezone=UTC&apikey=${encodeURIComponent(key)}`;
    const j = await getJson(url);
    if (j.status === "error" || !j.values) throw new Error("Twelve Data: " + (j.message || "پاسخ نامعتبر"));
    return j.values.map((r) => ({
      t: Math.floor(Date.parse(r.datetime.length > 10 ? r.datetime.replace(" ", "T") + "Z" : r.datetime + "T00:00:00Z") / 1000),
      o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: r.volume ? +r.volume : 0,
    }));
  }

  /* ---------- Frankfurter (free FX daily, CORS open) ---------- */
  async function fromFrankfurter(pair, limit) {
    const [a, b] = pair;
    if (a === b) throw new Error("جفت‌ارز نامعتبر.");
    let j = null;
    try { j = await getJson(`https://api.frankfurter.dev/v1/${a}/latest?base=${a}&symbols=${b}`); }
    catch (e) { j = await getJson(`https://api.frankfurter.app/latest?from=${a}&to=${b}`); }
    if (!j || !j.rates || !(b in (j.rates || {}))) throw new Error("Frankfurter: پاسخ نامعتبر");
    const last = j.rates[b], base = j.date;
    const from = new Date(base); from.setDate(from.getDate() - 40);
    const iso = from.toISOString().slice(0, 10);
    let h = null;
    try { h = await getJson(`https://api.frankfurter.dev/v1/${iso}?base=${a}&symbols=${b}`); }
    catch (e) { try { h = await getJson(`https://api.frankfurter.app/${iso}?from=${a}&to=${b}`); } catch (e2) {} }
    const series = h && h.rates && h.rates[b] ? h.rates[b] : {};
    const dates = Object.keys(series).sort();
    if (!dates.length) throw new Error("Frankfurter: سابقه‌ی خالی");
    const out = [];
    for (const d of dates) out.push({ t: Math.floor(Date.parse(d + "T00:00:00Z") / 1000), o: series[d], h: series[d], l: series[d], c: series[d], v: 0 });
    if (base !== dates[dates.length - 1]) out.push({ t: Math.floor(Date.parse(base + "T00:00:00Z") / 1000), o: last, h: last, l: last, c: last, v: 0 });
    return { candles: out, note: "داده‌ی روزانه‌ی رایگان (بدون کندل دقیقه‌ای). برای تایم‌فریم‌های پایین‌تر کلید Twelve Data لازم است." };
  }

  /* ---------- CoinGecko (silver / platinum daily, CORS open, no key) ---------- */
  async function fromCoinGecko(cg, limit) {
    const days = Math.max(30, Math.min(365, Math.ceil(limit / 2)));
    const j = await getJson(`https://api.coingecko.com/api/v3/coins/${cg}/market_chart?vs_currency=usd&days=${days}&interval=daily`, 20000);
    if (!j.prices || !j.prices.length) throw new Error("CoinGecko: پاسخ نامعتبر");
    const out = [];
    for (let i = 0; i < j.prices.length; i++) {
      const t = Math.floor(j.prices[i][0] / 1000), c = j.prices[i][1];
      const o = i ? j.prices[i - 1][1] : c;
      out.push({ t, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 0 });
    }
    return { candles: out, note: "داده‌ی روزانه‌ی رایگان (بدون کندل دقیقه‌ای). برای تایم‌فریم‌های پایین‌تر کلید Twelve Data لازم است." };
  }

  /* ---------- TSETMC (بورس تهران، بدون کلید؛ فقط از IP ایران) ---------- */
  async function tseSearch(term) {
    let j;
    try { j = await getJson(`https://cdn.tsetmc.com/api/Instrument/GetInstrumentSearch/${encodeURIComponent(term)}`, 12000, { "User-Agent": "Mozilla/5.0" }); }
    catch (e) { throw new Error("دسترسی به TSETMC برقرار نشد (" + e.message + "). این API فقط از داخل ایران باز می‌شود؛ برای دسترسی از خارج، کلید Twelve Data نگیرید و نمادهای بورس تهران را در محیط داخل ایران باز کنید."); }
    const rows = j.instrumentSearch || j["instrumentSearch"] || [];
    return rows.map((r) => ({ insCode: String(r.insCode), name: r.lVal30 || r.lVal18AFC || "", ticker: r.lVal18AFC || "" }));
  }
  async function fromTsetmc(insCode, limit) {
    let j;
    try {
      j = await getJson(`https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/${insCode}/${Math.min(limit, 500)}`, 15000, { "User-Agent": "Mozilla/5.0" });
    } catch (e) { throw new Error("دریافت سابقه‌ی نماد از TSETMC ممکن نشد (" + e.message + "). این API فقط از داخل ایران در دسترس است."); }
    const rows = j.closingPriceDaily || [];
    if (!rows.length) throw new Error("TSETMC: سابقه‌ای برای این نماد پیدا نشد.");
    return rows.map((r) => ({
      t: Math.floor(Date.parse(String(r.dEven).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") + "T00:00:00Z") / 1000),
      o: +r.pOpening, h: +r.priceMax, l: +r.priceMin, c: +r.pClosing, v: +(r.qTotTran || 0),
    }));
  }

  /* ---------- CSV ---------- */
  function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/).filter(Boolean), out = [];
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

  /* ---------- main entry ---------- */
  async function fetchCandles(sym, tf, keys, limit = 800) {
    const errors = [];
    const tryTwelve = keys && keys.twelve;
    // 1) Binance for crypto (and PAXG as gold proxy)
    if (sym.bn && (sym.group === "کریپتو" || sym.id === "XAUUSD")) {
      try {
        const candles = await fromBinance(sym.bn, tf, limit);
        return { candles, source: "Binance", note: sym.id === "XAUUSD" ? "از PAXG (طلای توکنیزه) به‌عنوان پروکسی طلا استفاده شد" : "" };
      } catch (e) { errors.push(e.message); }
    }
    // 2) TSETMC for بورس تهران
    if (sym.tse) {
      try {
        const code = sym.tse || (TSE_IDS[sym.id.replace("TSE-", "")] || "");
        const candles = await fromTsetmc(code, limit);
        return { candles, source: "TSETMC (بورس تهران)", note: "داده‌ی روزانه؛ فقط از داخل ایران در دسترس است." };
      } catch (e) { errors.push(e.message); }
    }
    // 3) Frankfurter for FX (free daily)
    if (sym.fx) {
      try { const r = await fromFrankfurter(sym.fx, limit); return { candles: r.candles, source: "Frankfurter (رایگان)", note: r.note }; }
      catch (e) { errors.push(e.message); }
    }
    // 4) CoinGecko for silver/platinum (free daily)
    if (sym.cg) {
      try { const r = await fromCoinGecko(sym.cg, limit); return { candles: r.candles, source: "CoinGecko (رایگان)", note: r.note }; }
      catch (e) { errors.push(e.message); }
    }
    // 5) Twelve Data (needs key) — last resort
    if (tryTwelve) {
      try { return { candles: await fromTwelve(sym.td, tf, limit, keys.twelve), source: "Twelve Data", note: "" }; }
      catch (e) { errors.push(e.message); }
    }
    if (!tryTwelve && !sym.bn && !sym.fx && !sym.cg && !sym.tse) {
      errors.push("برای این دارایی باید کلید رایگان Twelve Data را در تنظیمات وارد کنید (شاخص‌ها و نفت به داده‌ی دقیقه‌ای نیاز دارند).");
    }
    throw new Error(errors.join(" | "));
  }

  FA.data = { SYMBOLS, TIMEFRAMES, TSE_IDS, fetchCandles, parseCsv, fromBinance, fromTwelve, fromFrankfurter, fromCoinGecko, fromTsetmc, tseSearch, getJson, sleep };
})(typeof window !== "undefined" ? window : globalThis);
