/* Fandamental — market catalog + OHLC data providers.
   - Binance public API: no key needed (crypto, and PAXG as a gold proxy).
   - Twelve Data: free key needed for forex / metals / indices (https://twelvedata.com). */
(function (g) {
  const FA = (g.FA = g.FA || {});

  const SYMBOLS = [
    // Forex
    { id: "EURUSD", name: "EUR/USD", group: "فارکس", tv: "OANDA:EURUSD", td: "EUR/USD" },
    { id: "GBPUSD", name: "GBP/USD", group: "فارکس", tv: "OANDA:GBPUSD", td: "GBP/USD" },
    { id: "USDJPY", name: "USD/JPY", group: "فارکس", tv: "OANDA:USDJPY", td: "USD/JPY" },
    { id: "USDCHF", name: "USD/CHF", group: "فارکس", tv: "OANDA:USDCHF", td: "USD/CHF" },
    { id: "AUDUSD", name: "AUD/USD", group: "فارکس", tv: "OANDA:AUDUSD", td: "AUD/USD" },
    { id: "USDCAD", name: "USD/CAD", group: "فارکس", tv: "OANDA:USDCAD", td: "USD/CAD" },
    { id: "NZDUSD", name: "NZD/USD", group: "فارکس", tv: "OANDA:NZDUSD", td: "NZD/USD" },
    { id: "EURGBP", name: "EUR/GBP", group: "فارکس", tv: "OANDA:EURGBP", td: "EUR/GBP" },
    { id: "EURJPY", name: "EUR/JPY", group: "فارکس", tv: "OANDA:EURJPY", td: "EUR/JPY" },
    { id: "GBPJPY", name: "GBP/JPY", group: "فارکس", tv: "OANDA:GBPJPY", td: "GBP/JPY" },
    // Metals & commodities
    { id: "XAUUSD", name: "طلا (XAU/USD)", group: "فلزات و کالا", tv: "OANDA:XAUUSD", td: "XAU/USD", bn: "PAXGUSDT" },
    { id: "XAGUSD", name: "نقره (XAG/USD)", group: "فلزات و کالا", tv: "OANDA:XAGUSD", td: "XAG/USD" },
    { id: "USOIL", name: "نفت WTI", group: "فلزات و کالا", tv: "TVC:USOIL", td: "WTI/USD" },
    { id: "XPTUSD", name: "پلاتین", group: "فلزات و کالا", tv: "OANDA:XPTUSD", td: "XPT/USD" },
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
    // Indices
    { id: "DXY", name: "شاخص دلار (DXY)", group: "شاخص‌ها", tv: "TVC:DXY", td: "DXY" },
    { id: "SPX", name: "S&P 500", group: "شاخص‌ها", tv: "FOREXCOM:SPXUSD", td: "SPX" },
    { id: "NDX", name: "Nasdaq 100", group: "شاخص‌ها", tv: "FOREXCOM:NSXUSD", td: "NDX" },
    { id: "DJI", name: "Dow Jones", group: "شاخص‌ها", tv: "FOREXCOM:DJI", td: "DJI" },
  ];

  const TIMEFRAMES = [
    { id: "5m", label: "5m", bn: "5m", td: "5min", tv: "5", sec: 300 },
    { id: "15m", label: "15m", bn: "15m", td: "15min", tv: "15", sec: 900 },
    { id: "1h", label: "1H", bn: "1h", td: "1h", tv: "60", sec: 3600 },
    { id: "4h", label: "4H", bn: "4h", td: "4h", tv: "240", sec: 14400 },
    { id: "1d", label: "1D", bn: "1d", td: "1day", tv: "D", sec: 86400 },
  ];

  async function getJson(url, ms = 15000) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  async function fromBinance(sym, tf, limit) {
    const q = `symbol=${sym}&interval=${tf.bn}&limit=${Math.min(limit, 1000)}`;
    let rows, lastErr;
    for (const host of ["https://data-api.binance.vision", "https://api.binance.com"]) {
      try { rows = await getJson(`${host}/api/v3/klines?${q}`); break; } catch (e) { lastErr = e; }
    }
    if (!rows) throw new Error("دسترسی به Binance ممکن نشد (" + (lastErr && lastErr.message) + "). ممکن است نیاز به VPN باشد یا از Twelve Data استفاده کنید.");
    return rows.map((r) => ({ t: Math.floor(r[0] / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
  }

  async function fromTwelve(sym, tf, limit, key) {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${tf.td}&outputsize=${Math.min(limit, 5000)}&order=ASC&timezone=UTC&apikey=${encodeURIComponent(key)}`;
    const j = await getJson(url);
    if (j.status === "error" || !j.values) throw new Error("Twelve Data: " + (j.message || "پاسخ نامعتبر"));
    return j.values.map((r) => ({
      t: Math.floor(Date.parse(r.datetime.length > 10 ? r.datetime.replace(" ", "T") + "Z" : r.datetime + "T00:00:00Z") / 1000),
      o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: r.volume ? +r.volume : 0,
    }));
  }

  /* Returns { candles, source, note }. */
  async function fetchCandles(sym, tf, keys, limit = 800) {
    const errors = [];
    const tryTwelve = keys && keys.twelve;
    if (sym.bn && (!tryTwelve || sym.group === "کریپتو")) {
      try {
        const candles = await fromBinance(sym.bn, tf, limit);
        return { candles, source: "Binance", note: sym.bn !== sym.id ? `از ${sym.bn} به‌عنوان جایگزین قیمت استفاده شد` : "" };
      } catch (e) { errors.push(e.message); }
    }
    if (tryTwelve) {
      try { return { candles: await fromTwelve(sym.td, tf, limit, keys.twelve), source: "Twelve Data", note: "" }; } catch (e) { errors.push(e.message); }
    }
    if (sym.bn && tryTwelve) {
      try { return { candles: await fromBinance(sym.bn, tf, limit), source: "Binance", note: "" }; } catch (e) { errors.push(e.message); }
    }
    if (!tryTwelve && !sym.bn) errors.push("برای این دارایی باید کلید رایگان Twelve Data را در تنظیمات وارد کنید.");
    throw new Error(errors.join(" | "));
  }

  /* Parse CSV text: time,open,high,low,close[,volume] (time = unix seconds/ms or ISO date). */
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

  FA.data = { SYMBOLS, TIMEFRAMES, fetchCandles, parseCsv };
})(typeof window !== "undefined" ? window : globalThis);
