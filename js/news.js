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

  /* ---------------- GDELT news tone → free fundamental sentiment (no AI key needed) ----------------
     GDELT scores the emotional tone of every article (roughly −10 … +10; most news sits between −3 and +1).
     We compare the average tone of the last 72 hours with the days before it: news turning clearly more
     positive → bullish tilt, more negative → bearish tilt. For an FX pair, base minus quote currency.
     It is a weak, transparent signal (tone is not price direction), so its confidence is capped at 35. */
  async function gdeltTone(q, span) {
    const wait = gdeltNext - Date.now();
    if (wait > 0) await sleep(wait);
    gdeltNext = Date.now() + 5200;
    const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + encodeURIComponent(q + " sourcelang:english") +
      "&mode=timelinetone&format=json&timespan=" + (span || "7d");
    let j;
    try { j = await relayJson(url, 16000); }
    catch (e) { gdeltNext = Date.now() + 7000; await sleep(6000); j = await relayJson(url, 16000); }
    const s = j && j.timeline && j.timeline[0] && j.timeline[0].data;
    if (!Array.isArray(s)) throw new Error("GDELT: پاسخ لحن اخبار نامعتبر");
    return s.map((p) => ({ t: Date.parse(String(p.date).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z")) / 1000, v: +p.value }))
      .filter((p) => isFinite(p.t) && isFinite(p.v));
  }

  /** Pure: tone shift of the last 72h against the earlier part of the window. */
  function toneShift(series, nowSec) {
    const now = nowSec || Math.max(...series.map((p) => p.t));
    const recent = series.filter((p) => p.t > now - 72 * 3600), base = series.filter((p) => p.t <= now - 72 * 3600);
    if (recent.length < 12 || base.length < 12) return null;
    const mean = (a) => a.reduce((s, p) => s + p.v, 0) / a.length;
    const r = mean(recent), b = mean(base);
    return { recent: r, base: b, delta: r - b, n: series.length };
  }

  function toneFund(shifts, label) {
    const clamp = (x) => Math.max(-1, Math.min(1, x));
    const d = shifts.base ? shifts.base.delta - (shifts.quote ? shifts.quote.delta : 0) : NaN;
    if (!isFinite(d)) return null;
    const score = clamp(d / 1.5);
    const bias = score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral";
    const n = (shifts.base ? shifts.base.n : 0) + (shifts.quote ? shifts.quote.n : 0);
    const confidence = Math.round(Math.min(35, 15 + Math.abs(score) * 20) * Math.min(1, n / (shifts.quote ? 240 : 120)));
    const f2 = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);
    const part = (k, nm) => (shifts[k] ? `${nm}: لحن ۷۲ ساعت اخیر ${f2(shifts[k].recent)} در برابر ${f2(shifts[k].base)} روزهای قبل (تغییر ${f2(shifts[k].delta)})` : "");
    const summary = shifts.quote
      ? `لحن اخبار ${label.base} نسبت به ${label.quote} ${score > 0.15 ? "مثبت‌تر شده" : score < -0.15 ? "منفی‌تر شده" : "تغییر معناداری نکرده"} است. ${part("base", label.base)} · ${part("quote", label.quote)}.`
      : `لحن اخبار ${label.base} در ۷۲ ساعت اخیر ${score > 0.15 ? "مثبت‌تر" : score < -0.15 ? "منفی‌تر" : "تقریباً بدون تغییر"} نسبت به روزهای قبل است. ${part("base", label.base)}.`;
    return {
      kind: "tone", bias, score, confidence, summary, drivers: [], future_events: [], upcoming_events: [],
      sourceNote: "لحن اخبار جهانی از GDELT (رایگان، بدون هوش مصنوعی)",
      risks: ["این فقط لحن اخبار است، نه تحلیل محتوای آن؛ اطمینان آن کم است و وزن کمی در امتیاز دارد. برای تحلیل کامل‌تر، کلید یک سرویس AI را در ⚙ تنظیمات وارد کنید."],
    };
  }

  /** Free fundamental bias for a symbol (always resolves; null when GDELT is unreachable or data is thin). */
  async function sentimentFund(sym) {
    const key = "tone:" + sym.id, cached = cacheGet(key, 2 * 3600e3);
    if (cached) return cached;
    try {
      const a = sym.id.slice(0, 3), b = sym.id.slice(3, 6);
      let out = null;
      if (sym.fx && CCY[a] && CCY[b]) {
        const base = toneShift(await gdeltTone("(" + CCY[a].join(" OR ") + ")"));
        const quote = toneShift(await gdeltTone("(" + CCY[b].join(" OR ") + ")"));
        if (base && quote) out = toneFund({ base, quote }, { base: a, quote: b });
      } else {
        const base = toneShift(await gdeltTone(newsQuery(sym)));
        if (base) out = toneFund({ base }, { base: sym.name });
      }
      if (out) cacheWrite(key, out);
      return out;
    } catch (e) { return null; }
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

  FA.news = { gdeltTone, toneShift, toneFund, sentimentFund, economicCalendar, gdeltNews, newsQuery, assetNews, matchCalendar, symbolCurrencies, parseCalendar, parseYahooNews };
})(typeof window !== "undefined" ? window : globalThis);
