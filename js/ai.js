/* Fandamental — multi-provider AI client (runs in the browser with YOUR key).
   Free options: Google Gemini (AI Studio key) and OpenRouter (free models). Paid option: Anthropic Claude.
   - fundamental(): news -> structured bias. Providers without web search get live headlines
     fetched here from GDELT (all assets) — CryptoCompare now needs a paid key, so it is no longer used.
   - calendar(): weekly economic calendar (Fed, ECB, NFP, CPI…) — always free, no key.
   - screener(): checks many symbols and ranks the best low-risk / high-reward entries.
   - Retry with backoff on 429/5xx/«high demand», and automatic fallback to a backup model. */
(function (g) {
  const FA = (g.FA = g.FA || {});

  const PROVIDERS = {
    gemini: { label: "Google Gemini (رایگان)", model: "gemini-2.5-flash", fallback: "gemini-2.0-flash", keyUrl: "https://aistudio.google.com/apikey", search: false, note: "برای گرفتن کلید رایگان وارد aistudio.google.com شوید. مدل‌های ۲.۵/۳ در ساعات شلوغ خطای «high demand» می‌دهند؛ این اپ به‌صورت خودکار دوباره تلاش می‌کند و در صورت لزوم مدل جایگزین را صدا می‌زند." },
    openrouter: { label: "OpenRouter (مدل‌های رایگان)", model: "meta-llama/llama-3.3-70b-instruct:free", fallback: "google/gemini-2.0-flash-exp:free", keyUrl: "https://openrouter.ai/keys", search: false, note: "کلید رایگان از openrouter.ai/keys. اگر مدل انتخابی پر بود، اپ خودکار به مدل جایگزین می‌رود." },
    anthropic: { label: "Anthropic Claude (پولی)", model: "claude-sonnet-4-20250514", fallback: "claude-3-5-haiku-20241022", keyUrl: "https://console.anthropic.com/settings/keys", search: true, note: "پولی است ولی جستجوی زنده‌ی وب دارد و دقیق‌ترین تحلیل خبری را می‌دهد." },
  };
  const RETRYABLE = (st) => st === 429 || st === 408 || st === 500 || st === 502 || st === 503 || st === 504;

  async function post(url, headers, body) {
    const r = await fetch(url, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers), body: JSON.stringify(body) });
    let j;
    try { j = await r.json(); } catch (e) { throw Object.assign(new Error("پاسخ نامعتبر از سرویس AI (HTTP " + r.status + ")"), { status: r.status }); }
    if (!r.ok) {
      let m = j.error && (j.error.message || j.error);
      if (m && typeof m === "object") m = JSON.stringify(m);
      if (j.message) m = m || j.message;
      m = m || "HTTP " + r.status;
      const s = r.status;
      const msg = s === 429 ? "سهمیه یا نرخ درخواست پر شده است. (" + m + ")"
        : s === 401 || s === 403 ? "کلید API نامعتبر است یا دسترسی ندارد. (" + m + ")"
        : s === 503 || /overloaded|high demand/i.test(String(m)) ? "مدل انتخابی الان شلوغ است؛ چند ثانیه بعد خودکار دوباره تلاش می‌شود… (" + m + ")"
        : String(m);
      throw Object.assign(new Error(msg), { status: s });
    }
    return j;
  }
  const blocks = (c) => (typeof c === "string" ? [{ type: "text", text: c }] : c);

  /* one provider attempt; model given explicitly so the fallback can be tried too */
  async function callProvider(prov, key, model, o) {
    const max = o.maxTokens || 2000;
    if (prov === "gemini") {
      const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {}, {
        systemInstruction: { parts: [{ text: o.system }] },
        contents: o.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: blocks(m.content).map((b) => (b.type === "image" ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } } : { text: b.text })) })),
        generationConfig: { maxOutputTokens: Math.max(max, 4096) },
      });
      const c = j.candidates && j.candidates[0];
      const text = c && c.content && c.content.parts ? c.content.parts.map((p) => p.text || "").join("").trim() : "";
      if (!text) throw new Error(j.promptFeedback && j.promptFeedback.blockReason ? "درخواست توسط Gemini مسدود شد: " + j.promptFeedback.blockReason : "پاسخ خالی از Gemini.");
      return text;
    }
    if (prov === "openrouter") {
      const j = await post("https://openrouter.ai/api/v1/chat/completions", { authorization: "Bearer " + key, "x-title": "Fandamental" }, {
        model, max_tokens: Math.max(max, 3000),
        messages: [{ role: "system", content: o.system }].concat(o.messages.map((m) => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "image" ? { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } } : { type: "text", text: b.text })),
        }))),
      });
      const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!text) throw new Error("پاسخ خالی از OpenRouter.");
      return String(text).trim();
    }
    // anthropic
    const headers = { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    let messages = o.messages, j;
    for (let k = 0; k < 4; k++) {
      j = await post("https://api.anthropic.com/v1/messages", headers, Object.assign({ model, max_tokens: max, system: o.system, messages }, o.search ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] } : {}));
      if (j.stop_reason !== "pause_turn") break;
      messages = messages.concat([{ role: "assistant", content: j.content }]);
    }
    return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  }

  /* Unified call: retries with exponential backoff on 429/5xx/«high demand», then falls back to a backup model. */
  async function complete(keys, o) {
    const prov = keys.provider || "gemini", meta = PROVIDERS[prov];
    if (!meta) throw new Error("سرویس AI نامعتبر است.");
    const key = keys[prov];
    if (!key) throw new Error("کلید API «" + meta.label + "» را در تنظیمات وارد کنید.");
    const models = [...new Set([(keys.models && keys.models[prov]) || meta.model, meta.fallback].filter(Boolean))];
    const onProg = o.onProgress || (() => {});
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const model of models) {
        try {
          onProg(attempt === 0 && model === models[0] ? "اتصال به مدل…" : "مدل شلوغ بود؛ تلاش مجدد…");
          return await callProvider(prov, key, model, o);
        } catch (e) {
          lastErr = e;
          const retryable = e.status && RETRYABLE(e.status) || /high demand|overloaded|تلاش مجدد/i.test(e.message || "");
          if (!retryable) throw e;
        }
      }
      if (attempt < 2) onProg("مدل شلوغ است؛ " + (attempt === 0 ? "۲۰" : "۴۰") + " ثانیه صبر و تلاش مجدد…");
      await new Promise((r) => setTimeout(r, attempt === 0 ? 20000 : 40000));
    }
    throw lastErr || new Error("سرویس AI پاسخ نداد.");
  }

  function parseJson(text) {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("خروجی AI قابل‌خواندن نبود.");
    return JSON.parse(text.slice(a, b + 1));
  }

  /* ---------------- live headlines (GDELT, throttled politely) ---------------- */
  const CUR = { EUR: ["euro", "ECB"], USD: ["dollar", "Fed"], GBP: ["sterling", '"Bank of England"'], JPY: ["yen", '"Bank of Japan"'], CHF: ['"Swiss franc"', "SNB"], AUD: ['"Australian dollar"', "RBA"], CAD: ['"Canadian dollar"', '"Bank of Canada"'], NZD: ['"New Zealand dollar"', "RBNZ"] };
  const FIXED = {
    XAUUSD: "(gold OR bullion) (price OR Fed OR dollar)", XAGUSD: "silver (price OR Fed OR dollar)", XPTUSD: "platinum price", USOIL: "(oil OR crude) (OPEC OR price OR inventories)",
    DXY: '("dollar index" OR "US dollar") (Fed OR inflation)', SPX: '("S&P 500" OR "Wall Street")', NDX: "Nasdaq (stocks OR Fed)", DJI: '("Dow Jones" OR "Wall Street")',
  };
  const COIN = { BTC: "bitcoin", ETH: "ethereum", BNB: '"BNB Chain"', SOL: "solana", XRP: "XRP", ADA: "cardano", DOGE: "dogecoin", TRX: "tron", TON: "toncoin", LINK: "chainlink" };
  function newsQuery(sym) {
    if (FIXED[sym.id]) return FIXED[sym.id];
    if (sym.group === "کریپتو") { const c = sym.id.replace("USDT", ""); return `${COIN[c] || c} (crypto OR price OR market)`; }
    if (sym.group === "بورس تهران") return `"${sym.name.replace(/[()]/g, "")}" OR "${sym.id.replace("TSE-", "")}"`;
    const a = sym.id.slice(0, 3), b = sym.id.slice(3, 6);
    if (CUR[a] && CUR[b]) return "(" + CUR[a].concat(CUR[b]).join(" OR ") + ")";
    return sym.name.replace(/[^\x00-\x7F]+/g, "").trim() || sym.id;
  }
  let gdeltNext = 0; // GDELT allows ~1 request / 5s — queue calls so they never 429
  async function getJson(url, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 12000);
    try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); } finally { clearTimeout(t); }
  }
  async function gdeltNews(q, max, span) {
    const wait = gdeltNext - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    gdeltNext = Date.now() + 5000;
    const j = await getJson(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q + " sourcelang:english")}&mode=artlist&format=json&maxrecords=${max || 25}&timespan=${span || "3d"}&sort=datedesc`, 15000);
    return (j.articles || []).map((a) => ({ title: a.title, src: a.domain, date: /^\d{8}/.test(a.seendate || "") ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}` : "" }));
  }
  async function getHeadlines(sym) {
    if (FA.news && FA.news.assetNews) {
      const r = await FA.news.assetNews(sym);
      return (r.list || []).map((h) => ({ title: h.title, src: h.src || "—", date: h.ts ? new Date(h.ts * 1000).toISOString().slice(0, 10) : "" })).slice(0, 30);
    }
    let rows = [];
    try { rows = await gdeltNews(newsQuery(sym), 25, "3d"); }
    catch (e) { rows = [{ title: "دریافت تیترهای زنده ممکن نشد (" + e.message + ") — تحلیل فقط بر اساس داده‌ی تکنیکال.", src: "—", date: "" }]; }
    const seen = new Set();
    return rows.filter((h) => h.title && !seen.has(h.title.toLowerCase()) && seen.add(h.title.toLowerCase())).slice(0, 30);
  }

  /* ---------------- free weekly economic calendar (ForexFactory mirror, CORS open) ---------------- */
  async function economicCalendar() {
    const j = await getJson("https://nfs.faireconomy.media/ff_calendar_thisweek.json", 15000);
    if (!Array.isArray(j)) throw new Error("تقویم اقتصادی در دسترس نیست.");
    return j.map((e) => ({
      event: e.title, country: e.country, when: e.date, impact: String(e.impact || "").toLowerCase() === "high" ? "high" : String(e.impact || "").toLowerCase() === "medium" ? "medium" : "low",
      forecast: e.forecast || "", previous: e.previous || "", actual: e.actual || "",
    }));
  }

  const SHAPE = [
    "Reply with ONLY one valid JSON object, no markdown, in this exact shape:",
    '{"bias":"bullish|bearish|neutral","score":-1..1,"confidence":0..100,"summary":"2-4 sentences in Persian",',
    '"drivers":[{"headline":"","direction":"bullish|bearish|neutral","impact":"high|medium|low","why":"Persian, one sentence","source":"publisher or url"}],',
    '"future_events":[{"event":"","when":"","importance":"high|medium|low","effect":"Persian, one sentence: how it could move this asset"}],',
    '"upcoming_events":[{"event":"","when":"","importance":"high|medium|low","risk":"Persian, one sentence"}],"risks":["Persian"]}',
  ].join(" ");

  async function fundamental(keys, ctx, onProgress) {
    const prov = keys.provider || "gemini", native = PROVIDERS[prov].search;
    let headlines = [], system, user;
    const base = `Instrument: ${ctx.name} (${ctx.tv}). Timeframe the trader uses: ${ctx.tf}. Today: ${ctx.today}. Last price: ${ctx.price}.\nTechnical engine currently says: ${ctx.tech}.\n`;
    if (native) {
      system = "You are a senior macro / fundamental analyst for traders. Use the web_search tool to find the most relevant news from the last 72 hours (central banks, inflation/jobs data, rates, geopolitics, sector or on-chain news, supply/demand) for the given instrument, and the high-impact events scheduled in the next 7 days. In future_events list news/events that could affect this asset SOON (e.g. Fed decisions, CPI, OPEC meetings) with their expected effect. Be calibrated: when evidence is mixed or thin, return neutral with low confidence. Never claim certainty and never invent headlines or sources. " + SHAPE;
      user = base + "Give the fundamental bias that matters for this timeframe.";
    } else {
      if (onProgress) onProgress("دریافت تیترهای زنده…");
      headlines = await getHeadlines(ctx.sym);
      system = "You are a senior macro / fundamental analyst for traders. You have NO web access. Base the analysis ONLY on the headlines supplied by the user (and well-known structural drivers of this instrument). Never invent headlines, numbers or sources; every driver must come from a supplied headline. If fewer than 3 headlines are relevant, return neutral with confidence <= 30. In future_events put scheduled/announced events that could soon move this asset (central-bank meetings, data releases, geopolitical or supply events) — if nothing specific is known, return an empty array, never invent dates. Be calibrated and never claim certainty. " + SHAPE;
      user = base + "Recent headlines (newest first):\n" + (headlines.length ? headlines.map((h) => `- [${h.date}] ${h.title} (${h.src})`).join("\n") : "(no headlines could be fetched)") + "\nGive the fundamental bias that matters for this timeframe.";
    }
    const out = parseJson(await complete(keys, { system, messages: [{ role: "user", content: user }], maxTokens: 3000, search: native, onProgress }));
    out.score = Math.max(-1, Math.min(1, +out.score || 0));
    out.confidence = Math.max(0, Math.min(100, +out.confidence || 0));
    if (!native && headlines.length < 3) { out.confidence = Math.min(out.confidence, 30); out.risks = (out.risks || []).concat(["تیتر زنده‌ی کافی دریافت نشد؛ این تحلیل قابل‌اتکا نیست."]); }
    out.sourceNote = native ? "جستجوی زنده‌ی وب (Claude)" : `${headlines.length} تیتر از GDELT (رایگان) · مدل ${prov}`;
    return out;
  }

  /* ---------------- AI market screener: rank the best entries ---------------- */
  const SCREEN_SHAPE = [
    "Reply with ONLY one valid JSON object, no markdown:",
    '{"ranked":[{"symbol":"","name":"","rank":1,"side":"long|short|none","score":-1..1,"confidence":0..100,',
    '"entry_quality":"excellent|good|weak","risk_level":"low|medium|high","potential":"Persian: why this entry is good",',
    '"risk_note":"Persian: main risk"}],"summary":"2-4 sentences in Persian"}',
  ].join(" ");
  async function screener(keys, ctx, onProgress) {
    const prov = keys.provider || "gemini", native = PROVIDERS[prov].search;
    let heads = [];   // declared here: it is used in sourceNote on both branches
    const rows = ctx.markets.map((m) => `${m.name} (${m.id}): price ${m.price}, trend ${m.direction}, confluence ${m.confluence}, tech ${m.tech.toFixed(2)}, price-action ${m.pa.toFixed(2)}${m.fund ? `, fundamental ${m.fund.bias} (${Math.round(m.fund.confidence)}%)` : ""}${m.alert ? `, EARLY-SIGNAL: ${m.alert}` : ""}`);
    let system, user;
    if (native) {
      system = "You are a senior trading-desk analyst. The user gives you a scan of many markets produced by a technical engine. Optionally use web_search for the top candidates to check for obvious upcoming catalysts. Rank the best entries for the NEXT days: high reward potential with LOW risk first. Never invent numbers; use only the supplied data plus, if searched, clearly-cited facts. " + SCREEN_SHAPE;
      user = rows.join("\n") + "\nRank the top entries (best first, include only candidates worth trading; side none for ones to skip).";
    } else {
      if (onProgress) onProgress("دریافت تیترهای زنده برای رتبه‌بندی…");
      let heads = [];
      try { heads = await gdeltNews("(federal reserve OR inflation OR \"stock market\" OR gold OR oil OR bitcoin OR forex) (outlook OR forecast OR decision OR data)", 30, "2d"); }
      catch (e) { heads = []; }
      system = "You are a senior trading-desk analyst. You have NO web access. Rank the supplied market scan: high reward potential with LOW risk first. Use the supplied technical scores and the supplied macro headlines for context only. Never invent numbers or headlines. " + SCREEN_SHAPE;
      user = "Macro headlines (newest first):\n" + (heads.length ? heads.map((h) => `- [${h.date}] ${h.title} (${h.src})`).join("\n") : "(none)") + "\n\nMarket scan:\n" + rows.join("\n") + "\nRank the top entries (best first; side none for ones to skip).";
    }
    const out = parseJson(await complete(keys, { system, messages: [{ role: "user", content: user }], maxTokens: 2500, search: native, onProgress }));
    out.sourceNote = native ? "جستجوی زنده‌ی وب (Claude) + موتور تکنیکال" : `موتور تکنیکال روی ${ctx.markets.length} بازار + ${heads.length} تیتر خبری`;
    return out;
  }

  async function chat(keys, history, system, onProgress) { return complete(keys, { system, messages: history, maxTokens: 1800, onProgress }); }

  function chatSystem(ctx) {
    return [
      "You are a candid, experienced trading mentor inside the Fandamental app. Reply in Persian (Farsi), concise and practical.",
      "Rules: never promise or imply guaranteed profit or a fixed accuracy; point out weak spots in the user's reasoning, risk-management gaps and psychological mistakes honestly; prefer asking one sharp question over guessing.",
      "When reviewing losing trades, look for patterns (entry timing, stop placement, counter-trend entries, news-time entries, position sizing, overtrading) and suggest one or two concrete rule changes.",
      "You cannot see live prices or news beyond the context below.",
      "Current app context (JSON):", JSON.stringify(ctx),
    ].join("\n");
  }

  FA.ai = { PROVIDERS, complete, fundamental, screener, chat, chatSystem, getHeadlines, newsQuery, gdeltNews, economicCalendar };
})(typeof window !== "undefined" ? window : globalThis);
