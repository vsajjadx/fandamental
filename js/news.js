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

  /* Fast + robust fetch: the direct URL, the user's personal relay and the public relays are tried IN PARALLEL
     (staggered by 1.2 s), the first good answer wins, and nothing waits longer than `budget` ms in total.
     (The old code tried them one after another with 16 s timeouts each — up to ~2 minutes in Iran.) */
  function hedgedText(url, budget, accept) {
    const D = FA.data, mine = D && D.personalRelay ? D.personalRelay(url) : null;
    const urls = [url].concat(mine ? [mine] : [], RELAY.slice(1).map((w) => w(url)));
    const per = Math.min(10000, budget || 10000);
    return new Promise((resolve, reject) => {
      let done = false, failed = 0; const errs = [], timers = [];
      const finish = (fn, v) => { if (done) return; done = true; timers.forEach(clearTimeout); fn(v); };
      timers.push(setTimeout(() => finish(reject, new Error("زمان انتظار تمام شد (" + Math.round((budget || 10000) / 1000) + " ثانیه)")), budget || 10000));
      urls.forEach((u, k) => timers.push(setTimeout(() => {
        if (done) return;
        fetchText(u, per).then((t) => {
          if (accept && !accept(t)) throw new Error("پاسخ نامعتبر");
          finish(resolve, t);
        }).catch((e) => { errs.push(e.message); if (++failed === urls.length) finish(reject, new Error(errs[0] || "بدون پاسخ")); });
      }, k * 1200)));
    });
  }
  const isJson = (t) => /^\s*[\[{]/.test(t);
  const hedgedJson = (url, budget) => hedgedText(url, budget, isJson).then((t) => JSON.parse(t));
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
          const v = parseCalendar(await hedgedJson("https://nfs.faireconomy.media/ff_calendar_thisweek.json", 15000));
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
    try { j = await hedgedJson(url, 12000); }
    catch (e) { gdeltNext = Date.now() + 7000; throw new Error(/نامعتبر/.test(e.message) ? "محدودیت تعداد درخواست GDELT" : e.message); }
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
    try { j = await hedgedJson(url, 12000); }
    catch (e) { gdeltNext = Date.now() + 7000; throw e; }
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

  /* ---------------- Yahoo Finance news search ---------------- */
  function yahooUrl(sym) {
    const q = YAHOO_Q[sym.id] || (sym.group === "کریپتو" ? (COIN[sym.id] || sym.id.replace("USDT", "")) : sym.yh || sym.tv || sym.id);
    return "https://query1.finance.yahoo.com/v1/finance/search?q=" + encodeURIComponent(q) + "&newsCount=20&quotesCount=0&enableFuzzyQuery=false";
  }
  const YAHOO_Q = { XAUUSD: "gold price", XAGUSD: "silver price", XPTUSD: "platinum price", USOIL: "oil price", DXY: "dollar index", SPX: "S&P 500", NDX: "Nasdaq", DJI: "Dow Jones" };
  function parseYahooNews(j) {
    return ((j && j.news) || []).map((n) => ({
      title: n.title || "", src: n.publisher || "Yahoo Finance", url: n.link || "",
      ts: n.providerPublishTime ? +n.providerPublishTime : 0,
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
    if (sym.group === "کریپتو") return (COIN[sym.id] || sym.id.replace("USDT", "")) + " (crypto OR price OR market)";
    if (sym.group === TSE_GROUP) return '(Tehran stock exchange OR tsetmc OR "Iran stock market")';
    const a = sym.id.slice(0, 3), b = sym.id.slice(3, 6);
    if (CCY[a] && CCY[b]) return "(" + CCY[a].concat(CCY[b]).join(" OR ") + ")";
    return sym.name.replace(/[^\x00-\x7F]+/g, "").trim() || sym.id;
  }

  /* ---------------- Bing News RSS (English, and Persian for the Tehran exchange) ---------------- */
  function bingQuery(sym) {
    if (sym.group === TSE_GROUP) return { q: '"' + String(sym.name).replace(/[()«»"]/g, " ").trim() + '" بورس', lang: "fa" };
    const base = YAHOO_Q[sym.id] || (sym.group === "کریپتو" ? String(COIN[sym.id] || sym.id.replace("USDT", "")).replace(/"/g, "") + " crypto" : null);
    if (base) return { q: base, lang: "en" };
    const a = sym.id.slice(0, 3), b = sym.id.slice(3, 6);
    if (CCY[a] && CCY[b]) return { q: a + "/" + b + " forex", lang: "en" };
    return { q: sym.name.replace(/[^\x00-\x7F]+/g, "").trim() || sym.id, lang: "en" };
  }
  function parseRss(xml, maxAgeDays) {
    const out = [], now = Date.now() / 1000, items = String(xml).split(/<item[ >]/i).slice(1);
    const tag = (s, t) => { const m = s.match(new RegExp("<" + t + "[^>]*>([\\s\\S]*?)</" + t + ">", "i")); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : ""; };
    const dec = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
    for (const it of items) {
      const title = dec(tag(it, "title")), ts = Date.parse(tag(it, "pubDate")) / 1000;
      if (!title || !isFinite(ts)) continue;
      if (maxAgeDays && now - ts > maxAgeDays * 86400) continue;   // Bing mixes in old articles: keep recent ones only
      out.push({ title, src: dec(tag(it, "News:Source") || "Bing News"), url: dec(tag(it, "link")), ts });
    }
    return out;
  }
  async function bingNews(sym) {
    const { q, lang } = bingQuery(sym);
    const url = "https://www.bing.com/news/search?q=" + encodeURIComponent(q) + "&format=rss&setlang=" + lang + (lang === "fa" ? "&cc=IR" : "");
    return parseRss(await hedgedText(url, 12000, (t) => /<rss|<item/i.test(t)), 7);
  }

  /* All sources run IN PARALLEL with one overall time budget; the results are merged, de-duplicated and sorted.
     Always resolves with { list, source, error } so the UI can show a final state. */
  async function assetNews(sym, budgetMs) {
    const budget = budgetMs || 20000;
    const within = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("زمان انتظار تمام شد")), budget))]);
    const isTse = sym.group === TSE_GROUP;
    const sources = [
      ["Bing News", () => bingNews(sym)],
      ["GDELT", () => (isTse ? Promise.resolve([]) : gdeltNews(newsQuery(sym), 25, "3d"))],
      ["Yahoo", () => (isTse ? Promise.resolve([]) : hedgedJson(yahooUrl(sym), 12000).then(parseYahooNews))],
    ];
    const res = await Promise.allSettled(sources.map(([, f]) => within(f())));
    const seen = new Set(), list = [], ok = [], errs = [];
    res.forEach((r, k) => {
      const name = sources[k][0];
      if (r.status === "fulfilled") { if (r.value.length) ok.push(name); r.value.forEach((h) => { const key = h.title.toLowerCase().replace(/\W+/g, " ").trim().slice(0, 80); if (!seen.has(key)) { seen.add(key); list.push(h); } }); }
      else errs.push(name + ": " + (r.reason && r.reason.message ? r.reason.message : "خطا"));
    });
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const out = { list: list.slice(0, 40), source: ok.join(" + "), error: errs.join(" · ") };
    if (out.list.length) { cacheWrite("news:" + sym.id, out.list); return out; }
    const cached = cacheGet("news:" + sym.id);
    if (cached) { out.list = cached; out.source = "حافظه‌ی موقت مرورگر (آخرین اخبار دریافت‌شده)"; return out; }
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

  FA.news = { hedgedText, parseRss, bingQuery, bingNews, gdeltTone, toneShift, toneFund, sentimentFund, economicCalendar, gdeltNews, newsQuery, assetNews, matchCalendar, symbolCurrencies, parseCalendar, parseYahooNews };
})(typeof window !== "undefined" ? window : globalThis);
