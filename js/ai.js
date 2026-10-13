/* Fandamental — multi-provider AI client (runs in the browser with YOUR key).
   Free options: Google Gemini (AI Studio key) and OpenRouter (free models). Paid option: Anthropic Claude.
   - fundamental(): news -> structured bias. Providers without web search get live headlines
     fetched here from GDELT (all assets) and CryptoCompare (crypto), and must base the analysis on them only.
   - chat(): brainstorming / mistake review, optional chart screenshot (vision). */
(function (g) {
  const FA = (g.FA = g.FA || {});

  const PROVIDERS = {
    gemini: { label: "Google Gemini (رایگان)", model: "gemini-3.8-flash", keyUrl: "https://aistudio.google.com/apikey", search: false },
    openrouter: { label: "OpenRouter (مدل‌های رایگان)", model: "openrouter/free", keyUrl: "https://openrouter.ai/keys", search: false },
    anthropic: { label: "Anthropic Claude (پولی)", model: "claude-sonnet-5-5", keyUrl: "https://console.anthropic.com/settings/keys", search: true },
  };

  async function post(url, headers, body) {
    const r = await fetch(url, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers), body: JSON.stringify(body) });
    let j;
    try { j = await r.json(); } catch (e) { throw new Error("پاسخ نامعتبر از سرویس AI (HTTP " + r.status + ")"); }
    if (!r.ok) {
      let m = j.error && (j.error.message || j.error);
      if (m && typeof m === "object") m = JSON.stringify(m);
      m = m || "HTTP " + r.status;
      throw new Error(r.status === 429 ? "سهمیه‌ی رایگان یا نرخ درخواست پر شده؛ چند دقیقه بعد دوباره امتحان کن. (" + m + ")" : r.status === 401 || r.status === 403 ? "کلید API نامعتبر است یا دسترسی ندارد. (" + m + ")" : String(m));
    }
    return j;
  }
  const blocks = (c) => (typeof c === "string" ? [{ type: "text", text: c }] : c);

  /* Unified call. messages use Anthropic-style content: string | [{type:'image',source:{media_type,data}},{type:'text',text}] */
  async function complete(keys, o) {
    const prov = keys.provider || "gemini", meta = PROVIDERS[prov];
    if (!meta) throw new Error("سرویس AI نامعتبر است.");
    const key = keys[prov];
    if (!key) throw new Error("کلید API ی «" + meta.label + "» را در تنظیمات وارد کنید.");
    const model = (keys.models && keys.models[prov]) || meta.model, max = o.maxTokens || 2000;

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

  function parseJson(text) {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("خروجی AI قابل‌خواندن نبود.");
    return JSON.parse(text.slice(a, b + 1));
  }

  /* ---------------- live headlines for providers without web search ---------------- */
  const CUR = { EUR: ["euro", "ECB"], USD: ["dollar", "Fed"], GBP: ["sterling", '"Bank of England"'], JPY: ["yen", '"Bank of Japan"'], CHF: ['"Swiss franc"', "SNB"], AUD: ['"Australian dollar"', "RBA"], CAD: ['"Canadian dollar"', '"Bank of Canada"'], NZD: ['"New Zealand dollar"', "RBNZ"] };
  const FIXED = {
    XAUUSD: "(gold OR bullion) (price OR Fed OR dollar)", XAGUSD: "silver (price OR Fed OR dollar)", XPTUSD: "platinum price", USOIL: "(oil OR crude) (OPEC OR price OR inventories)",
    DXY: '("dollar index" OR "US dollar") (Fed OR inflation)', SPX: '("S&P 500" OR "Wall Street")', NDX: "Nasdaq (stocks OR Fed)", DJI: '("Dow Jones" OR "Wall Street")',
  };
  const COIN = { BTC: "bitcoin", ETH: "ethereum", BNB: '"BNB Chain"', SOL: "solana", XRP: "XRP", ADA: "cardano", DOGE: "dogecoin", TRX: "tron", TON: "toncoin", LINK: "chainlink" };
  function newsQuery(sym) {
    if (FIXED[sym.id]) return FIXED[sym.id];
    if (sym.group === "کریپتو") { const c = sym.id.replace("USDT", ""); return `${COIN[c] || c} (crypto OR price OR market)`; }
    const a = sym.id.slice(0, 3), b = sym.id.slice(3, 6);
    if (CUR[a] && CUR[b]) return "(" + CUR[a].concat(CUR[b]).join(" OR ") + ")";
    return sym.name.replace(/[^\x00-\x7F]+/g, "").trim() || sym.id;
  }
  async function getJson(url, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 12000);
    try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); } finally { clearTimeout(t); }
  }
  async function getHeadlines(sym) {
    const jobs = [
      getJson(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(newsQuery(sym) + " sourcelang:english")}&mode=artlist&format=json&maxrecords=25&timespan=3d&sort=datedesc`).then((j) =>
        (j.articles || []).map((a) => ({ title: a.title, src: a.domain, date: /^\d{8}/.test(a.seendate || "") ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}` : "" }))),
    ];
    if (sym.group === "کریپتو") {
      const cat = sym.id.replace("USDT", "");
      jobs.push(getJson(`https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=${encodeURIComponent(cat)}`).then((j) =>
        (j.Data || []).slice(0, 15).map((a) => ({ title: a.title, src: a.source, date: new Date(a.published_on * 1000).toISOString().slice(0, 10) }))));
    }
    const all = (await Promise.allSettled(jobs)).flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const seen = new Set();
    return all.filter((h) => h.title && !seen.has(h.title.toLowerCase()) && seen.add(h.title.toLowerCase())).sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 30);
  }

  const SHAPE = [
    "Reply with ONLY one valid JSON object, no markdown, in this exact shape:",
    '{"bias":"bullish|bearish|neutral","score":-1..1,"confidence":0..100,"summary":"2-4 sentences in Persian",',
    '"drivers":[{"headline":"","direction":"bullish|bearish|neutral","impact":"high|medium|low","why":"Persian, one sentence","source":"publisher or url"}],',
    '"upcoming_events":[{"event":"","when":"","importance":"high|medium|low","risk":"Persian, one sentence"}],"risks":["Persian"]}',
  ].join(" ");

  async function fundamental(keys, ctx) {
    const prov = keys.provider || "gemini", native = PROVIDERS[prov].search;
    let headlines = [], system, user;
    const base = `Instrument: ${ctx.name} (${ctx.tv}). Timeframe the trader uses: ${ctx.tf}. Today: ${ctx.today}. Last price: ${ctx.price}.\nTechnical engine currently says: ${ctx.tech}.\n`;
    if (native) {
      system = "You are a senior macro / fundamental analyst for traders. Use the web_search tool to find the most relevant news from the last 72 hours (central banks, inflation/jobs data, rates, geopolitics, sector or on-chain news, supply/demand) for the given instrument, and the high-impact events scheduled in the next 7 days. Be calibrated: when evidence is mixed or thin, return neutral with low confidence. Never claim certainty and never invent headlines or sources. " + SHAPE;
      user = base + "Give the fundamental bias that matters for this timeframe.";
    } else {
      headlines = await getHeadlines(ctx.sym);
      system = "You are a senior macro / fundamental analyst for traders. You have NO web access. Base the analysis ONLY on the headlines supplied by the user (and well-known structural drivers of this instrument). Never invent headlines, numbers or sources; every driver must come from a supplied headline. If fewer than 3 headlines are relevant, return neutral with confidence <= 30. Put upcoming_events only if clearly implied by the headlines, otherwise return an empty array. Be calibrated and never claim certainty. " + SHAPE;
      user = base + "Recent headlines (newest first):\n" + (headlines.length ? headlines.map((h) => `- [${h.date}] ${h.title} (${h.src})`).join("\n") : "(no headlines could be fetched)") + "\nGive the fundamental bias that matters for this timeframe.";
    }
    const out = parseJson(await complete(keys, { system, messages: [{ role: "user", content: user }], maxTokens: 3000, search: native }));
    out.score = Math.max(-1, Math.min(1, +out.score || 0));
    out.confidence = Math.max(0, Math.min(100, +out.confidence || 0));
    if (!native && headlines.length < 3) { out.confidence = Math.min(out.confidence, 30); out.risks = (out.risks || []).concat(["تیتر زنده‌ی کافی دریافت نشد؛ این تحلیل قابل‌اتکا نیست."]); }
    out.sourceNote = native ? "جستجوی زنده‌ی وب (Claude)" : `${headlines.length} تیتر از GDELT${ctx.sym.group === "کریپتو" ? " و CryptoCompare" : ""} · مدل ${prov}`;
    return out;
  }

  async function chat(keys, history, system) { return complete(keys, { system, messages: history, maxTokens: 1800 }); }

  function chatSystem(ctx) {
    return [
      "You are a candid, experienced trading mentor inside the Fandamental app. Reply in Persian (Farsi), concise and practical.",
      "Rules: never promise or imply guaranteed profit or a fixed accuracy; point out weak spots in the user's reasoning, risk-management gaps and psychological mistakes honestly; prefer asking one sharp question over guessing.",
      "When reviewing losing trades, look for patterns (entry timing, stop placement, counter-trend entries, news-time entries, position sizing, overtrading) and suggest one or two concrete rule changes.",
      "You cannot see live prices or news beyond the context below.",
      "Current app context (JSON):", JSON.stringify(ctx),
    ].join("\n");
  }

  FA.ai = { PROVIDERS, complete, fundamental, chat, chatSystem, getHeadlines, newsQuery };
})(typeof window !== "undefined" ? window : globalThis);
