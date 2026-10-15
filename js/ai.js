/* Fandamental — multi-provider AI client (runs in the browser with YOUR key).
   Free options: Google Gemini (AI Studio key) and OpenRouter (free models). Paid option: Anthropic Claude.
   - fundamental(): news -> structured bias. Providers without web search get live headlines
     fetched here from GDELT (all assets).
   - calendar(): weekly economic calendar (Fed, ECB, NFP, CPI…) — always free, no key.
   - screener(): checks many symbols and ranks the best low-risk / high-reward entries.

   ---- resilience notes (why the AI ranking used to fail with «شلوغ است / خطا») ----
   1) TIMEOUT: every request now has a hard AbortController deadline. Before, a single
      hung socket (very common on filtered networks) left the pane stuck on
      «AI در حال رتبه‌بندی…» forever — no timeout, no retry, no error.
   2) NO DUPLICATED CALLS: the Interactions probe is now remembered (interactionsOk).
      Before, EVERY single-turn call fired Interactions first and, on any failure
      (404/429/timeout), silently swallowed the error and immediately fired
      generateContent — two requests for every logical attempt. That doubled the
      rate-limit pressure and turned a soft 429 into a hard «شلوغ» failure.
      A real rate-limit/network error now propagates to the retry loop instead.
   3) SMART RETRY: exponential backoff + jitter that honors the HTTP Retry-After
      header, only for genuinely retryable failures (408/429/425/5xx/network/
      «high demand»/empty answer/model-not-found). Fatal errors (401/403) fail fast
      with a clear message instead of burning 60s of retries.
   4) BATCHED SCREENER: the prompt used to contain every scanned market at once
      (50+ symbols) with maxTokens 2500, so the reply was routinely cut off by the
      output-token cap → truncated JSON → «خروجی AI قابل‌خواندن نبود». Markets are
      now pre-filtered to the best candidates and sent in small batches, and the
      answer is validated/normalised.
   5) DEFENSIVE JSON: code fences, prose around the object and truncation are
      handled (repair), and if the model is still unusable the screener returns a
      clearly-labelled LOCAL technical ranking instead of an error screen. */
