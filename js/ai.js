/* Fandamental — Anthropic API client (runs in the browser with YOUR key).
   - fundamental(): live news research with the server-side web_search tool -> structured bias.
   - chat(): brainstorming / mistake review, optional chart screenshot (vision). */
(function (g) {
  const FA = (g.FA = g.FA || {});
  const API = "https://api.anthropic.com/v1/messages";

  async function call(keys, body) {
    if (!keys.anthropic) throw new Error("کلید API ی Anthropic را در تنظیمات وارد کنید.");
    const r = await fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": keys.anthropic,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: keys.model || "claude-sonnet-5-5", ...body }),
    });
    let j;
    try { j = await r.json(); } catch (e) { throw new Error("پاسخ نامعتبر از API (HTTP " + r.status + ")"); }
    if (!r.ok) throw new Error((j.error && j.error.message) || "HTTP " + r.status);
    return j;
  }
  const textOf = (j) => (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

  function parseJson(text) {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("خروجی AI قابل‌خواندن نبود.");
    return JSON.parse(text.slice(a, b + 1));
  }

  async function fundamental(keys, ctx) {
    const system = [
      "You are a senior macro / fundamental analyst for traders. Use the web_search tool to find the most relevant news from the last 72 hours",
      "(central banks, inflation/jobs data, rates, geopolitics, sector or on-chain news, supply/demand) for the given instrument, and the high-impact events scheduled in the next 7 days.",
      "Be calibrated: when evidence is mixed or thin, return neutral with low confidence. Never claim certainty and never invent headlines or sources.",
      "Reply with ONLY one valid JSON object, no markdown, in this exact shape:",
      '{"bias":"bullish|bearish|neutral","score":-1..1,"confidence":0..100,"summary":"2-4 sentences in Persian",',
      '"drivers":[{"headline":"","direction":"bullish|bearish|neutral","impact":"high|medium|low","why":"Persian, one sentence","source":"publisher or url"}],',
      '"upcoming_events":[{"event":"","when":"","importance":"high|medium|low","risk":"Persian, one sentence"}],"risks":["Persian"]}',
    ].join(" ");
    const user = `Instrument: ${ctx.name} (${ctx.tv}). Timeframe the trader uses: ${ctx.tf}. Today: ${ctx.today}. Last price: ${ctx.price}.\nTechnical engine currently says: ${ctx.tech}.\nGive the fundamental bias that matters for this timeframe.`;
    let messages = [{ role: "user", content: user }], j;
    for (let k = 0; k < 4; k++) {
      j = await call(keys, { max_tokens: 3000, system, messages, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] });
      if (j.stop_reason !== "pause_turn") break;
      messages = [...messages, { role: "assistant", content: j.content }];
    }
    const out = parseJson(textOf(j));
    out.score = Math.max(-1, Math.min(1, +out.score || 0));
    out.confidence = Math.max(0, Math.min(100, +out.confidence || 0));
    return out;
  }

  async function chat(keys, history, system) {
    const j = await call(keys, { max_tokens: 1800, system, messages: history });
    return textOf(j);
  }

  function chatSystem(ctx) {
    return [
      "You are a candid, experienced trading mentor inside the Fandamental app. Reply in Persian (Farsi), concise and practical.",
      "Rules: never promise or imply guaranteed profit or a fixed accuracy; point out weak spots in the user's reasoning, risk-management gaps and psychological mistakes honestly; prefer asking one sharp question over guessing.",
      "When reviewing losing trades, look for patterns (entry timing, stop placement, counter-trend entries, news-time entries, position sizing, overtrading) and suggest one or two concrete rule changes.",
      "Current app context (JSON):", JSON.stringify(ctx),
    ].join("\n");
  }

  FA.ai = { fundamental, chat, chatSystem };
})(typeof window !== "undefined" ? window : globalThis);
