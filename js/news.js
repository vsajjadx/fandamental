/* Fandamental — free news + macro-calendar layer (no key, browser-direct).
   Providers (in order, each with a timeout + free CORS relays):
     1) GDELT DOC 2.0     — live world headlines for the asset (API throttles ~1 req / 5 s)
     2) Yahoo Finance     — per-symbol news search (fallback)
     3) ForexFactory weekly calendar (nfs.faireconomy.media) — high/medium/low impact events
   Nothing is allowed to hang: every call has a timeout, falls back to a relay, then to a
   12-hour localStorage cache, and finally returns a real error text the UI can render. */
(function (g) {
  const FA = (g.FA = g.FA || {});
  const LS = "fa_news_cache_v2";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TSE_GROUP = (function () { try { return (FA.data.SYMBOLS.find((s) => s.tse) || {}).group || "بورس تهران"; } catch (e) { return "بورس تهران"; } })();

  function cacheRead() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } }
  function cacheWrite(k, v) { try { const c = cacheRead(); c[k] = { t: Date.now(), v }; localStorage.setItem(LS, JSON.stringify(c)); } catch (e) { /* storage blocked */ } }
  function cacheGet(k, maxAge) { const c = cacheRead()[k]; return c && c.v && Date.now() - c.t < (maxAge || 12 * 3600e3) ? c.v : null; }

  async function fetchText(url, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 15000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json, text/plain, */*" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) {
      throw e && e.name === "AbortError" ? new Error("زمان انتظار تمام شد") : e;
    } finally { clearTimeout(t); }
  }
  const RELAY = (FA.data && FA.data.RELAY) || [(u) => u];
  async function relayJson(url, ms) {
    let lastErr;
    for (const wrap of RELAY) {
      try { const j = JSON.parse(await fetchText(wrap(url), ms)); if (j && typeof j === "object") return j; }
      catch (e) { lastErr = e; await sleep(150); }
    }
    throw lastErr || new Error("پاسخ نامعتبر");
  }

  /* ---------------- economic calendar ---------------- */
  function normalizeEvent(e) {
    const imp = String(e.impact || "").toLowerCase();
    return {
      title: e.title || "", country: e.country || "",
      ts: e.date ? Date.parse(e.date) / 1000 : 0,
      date: e.date ? new Date(e.date).toLocaleString("fa-IR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "",
      impact: imp === "high" ? "high" : imp === "medium" ? "medium" : "low",
      forecast: e.forecast || "", previous: e.previous || "", actual: e.actual || "",
    };
  }
  function parseCalendar(j) {
    if (!Array.isArray(j)) throw new Error("پاسخ نامعتبر");
    const out = j.map(normalizeEvent).filter((e) => e.ts);
    if (!out.length) throw new Error("تقویم خالی");
    return out;
  }
  let calPromise = null;
  async function economicCalendar() {
    if (!calPromise) {
      calPromise = (async () => {
        try {
          const v = parseCalendar(await relayJson("https://nfs.faireconomy.media/ff_calendar_thisweek.json", 15000));
          cacheWrite("cal", v);
          return v;
        } catch (e) {
          const cached = cacheGet("cal", 7 * 24 * 3600e3);
          if (cached) return cached;
          throw new Error("تقویم اقتصادی در دسترس نیست (" + e.message + ")");
        }
      })();
      calPromise.catch(() => { calPromise = null; });
    }
    return calPromise;
  }

  /* ---------------- GDELT headlines ---------------- */
  let gdeltNext = 0;
  async function gdeltNews(q, max, span) {
    const wait = gdeltNext - Date.now();
    if (wait > 0) await sleep(wait);
    gdeltNext = Date.now() + 5200;
    const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + encodeURIComponent(q + " sourcelang:english") +
      "&mode=artlist&format=json&maxrecords=" + (max || 25) + "&timespan=" + (span || "3d") + "&sort=datedesc";
    let j;
    try { j = await relayJson(url, 16000); }
    catch (e) {
      gdeltNext = Date.now() + 7000;                 // back off, then one polite retry
      await sleep(6000);
      j = await relayJson(url, 16000);
    }
    if (j && j.error) throw new Error(String(j.error).slice(0, 90));
    return (j.articles || []).map((a) => ({
      title: a.title || "", src: a.domain || "", url: a.url || "",
      ts: /^\d{8}/.test(a.seendate || "") ? Date.parse(a.seendate.slice(0, 4) + "-" + a.seendate.slice(4, 6) + "-" + a.seendate.slice(6, 8)) / 1000 : 0,
    })).filter((h) => h.title);
  }

  /* ---------------- Yahoo Finance news search (fallback) ---------------- */
  function yahooUrl(sym) {
    const q = sym.yh || sym.tv || sym.id;
    return "https://query1.finance.yahoo.com/v1/finance/search?q=" + encodeURIComponent(q) + "&newsCount=20&quotesCount=0&enableFuzzyQuery=false";
  }
  function parseYahooNews(j) {
    return ((j && j.news) || []).map((n) => ({
      title: n.title || "", src: n.publisher || "Yahoo Finance", url: n.link || "",
      ts: n.providerPublishTime ? +n.providerPublishTime : 0,
    })).filter((h) => h.title);
  }

  /* ---------------- per-asset news query ---------------- */
  const COIN = { BTCUSDT: "bitcoin", ETHUSDT: "ethereum", BNBUSDT: '"BNB Chain"', SOLUSDT: "solana", XRPUSDT: "XRP ripple", ADAUSDT: "cardano", DOGEUSDT: "dogecoin", TRXUSDT: "tron crypto", TONUSDT: "toncoin", LINKUSDT: "chainlink" };
  const FIXED = {
    XAUUSD: "(gold OR bullion) (price OR Fed OR dollar)", XAGUSD: "silver (price OR Fed OR dollar)", XPTUSD: "platinum price", USOIL: "(oil OR crude) (OPEC OR price OR inventories)",
    DXY: '("dollar index" OR "US dollar") (Fed OR inflation)', SPX: '("S&P 500" OR "Wall Street")', NDX: "Nasdaq (stocks OR Fed)", DJI: '("Dow Jones" OR "Wall Street")',
  };
  const CCY = { EUR: ["euro", "ECB"], USD: ["dollar", "Fed"], GBP: ["sterling", '"Bank of England"'], JPY: ["yen", '"Bank of Japan"'], CHF: ['"Swiss franc"', "SNB"], AUD: ['"Australian dollar"', "RBA"], CAD: ['"Canadian dollar"', '"Bank of Canada"'], NZD: ['"New Zealand dollar"', "RBNZ"] };
  function newsQuery(sym) {
    if (FIXED[sym.id]) return FIXED[sym.id];
    if (sym.group === "کریپتو") return (COIN[sym.id] || sym.id.replace("USDT", "")) + " (crypto OR price OR market)";
    if (sym.group === TSE_GROUP) return '(Tehran stock exchange OR tsetmc OR "Iran stock market")';
    const a = sym.id.slice(0, 3), b = sym.id.slice(3, 6);
    if (CCY[a] && CCY[b]) return "(" + CCY[a].concat(CCY[b]).join(" OR ") + ")";
    return sym.name.replace(/[^\x00-\x7F]+/g, "").trim() || sym.id;
  }

  /* Always resolves. Returns { list, source, error } so the UI can show a final state. */
  async function assetNews(sym) {
    const out = { list: [], source: "", error: "" };
    try {
      out.list = await gdeltNews(newsQuery(sym), 25, "3d");
      if (out.list.length) { out.source = "GDELT (رایگان)"; cacheWrite("news:" + sym.id, out.list); return out; }
    } catch (e) { out.error = "GDELT: " + e.message; }
    try {
      const y = parseYahooNews(await relayJson(yahooUrl(sym), 15000));
      if (y.length) { out.list = y; out.source = "Yahoo Finance"; out.error = ""; cacheWrite("news:" + sym.id, y); return out; }
    } catch (e) { out.error += (out.error ? " · " : "") + "Yahoo: " + e.message; }
    const cached = cacheGet("news:" + sym.id);
    if (cached) { out.list = cached; out.source = "حافظه‌ی موقت مرورگر"; return out; }
    if (!out.error) out.error = "خبر تازه‌ای برای این نماد پیدا نشد";
    return out;
  }

  /* headline/event -> currency -> does it touch our symbol? */
  function symbolCurrencies(sym) {
    const set = new Set();
    if (sym.fx) sym.fx.forEach((x) => set.add(x));
    else if (sym.group === "کریپتو") set.add("USD");
    else if (sym.spot || sym.id === "USOIL") set.add("USD");
    else if (sym.group === "شاخص‌ها") set.add("USD");
    else if (sym.group === TSE_GROUP) set.add("IRR");
    return set;
  }
  function matchCalendar(events, sym) {
    const cur = symbolCurrencies(sym);
    return (events || []).filter((e) => cur.has(e.country)).sort((a, b) => b.ts - a.ts);
  }

  FA.news = { economicCalendar, gdeltNews, newsQuery, assetNews, matchCalendar, symbolCurrencies, parseCalendar, parseYahooNews };
})(typeof window !== "undefined" ? window : globalThis);