(function (g) {
  const FA = (g.FA = g.FA || {});

  const PROVIDERS = {
    gemini: { label: "Google Gemini (رایگان)", model: "gemini-3.8-flash", fallback: "gemini-3.6-flash", latest: "gemini-flash-latest", keyUrl: "https://aistudio.google.com/apikey", search: false, note: "برای گرفتن کلید رایگان وارد aistudio.google.com شوید. مدل‌های ۲.۵/۳ در ساعات شلوغ خطای «high demand» می‌دهند؛ این اپ با تأخیر پله‌ای (و احترام به Retry-After) دوباره تلاش می‌کند و در صورت لزوم مدل جایگزین را صدا می‌زند." },
    openrouter: { label: "OpenRouter (مدل‌های رایگان)", model: "google/gemma-4-31b-it:free", fallback: "nvidia/nemotron-3-ultra-550b-a55b:free", latest: null, keyUrl: "https://openrouter.ai/keys", search: false, note: "کلید رایگان از openrouter.ai/keys. اگر مدل انتخابی پر بود، اپ خودکار به مدل جایگزین می‌رود." },
    anthropic: { label: "Anthropic Claude (پولی)", model: "claude-sonnet-4-20250514", fallback: "claude-3-5-haiku-20241022", latest: null, keyUrl: "https://console.anthropic.com/settings/keys", search: true, note: "پولی است ولی جستجوی زنده‌ی وب دارد و دقیق‌ترین تحلیل خبری را می‌دهد." },
  };
  PROVIDERS.custom = {
    label: "سازگار با OpenAI (DeepSeek / AvalAI / GapGPT / …) — مناسب ایران", model: "deepseek-chat", fallback: null, latest: null,
    keyUrl: "https://platform.deepseek.com/api_keys", search: false, custom: true,
    note: "هر سرویسی که API سازگار با OpenAI داشته باشد (/chat/completions). برای ایران بدون VPN: DeepSeek مستقیم (https://api.deepseek.com ، مدل deepseek-chat) یا درگاه‌های ایرانی مثل AvalAI (https://api.avalai.ir/v1) و GapGPT (https://api.gapgpt.app/v1) با پرداخت ریالی. «آدرس پایه» را همان‌طور که سرویس می‌دهد وارد کنید.",
  };
  const DEFAULT_BASE = "https://api.deepseek.com";
  const RETRYABLE = (st) => st === 0 || st === 408 || st === 425 || st === 429 || st === 500 || st === 502 || st === 503 || st === 504 || st === 529;
  /* shut-down ids (gemini-2.0-flash was turned off on 2026-06-01, 2.5 access is being
     withdrawn): a model id saved in localStorage by an older version is ignored. */
  const RETIRED = /gemini-(2\.0|2\.5)/;
  /* failures worth another attempt (not: bad key, blocked prompt, malformed request) */
  const SOFT = /high demand|overloaded|شلوغ|زمان مقرر|تلاش مجدد|پاسخ خالی|not found|not supported|unsupported|invalid model|does not exist|no such model|quota|rate limit|temporarily/i;
  const isRetryable = (e) => !!(e && !e.geo && (RETRYABLE(e.status) || e.network || SOFT.test(String(e.message || ""))));
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, 120000))));
  const jitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));
  const DEFAULTS = { timeoutMs: 30000, retry: { attempts: 3, base: 900, cap: 15000 } };
  /* remembered so a broken/absent Interactions transport is probed once, not every call */
  let interactionsOk = true;

  async function post(url, headers, body, opt) {
    const o = opt || {}, tmo = o.timeoutMs || DEFAULTS.timeoutMs;
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), tmo);
    let r;
    try {
      r = await fetch(url, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers), body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      const aborted = (e && e.name) === "AbortError" || /abort/i.test(String((e && e.message) || ""));
      throw Object.assign(
        aborted
          ? new Error("پاسخی از سرویس AI در " + Math.round(tmo / 1000) + " ثانیه نرسید (timeout). اینترنت/فیلترینگ یا VPN را بررسی کنید و دوباره بزنید.")
          : new Error("اتصال به سرویس AI برقرار نشد («" + ((e && e.message) || e) + "»). اگر شبکه فیلتر است با VPN دوباره امتحان کنید."),
        aborted ? { status: 408, timeout: true } : { status: 0, network: true });
    } finally { clearTimeout(to); }
    const ra = r && r.headers && typeof r.headers.get === "function" ? (+r.headers.get("retry-after") || 0) : 0;
    let j = null, parsed = true;
    try { j = await r.json(); } catch (e) { parsed = false; }
    if (r.ok) {
      if (!parsed) throw Object.assign(new Error("پاسخ نامعتبر از سرویس AI (HTTP " + r.status + ")"), { status: r.status });
      return j;
    }
    let m = parsed && j && j.error && (j.error.message || j.error);
    if (m && typeof m === "object") m = JSON.stringify(m);
    if (parsed && j && j.message) m = m || j.message;
    if (!parsed) m = "بدنه‌ی پاسخ خوانا نبود";
    m = m ? String(m).slice(0, 300) : "بدون توضیح";
    const s = r.status;
    if (/location is not supported|FAILED_PRECONDITION/i.test(m) || (s === 403 && /country|region|territory|not available in your/i.test(m))) {
      throw Object.assign(new Error("این سرویس AI از موقعیت (IP) شما در دسترس نیست — مثلاً Gemini و Claude برای ایران مسدودند. در تنظیمات سرویس را روی «OpenRouter» یا «سازگار با OpenAI (DeepSeek / AvalAI / GapGPT)» بگذارید. (" + m + ") · HTTP " + s), { status: s, geo: true });
    }
    const msg = s === 429 ? "سهمیه یا نرخ درخواست پر شده است. (" + m + ") · HTTP 429"
      : s === 401 || s === 403 ? "کلید API نامعتبر است یا دسترسی ندارد. (" + m + ") · HTTP " + s
      : s === 503 || s === 529 || /overloaded|high demand/i.test(m) ? "مدل انتخابی الان شلوغ است؛ خودکار دوباره تلاش می‌شود… (" + m + ") · HTTP " + s
      : "HTTP " + s + ": " + m;
    throw Object.assign(new Error(msg), { status: s, retryAfter: ra });
  }
  const blocks = (c) => (typeof c === "string" ? [{ type: "text", text: c }] : c);

  /* Gemini 2.5/3 "think" before answering. Without an explicit thinkingConfig the whole
     maxOutputTokens was consumed by hidden thinking and the visible text came back empty,
     which killed the AI ranking («پاسخ خالی از Gemini»). Disable thinking on flash models
     (budget 0) and cap it on pro (128) so the answer always has room. */
  function buildGeminiConfig(model, max) {
    const gc = { maxOutputTokens: Math.max(max, 4096) };
    // thinkingBudget only exists on 2.5 models; Gemini 3.x is steered with
    // thinking_level on the Interactions API, so it is not sent to generateContent.
    if (/^gemini-2\.5/.test(model)) gc.thinkingConfig = { thinkingBudget: /pro/i.test(model) ? 128 : 0 };
    return gc;
  }

  /* Google recommends the Interactions API for new projects
     (ai.google.dev/gemini-api/docs/get-started). The generated text is read from the
     interaction's `output_text`. The legacy generateContent endpoint is still fully
     supported, so it stays as the fallback for multi-turn chat, image parts and for
     any case where an Interactions call is unavailable. */
  const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
  const GEMINI_THINKING = "minimal"; // Gemini 3.x uses thinking_level, not thinkingBudget
  const simpleText = (o) => o.messages.length === 1 && typeof o.messages[0].content === "string";
  function geminiOutputText(j) {
    if (typeof j.output_text === "string" && j.output_text.trim()) return j.output_text.trim();
    const steps = Array.isArray(j.steps) ? j.steps : [];
    return steps.map((s) => {
      const cs = s && (s.content || s.contents);
      const one = (c) => (typeof c === "string" ? c : c && typeof c.text === "string" ? c.text : c && Array.isArray(c.parts) ? c.parts.map((p) => p.text || "").join("") : "");
      return (Array.isArray(cs) ? cs : cs ? [cs] : []).map(one).join("");
    }).join("").trim();
  }
  async function geminiInteractions(key, model, o, max, tmo) {
    const j = await post(`${GEMINI_API}/interactions`, { "x-goog-api-key": key }, {
      model,
      input: String(o.messages[0].content),
      system_instruction: o.system,
      generation_config: { max_output_tokens: Math.max(max, 4096), thinking_level: GEMINI_THINKING },
    }, { timeoutMs: tmo });
    return geminiOutputText(j);
  }

  /* one provider attempt; model given explicitly so the fallback can be tried too */
  async function callProvider(prov, key, model, o, opt) {
    const max = o.maxTokens || 2000, tmo = (opt && opt.timeoutMs) || DEFAULTS.timeoutMs;
    if (prov === "gemini") {
      // Preferred transport for a single-turn text request (analysis, screener): the
      // Interactions API. A transport-level failure (400/404/405) is remembered and we
      // drop to generateContent, which Google still fully supports. A rate-limit or
      // network failure is NOT swallowed: it propagates so the retry loop can back off
      // (swallowing it caused a second, immediately-rate-limited call on every attempt).
      if (interactionsOk && simpleText(o)) {
        try {
          const quick = await geminiInteractions(key, model, o, max, tmo);
          if (quick) return quick;
        } catch (e) {
          if (RETRYABLE(e.status) || e.network) throw e;
          interactionsOk = false; // unusable transport → never probe it again this session
        }
      }
      const j = await post(`${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {}, {
        systemInstruction: { parts: [{ text: o.system }] },
        contents: o.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: blocks(m.content).map((b) => (b.type === "image" ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } } : { text: b.text })) })),
        generationConfig: buildGeminiConfig(model, max),
      }, { timeoutMs: tmo });
      const c = j.candidates && j.candidates[0];
      const text = c && c.content && c.content.parts ? c.content.parts.map((p) => p.text || "").join("").trim() : "";
      if (!text) {
        if (j.promptFeedback && j.promptFeedback.blockReason) throw new Error("درخواست توسط Gemini مسدود شد: " + j.promptFeedback.blockReason);
        // a thinking-only answer (no visible parts) is retried with the next model — not fatal
        throw Object.assign(new Error("پاسخ خالی از Gemini (مدل بودجه‌ی توکن را صرف «فکر کردن» کرد و متنی برنگرداند)؛ دوباره تلاش می‌شود…"), { status: 503 });
      }
      return text;
    }
    if (prov === "openrouter" || prov === "custom") {
      let url = "https://openrouter.ai/api/v1/chat/completions", hdr = { authorization: "Bearer " + key, "x-title": "Fandamental" };
      if (prov === "custom") {
        const base = String((opt && opt.base) || DEFAULT_BASE).trim().replace(/\/+$/, "");
        if (!/^https:\/\/\S+$/i.test(base)) throw new Error("آدرس پایه‌ی سرویس سازگار با OpenAI معتبر نیست (باید با https:// شروع شود).");
        url = (/\/chat\/completions$/.test(base) ? base : base + "/chat/completions"); hdr = { authorization: "Bearer " + key };
      }
      const label = prov === "custom" ? "سرویس AI" : "OpenRouter";
      const j = await post(url, hdr, {
        model, max_tokens: Math.max(max, 3000),
        messages: [{ role: "system", content: o.system }].concat(o.messages.map((m) => ({
          role: m.role,
          content: typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "image" ? { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } } : { type: "text", text: b.text })),
        }))),
      }, { timeoutMs: tmo });
      const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!text) throw Object.assign(new Error("پاسخ خالی از " + label + "؛ با مدل جایگزین دوباره تلاش می‌شود…"), { status: 503 });
      return String(text).trim();
    }
    // anthropic
    const headers = { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    let messages = o.messages, j;
    for (let k = 0; k < 4; k++) {
      j = await post("https://api.anthropic.com/v1/messages", headers, Object.assign({ model, max_tokens: max, system: o.system, messages }, o.search ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] } : {}), { timeoutMs: tmo });
      if (j.stop_reason !== "pause_turn") break;
      messages = messages.concat([{ role: "assistant", content: j.content }]);
    }
    return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  }

  function decorate(e, meta, models) {
    const d = "سرویس: " + meta.label + " · مدل‌ها: " + models.join(" → ") + (e && e.status ? " · آخرین وضعیت HTTP: " + e.status : "") + (e && e.timeout ? " · مهلت پاسخ تمام شد" : "") + (e && e.retryAfter ? " · Retry-After: " + e.retryAfter + "s" : "");
    if (e && typeof e === "object") { try { if (!e.detail) e.detail = d; } catch (x) { /* frozen */ } }
    return e;
  }

  /* Unified call: retries with exponential backoff + jitter on 429/5xx/«high demand»,
     honoring Retry-After, and falls back to a backup model. */
  async function complete(keys, o) {
    const prov = keys.provider || "gemini", meta = PROVIDERS[prov];
    if (!meta) throw new Error("سرویس AI نامعتبر است.");
    const key = keys[prov];
    if (!key) throw new Error("کلید API «" + meta.label + "» را در تنظیمات وارد کنید.");
    const saved = keys.models && keys.models[prov];
    const models = [...new Set([(saved && !RETIRED.test(saved) ? saved : meta.model), meta.fallback, meta.latest].filter(Boolean))];
    const onProg = o.onProgress || (() => {});
    const rc = Object.assign({}, DEFAULTS.retry, o.retry || {});
    const timeoutMs = o.timeoutMs || DEFAULTS.timeoutMs;
    const attempts = Math.max(1, rc.attempts | 0);
    let lastErr = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      for (let mi = 0; mi < models.length; mi++) {
        const model = models[mi];
        try {
          onProg(attempt === 0 && mi === 0 ? "اتصال به مدل…" : mi ? "مدل جایگزین («" + model + "»)…" : "تلاش مجدد…");
          return await callProvider(prov, key, model, o, { timeoutMs, base: keys.customBase });
        } catch (e) {
          lastErr = e;
          if (!isRetryable(e)) throw decorate(e, meta, models); // bad key / blocked prompt: don't waste time
        }
      }
      if (attempt < attempts - 1) {
        const back = jitter(Math.min(rc.cap, rc.base * Math.pow(2, attempt)));
        const ra = lastErr && lastErr.retryAfter ? Math.min(lastErr.retryAfter * 1000, 30000) : 0;
        const ms = Math.max(back, ra);
        onProg("مدل شلوغ است؛ " + (ms / 1000).toFixed(1) + " ثانیه صبر و تلاش مجدد…");
        await sleep(ms);
      }
    }
    throw decorate(lastErr || new Error("سرویس AI پاسخ نداد."), meta, models);
  }

  /* ---------------- defensive JSON ---------------- */
  const stripFence = (t) => String(t == null ? "" : t).replace(/^\uFEFF/, "").replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "").trim();
  /* first *balanced* {...} block (ignores braces inside strings) */
  function firstObject(s) {
    const a = s.indexOf("{");
    if (a < 0) return null;
    let d = 0, inStr = false, esc = false;
    for (let i = a; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") d++;
      else if (ch === "}") { d--; if (!d) return s.slice(a, i + 1); }
    }
    return null;
  }
  /* the reply was cut off by the output-token cap: close the dangling string and containers */
  function repairTruncated(s) {
    if (!s) return null;
    let inStr = false, esc = false, stack = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
      else if (ch === "}" || ch === "]") stack.pop();
    }
    let out = s;
    if (inStr) out += '"';
    out = out.replace(/[,\s]+$/, "");
    // a dangling "key": with no value is unusable — drop it
    out = out.replace(/"[\s\S]*?":\s*$/, "");
    out = out.replace(/[,\s]+$/, "");
    while (stack.length) out += stack.pop();
    return out;
  }
  function parseJson(text) {
    const raw = stripFence(text);
    const a = raw.indexOf("{");
    if (a < 0) throw Object.assign(new Error("خروجی AI قابل‌خواندن نبود (هیچ JSONی در پاسخ نبود)."), { badJson: true });
    const z = raw.lastIndexOf("}");
    const cands = [firstObject(raw), z > a ? raw.slice(a, z + 1) : null, repairTruncated(raw.slice(a)), repairTruncated(z > a ? raw.slice(a, z + 1) : null)].filter(Boolean);
    for (const c of cands) {
      try { const o = JSON.parse(c); if (o && typeof o === "object") return o; } catch (e) { /* next candidate */ }
    }
    throw Object.assign(new Error("خروجی AI قابل‌خواندن نبود (JSON نامعتبر یا ناقص)."), { badJson: true, detail: "ابتدای پاسخ: " + raw.slice(0, 200) });
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
    const D = FA.data;
    if (D && D.hedge && D.jsonTasks) return D.hedge(D.jsonTasks([url], ms || 12000), 1500); // direct + optional personal relay
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
    "Reply with ONLY one valid JSON object, no markdown, no text before or after. Be COMPACT: one short Persian sentence per text field.",
    '{"ranked":[{"symbol":"","name":"","rank":1,"side":"long|short|none","score":-1..1,"confidence":0..100,',
    '"entry_quality":"excellent|good|weak","risk_level":"low|medium|high","potential":"Persian: why this entry is good",',
    '"risk_note":"Persian: main risk"}],"summary":"2-4 sentences in Persian"}',
    "Include at most 8 entries, best first. Use ONLY the symbols given to you.",
  ].join(" ");
  const n2 = (x, d) => (typeof x === "number" && isFinite(x) ? x.toFixed(d == null ? 2 : d) : "—");
  function marketRow(m) {
    return [m.name + " (" + m.id + ")", "price " + n2(+m.price, 6), "dir " + (m.direction || "none"),
      "conf " + (m.confluence == null ? "—" : m.confluence), "tech " + n2(+m.tech), "pa " + n2(+m.pa),
      "atr% " + n2(+m.atrPct), "rr " + n2(+m.rr),
      m.fund ? "fund " + m.fund.bias + " (" + Math.round(+m.fund.confidence || 0) + "%)" : "",
      m.alert ? "EARLY: " + m.alert : ""].filter(Boolean).join(" | ");
  }
  /* deterministic local ranking (reward potential vs risk) — used as a labelled fallback */
  function localRank(markets) {
    const rows = markets.map((m) => {
      const dir = m.direction === "long" ? 1 : m.direction === "short" ? -1 : 0;
      const t = Math.abs(+m.tech || 0), p = Math.abs(+m.pa || 0), c = (+m.confluence || 0) / 100;
      const raw = dir ? dir * (0.5 * t + 0.3 * p + 0.2 * c) : 0;
      const risk = m.atrPct == null || !isFinite(+m.atrPct) ? 1.2 : Math.max(0.01, +m.atrPct);
      return { m, score: +raw.toFixed(3), risk, rr: +m.rr || 0 };
    });
    const key = (r) => (r.score === 0 ? -1 : Math.abs(r.score) / r.risk);
    rows.sort((a, b) => key(b) - key(a) || b.rr - a.rr);
    return rows.map((r, i) => ({
      symbol: r.m.id, name: r.m.name, rank: i + 1,
      side: r.m.direction === "long" ? "long" : r.m.direction === "short" ? "short" : "none",
      score: r.score, confidence: Math.round(Math.min(95, 35 + 60 * Math.abs(r.score))),
      entry_quality: Math.abs(r.score) >= 0.45 ? "excellent" : Math.abs(r.score) >= 0.2 ? "good" : "weak",
      risk_level: r.risk < 0.6 ? "low" : r.risk < 2 ? "medium" : "high",
      potential: "رتبه‌بندی محلی موتور تکنیکال: امتیاز " + r.score.toFixed(2) + " · نوسان " + (r.m.atrPct == null ? "نامعلوم" : (+r.m.atrPct).toFixed(2) + "%") + (r.m.confluence != null ? " · هم‌سویی " + r.m.confluence : "") + ".",
      risk_note: r.risk >= 2 ? "نوسان بالا؛ حجم را کم کنید." : "",
      confluence: r.m.confluence == null ? null : r.m.confluence, price: r.m.price == null ? null : r.m.price, local: true,
    }));
  }
  /* the model's answer is data, not gospel: keep only real symbols, dedupe, normalise */
  function normalizeRanked(list, markets) {
    const byId = new Map(markets.map((m) => [String(m.id), m]));
    const byName = new Map(markets.map((m) => [String(m.name || "").toLowerCase(), m]));
    const out = [], seen = new Set();
    (Array.isArray(list) ? list : []).forEach((x) => {
      if (!x || typeof x !== "object") return;
      const m = byId.get(String(x.symbol)) || byId.get(String(x.symbol || "").toUpperCase()) || byName.get(String(x.name || "").toLowerCase());
      const id = m ? String(m.id) : String(x.symbol || x.name || "").trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      const side = x.side === "long" || x.side === "short" ? x.side : "none";
      const risk = m && m.atrPct != null && isFinite(+m.atrPct) ? (+m.atrPct < 0.6 ? "low" : +m.atrPct < 2 ? "medium" : "high") : null;
      out.push({
        symbol: id, name: x.name || (m && m.name) || id, side,
        score: Math.max(-1, Math.min(1, +x.score || 0)),
        confidence: Math.max(0, Math.min(100, +x.confidence || 0)),
        entry_quality: ["excellent", "good", "weak"].indexOf(x.entry_quality) >= 0 ? x.entry_quality : side === "none" ? "weak" : "good",
        risk_level: ["low", "medium", "high"].indexOf(x.risk_level) >= 0 ? x.risk_level : risk || "medium",
        potential: typeof x.potential === "string" ? x.potential.slice(0, 400) : "",
        risk_note: typeof x.risk_note === "string" ? x.risk_note.slice(0, 300) : x.risk ? String(x.risk).slice(0, 300) : "",
        confluence: m && m.confluence != null ? m.confluence : null, price: m && m.price != null ? m.price : null,
      });
    });
    return out;
  }

  async function screener(keys, ctx, onProgress) {
    const prov = keys.provider || "gemini", native = PROVIDERS[prov].search;
    const onProg = onProgress || (() => {});
    const all = (ctx.markets || []).filter((m) => m && m.id);
    if (!all.length) throw new Error("بازاری برای رتبه‌بندی نیست؛ اول «اسکن همه‌ی بازارها» را اجرا کنید.");
    /* one giant prompt for 50 markets used to overflow the output cap → truncated JSON.
       Keep the prompt small: pre-filter to the best candidate scores, then batch. */
    const strength = (m) => Math.abs(+m.tech || 0) + Math.abs(+m.pa || 0) + (+m.confluence || 0) / 100;
    const maxMarkets = Math.max(4, Math.min(30, ctx.maxMarkets || 18));
    const batchSize = Math.max(3, Math.min(12, ctx.batchSize || 8));
    const picks = all.slice().sort((a, b) => strength(b) - strength(a)).slice(0, maxMarkets);
    const chunks = [];
    for (let i = 0; i < picks.length; i += batchSize) chunks.push(picks.slice(i, i + batchSize));

    let heads = [];   // declared here: it is used in sourceNote on both branches
    if (!native) {
      onProg("دریافت تیترهای زنده برای رتبه‌بندی…");
      try { heads = await gdeltNews("(federal reserve OR inflation OR \"stock market\" OR gold OR oil OR bitcoin OR forex) (outlook OR forecast OR decision OR data)", 30, "2d"); }
      catch (e) { heads = []; }
    }
    const headTxt = heads.length ? "Macro headlines (context only, never invent others):\n" + heads.map((h) => "- [" + h.date + "] " + h.title + " (" + h.src + ")").join("\n") + "\n\n" : "(no macro headlines available)\n\n";
    const system = (native
      ? "You are a senior trading-desk analyst. The user gives you a scan of many markets produced by a technical engine. Optionally use web_search for the top candidates to check for obvious upcoming catalysts. Rank the best entries for the NEXT days: high reward potential with LOW risk first. Never invent numbers; use only the supplied data plus, if searched, clearly-cited facts. "
      : "You are a senior trading-desk analyst. You have NO web access. Rank the supplied market scan: high reward potential with LOW risk first. Use the supplied technical scores and the supplied macro headlines for context only. Never invent numbers or headlines. ")
      + SCREEN_SHAPE;
    const ranked = [];
    const failed = [];
    let lastError = null, summary = "";
    const runBatch = async (ch, label) => {
      const user = headTxt + "Market scan (these are the ONLY tradeable symbols):\n" + ch.map(marketRow).join("\n") + "\nRank the best entries for the next days (best first, side \"none\" for ones to skip).";
      onProg(label);
      return parseJson(await complete(keys, {
        system, messages: [{ role: "user", content: user }], maxTokens: 6000, search: native, onProgress: onProg,
        retry: { attempts: 1 },   // batching + the second pass below already handle retries
        timeoutMs: 60000,
      }));
    };
    for (let i = 0; i < chunks.length; i++) {
      try {
        const out = await runBatch(chunks[i], "رتبه‌بندی AI — دسته " + (i + 1) + " از " + chunks.length + " (" + chunks[i].length + " بازار)…");
        ranked.push(...normalizeRanked(out.ranked, chunks[i]));
        if (!summary && out.summary) summary = String(out.summary).slice(0, 1200);
      } catch (e) { failed.push(chunks[i]); lastError = e; }
    }
    if (failed.length) {   // one polite second pass for the batches that failed
      onProg("دسته‌های ناموفق: تلاش مجدد پس از مکث کوتاه…");
      await sleep(1500);
      const again = failed.slice();
      failed.length = 0;
      for (let i = 0; i < again.length; i++) {
        try {
          const out = await runBatch(again[i], "تلاش مجدد — " + (i + 1) + " از " + again.length + "…");
          ranked.push(...normalizeRanked(out.ranked, again[i]));
          if (!summary && out.summary) summary = String(out.summary).slice(0, 1200);
        } catch (e) { failed.push(again[i]); lastError = e; }
      }
    }
    const base = { batches: chunks.length, failedBatches: failed.length, candidates: picks.length, total: all.length };
    if (!ranked.length) {
      /* the model layer is unusable right now — never leave the user with only an error:
         return a clearly-labelled local technical ranking instead */
      return Object.assign(base, {
        ranked: localRank(all), local: true,
        aiError: lastError ? lastError.message : "پاسخی از مدل دریافت نشد.",
        summary: "رتبه‌بندی AI انجام نشد؛ این فهرست را موتور تکنیکال به‌صورت محلی و با معیار «سود بالقوه در برابر ریسک» ساخته است.",
        sourceNote: "رتبه‌بندی محلی موتور تکنیکال روی " + all.length + " بازار (بدون AI)",
      });
    }
    // best-first: real candidates before skips, then by |score|
    ranked.sort((a, b) => (a.side === "none" ? 1 : 0) - (b.side === "none" ? 1 : 0) || Math.abs(b.score) - Math.abs(a.score));
    ranked.forEach((x, i) => { x.rank = i + 1; });
    return Object.assign(base, {
      ranked, summary, local: false,
      aiError: failed.length ? "بعضی دسته‌ها پاسخ ندادند (" + (lastError ? lastError.message : "") + ")؛ بخشی از نمادها رتبه‌بندی نشده‌اند." : "",
      sourceNote: native ? "جستجوی زنده‌ی وب (Claude) + موتور تکنیکال · " + chunks.length + " دسته" : "موتور تکنیکال + " + heads.length + " تیتر خبری · " + chunks.length + " دسته × " + batchSize + " نماد",
    });
  }

  async function chat(keys, history, system, onProgress, opts) {
    return complete(keys, Object.assign({ system, messages: history, maxTokens: 1800, onProgress }, opts || {}));
  }

  function chatSystem(ctx) {
    return [
      "You are a candid, experienced trading mentor inside the Fandamental app. Reply in Persian (Farsi), concise and practical.",
      "Rules: never promise or imply guaranteed profit or a fixed accuracy; point out weak spots in the user's reasoning, risk-management gaps and psychological mistakes honestly; prefer asking one sharp question over guessing.",
      "When reviewing losing trades, look for patterns (entry timing, stop placement, counter-trend entries, news-time entries, position sizing, overtrading) and suggest one or two concrete rule changes.",
      "You cannot see live prices or news beyond the context below.",
      "Current app context (JSON):", JSON.stringify(ctx),
    ].join("\n");
  }

  FA.ai = { PROVIDERS, complete, fundamental, screener, chat, chatSystem, getHeadlines, newsQuery, gdeltNews, economicCalendar, parseJson, repairTruncated, firstObject, normalizeRanked, localRank, marketRow };
})(typeof window !== "undefined" ? window : globalThis);
