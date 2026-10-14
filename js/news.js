/* Fandamental — free news + macro-calendar layer (no key, browser-direct).
   - economicCalendar(): ForexFactory weekly mirror (nfs.faireconomy.media) — CORS open, always free.
   - GDELT DOC API: live world headlines per asset (throttled ~1 req / 5s, allowed span).
   - Relevant events (Fed, CPI, OPEC…) are attached to the analysis and shown next to it. */
(function (g) {
  const FA = (g.FA = g.FA || {});

  let calPromise = null;
  async function economicCalendar() {
    if (!calPromise) {
      calPromise = (async () => {
        const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
        try {
          const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { signal: ctl.signal });
          if (!r.ok) throw new Error("HTTP " + r.status);
          const j = await r.json();
          if (!Array.isArray(j)) throw new Error("پاسخ نامعتبر");
          return j.map((e) => {
            const imp = String(e.impact || "").toLowerCase();
            return {
              title: e.title || "", country: e.country || "",
              ts: e.date ? Date.parse(e.date) / 1000 : 0,
              date: e.date ? new Date(e.date).toLocaleString("fa-IR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "",
              impact: imp === "high" ? "high" : imp === "medium" ? "medium" : "low",
              forecast: e.forecast || "", previous: e.previous || "", actual: e.actual || "",
            };
          }).filter((e) => e.ts);
        } finally { clearTimeout(t); }
      })();
      calPromise.catch(() => { calPromise = null; });
    }
    return calPromise;
  }

  let gdeltNext = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function getJson(url, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 12000);
    try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
    finally { clearTimeout(t); }
  }
  async function gdeltNews(q, max, span) {
    const wait = gdeltNext - Date.now();
    if (wait > 0) await sleep(wait);
    gdeltNext = Date.now() + 5200;
    const j = await getJson(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q + " sourcelang:english")}&mode=artlist&format=json&maxrecords=${max || 25}&timespan=${span || "3d"}&sort=datedesc`, 15000);
    return (j.articles || []).map((a) => ({
      title: a.title || "", src: a.domain || "", url: a.url || "",
      ts: /^\d{8}/.test(a.seendate || "") ? Date.parse(`${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}T${a.seendate.slice(9, 11) || "00"}:${a.seendate.slice(11, 13) || "00"}:00Z`) / 1000 : 0,
    })).filter((h) => h.title);
  }

  const COIN = { BTCUSDT: "bitcoin", ETHUSDT: "ethereum", BNBUSDT: '"BNB Chain"', SOLUSDT: "solana", XRPUSDT: "XRP ripple", ADAUSDT: "cardano", DOGEUSDT: "dogecoin", TRXUSDT: "tron crypto", TONUSDT: "toncoin", LINKUSDT: "chainlink" };
  const FIXED = {
    XAUUSD: "(gold OR bullion) (price OR Fed OR dollar)", XAGUSD: "silver (price OR Fed OR dollar)", XPTUSD: "platinum price", USOIL: "(oil OR crude) (OPEC OR price OR inventories)",
    DXY: '("dollar index" OR "US dollar") (Fed OR inflation)', SPX: '("S&P 500" OR "Wall Street")', NDX: "Nasdaq (stocks OR Fed)", DJI: '("Dow Jones" OR "Wall Street")',
  };
  const CCY = { EUR: ["euro", "ECB"], USD: ["dollar", "Fed"], GBP: ["sterling", '"Bank of England"'], JPY: ["yen", '"Bank of Japan"'], CHF: ['"Swiss franc"', "SNB"], AUD: ['"Australian dollar"', "RBA"], CAD: ['"Canadian dollar"', '"Bank of Canada"'], NZD: ['"New Zealand dollar"', "RBNZ"] };
  function newsQuery(sym) {
    if (FIXED[sym.id]) return FIXED[sym.id];
    if (sym.group === "کریپتو") return `${COIN[sym.id] || sym.id.replace("USDT", "")} (crypto OR price OR market)`;
    if (sym.group === "بورس تهران") return `(Tehran stock exchange OR tsetmc OR "${sym.name.replace(/[()]/g, "")}")`;
    const a = sym.id.slice(0, 3), b = sym.id.slice(3, 6);
    if (CCY[a] && CCY[b]) return "(" + CCY[a].concat(CCY[b]).join(" OR ") + ")";
    return sym.name.replace(/[^\x00-\x7F]+/g, "").trim() || sym.id;
  }

  async function assetNews(sym) {
    try { return await gdeltNews(newsQuery(sym), 25, "3d"); }
    catch (e) { return []; }
  }

  /* headline/event -> currency -> does it touch our symbol? */
  function symbolCurrencies(sym) {
    const set = new Set();
    if (sym.fx) sym.fx.forEach((x) => set.add(x));
    else if (sym.group === "کریپتو") set.add("USD");
    else if (sym.id === "XAUUSD" || sym.id === "XAGUSD" || sym.id === "XPTUSD" || sym.id === "USOIL") set.add("USD");
    else if (sym.group === "شاخص‌ها") set.add("USD");
    else if (sym.group === "بورس تهران") set.add("IRR");
    return set;
  }
  function matchCalendar(events, sym) {
    const cur = symbolCurrencies(sym);
    return events.filter((e) => cur.has(e.country)).sort((a, b) => b.ts - a.ts);
  }

  FA.news = { economicCalendar, gdeltNews, newsQuery, assetNews, matchCalendar, symbolCurrencies };
})(typeof window !== "undefined" ? window : globalThis);
