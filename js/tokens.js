/* Fandamental — crypto token screener ("توکن‌های مستعد رشد").
   Free CoinGecko market data (no key): market cap, fully diluted valuation, circulating / total / max supply,
   24h volume, distance from all-time high, 7d / 30d change.

   Every number in the score is shown and explained; nothing is hidden or "AI-guessed":
     liquidity   (30%)  24h volume ÷ market cap — can the token be traded without moving the price?
     dilution    (35%)  circulating ÷ total supply and FDV ÷ market cap — how much new supply can still hit the market
     strength    (35%)  7d / 30d change RELATIVE to Bitcoin — is it outperforming the market right now?
   Size class and distance from ATH are shown but not scored (they cut both ways).
   Stablecoins, dollar-pegged fund tokens and gold-backed tokens are excluded.

   Limits (said in the UI too): one snapshot of market data; no team, product, revenue, unlock calendar or
   on-chain data, so this is a first filter, not a buy list. With no history of past snapshots, the score
   itself cannot be back-tested here; the existing technical engine can be run on each token instead. */
(function (g) {
  "use strict";
  const FA = (g.FA = g.FA || {});
  const ok = (x) => typeof x === "number" && isFinite(x);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const GOLD = new Set(["xaut", "paxg", "kau", "pmgt", "dgx", "cgo"]);
  const WEIGHTS = { liquidity: 0.3, dilution: 0.35, strength: 0.35 };

  function sizeClass(mc) {
    if (!ok(mc)) return { id: "na", fa: "نامشخص" };
    if (mc >= 10e9) return { id: "large", fa: "بزرگ (بالای ۱۰ میلیارد $)" };
    if (mc >= 1e9) return { id: "mid", fa: "متوسط (۱ تا ۱۰ میلیارد $)" };
    if (mc >= 100e6) return { id: "small", fa: "کوچک (۱۰۰ میلیون تا ۱ میلیارد $)" };
    return { id: "micro", fa: "خیلی کوچک (زیر ۱۰۰ میلیون $)" };
  }

  /** Why a coin is not a "growth" candidate at all (or null). */
  function exclusion(x) {
    const p = x.current_price, d30 = x.price_change_percentage_30d_in_currency, d7 = x.price_change_percentage_7d_in_currency;
    const sym = String(x.symbol || "").toLowerCase(), name = String(x.name || "");
    if (!ok(x.market_cap) || x.market_cap <= 0 || !ok(p) || p <= 0) return "داده‌ی ارزش بازار ناقص";
    if (GOLD.has(sym) || /gold/i.test(name) && Math.abs(d30 || 0) < 15) return "توکن با پشتوانه‌ی طلا";
    if (Math.abs(p - 1) < 0.03 && Math.abs(d30 == null ? 0 : d30) < 3 && Math.abs(d7 == null ? 0 : d7) < 2) return "استیبل‌کوین / توکن وابسته به دلار";
    const d24 = x.price_change_percentage_24h, a30 = Math.abs(d30 == null ? 99 : d30), a7 = Math.abs(d7 == null ? 99 : d7), a24 = Math.abs(d24 == null ? 99 : d24);
    if (a30 < 2 && a7 < 1 && a24 < 0.5) return "تقریباً بی‌نوسان (استیبل‌کوین ارزهای دیگر، اوراق/صندوق توکنیزه یا قیمت کنترل‌شده)";
    if (/\b(fund|treasury|t-bills?|bond|money market|clo|sstn)\b|usd|eur|jpy|dollar/i.test(name + " " + sym) && a30 < 3 && a7 < 1.5) return "استیبل‌کوین یا صندوق/اوراق توکنیزه";
    if (/\b(wrapped|bridged|staked|liquid staking)\b/i.test(name) || /^(w|st|cb|r|we|ez)(btc|eth|sol)$/i.test(sym)) return "توکن پیچیده‌شده یا استیک‌شده (کپی دارایی دیگر)";
    return null;
  }

  /** Score one coin. btc = the Bitcoin row (for relative strength). */
  function scoreToken(x, btc) {
    const ex = exclusion(x);
    if (ex) return { id: x.id, excluded: ex };
    const mc = x.market_cap, vol = x.total_volume, fdv = ok(x.fully_diluted_valuation) && x.fully_diluted_valuation > 0 ? x.fully_diluted_valuation : null;
    const supplyCap = ok(x.max_supply) && x.max_supply > 0 ? x.max_supply : ok(x.total_supply) && x.total_supply > 0 ? x.total_supply : null;
    const circ = ok(x.circulating_supply) && supplyCap ? clamp01(x.circulating_supply / supplyCap) : null;
    const fdvRatio = fdv ? fdv / mc : null;
    const turnover = ok(vol) ? vol / mc : null;
    const d7 = x.price_change_percentage_7d_in_currency, d30 = x.price_change_percentage_30d_in_currency;
    const b7 = btc ? btc.price_change_percentage_7d_in_currency : null, b30 = btc ? btc.price_change_percentage_30d_in_currency : null;
    const rs7 = ok(d7) && ok(b7) ? d7 - b7 : null, rs30 = ok(d30) && ok(b30) ? d30 - b30 : null;

    // liquidity: 0 at ≤0.5% daily turnover, full at ≥10%; above 100% looks like wash trading → penalised
    let liq = null;
    if (turnover != null) liq = turnover > 1 ? 0.4 : clamp01((Math.log10(Math.max(turnover, 1e-6)) - Math.log10(0.005)) / (Math.log10(0.1) - Math.log10(0.005)));
    // dilution: circulating share (unknown max supply = half credit) and FDV/MC
    let dil = null;
    if (circ != null || fdvRatio != null) {
      const a = circ != null ? circ : 0.5;
      const b = fdvRatio != null ? clamp01(1 - (fdvRatio - 1) / 3) : 0.5;   // FDV/MC 1 → 1, 4+ → 0
      dil = 0.6 * a + 0.4 * b;
    }
    // relative strength vs BTC: −30 pts → 0, +30 pts → 1 (30d weighs more than 7d)
    let str = null;
    if (rs7 != null || rs30 != null) {
      const s = (v) => clamp01((v + 30) / 60);
      str = rs30 != null && rs7 != null ? 0.65 * s(rs30) + 0.35 * s(rs7) : s(rs30 != null ? rs30 : rs7);
    }
    const parts = { liquidity: liq, dilution: dil, strength: str };
    let wsum = 0, acc = 0;
    for (const k in parts) if (parts[k] != null) { acc += WEIGHTS[k] * parts[k]; wsum += WEIGHTS[k]; }
    const score = wsum >= 0.6 ? Math.round((100 * acc) / wsum) : null;

    const flags = [];
    if (circ != null && circ < 0.5) flags.push({ kind: "risk", text: `فقط ${Math.round(circ * 100)}٪ عرضه در گردش است؛ آزاد شدن توکن‌ها (آنلاک) می‌تواند فشار فروش بسازد` });
    if (fdvRatio != null && fdvRatio > 2) flags.push({ kind: "risk", text: `ارزش رقیق‌شده ${fdvRatio.toFixed(1)} برابر ارزش بازار است` });
    if (turnover != null && turnover < 0.01) flags.push({ kind: "risk", text: "حجم معاملات نسبت به ارزش بازار خیلی کم است (نقدشوندگی ضعیف)" });
    if (turnover != null && turnover > 1) flags.push({ kind: "risk", text: "حجم معاملات روزانه بیشتر از کل ارزش بازار؛ احتمال حجم ساختگی یا هیجان کوتاه‌مدت" });
    if (mc < 100e6) flags.push({ kind: "risk", text: "ارزش بازار زیر ۱۰۰ میلیون دلار: نوسان و ریسک دستکاری بالا" });
    if (ok(d7) && d7 > 60) flags.push({ kind: "risk", text: `رشد ${Math.round(d7)}٪ در یک هفته؛ ورود دیرهنگام بعد از پامپ خطرناک است` });
    if (supplyCap == null) flags.push({ kind: "info", text: "سقف عرضه نامشخص یا نامحدود" });
    if (rs30 != null && rs30 > 10) flags.push({ kind: "good", text: `در ۳۰ روز ${Math.round(rs30)} واحد درصد بهتر از بیت‌کوین` });
    if (circ != null && circ >= 0.9) flags.push({ kind: "good", text: "بیش از ۹۰٪ عرضه در گردش است (ریسک آنلاک کم)" });

    return {
      id: x.id, symbol: String(x.symbol || "").toUpperCase(), name: x.name, rank: x.market_cap_rank, price: x.current_price,
      mc, fdv, fdvRatio, vol, turnover, circ, d7, d30, rs7, rs30, ath: x.ath_change_percentage, size: sizeClass(mc),
      parts, score, flags, risky: flags.filter((f) => f.kind === "risk").length,
    };
  }

  function screen(rows, opt = {}) {
    const btc = rows.find((x) => x.id === "bitcoin") || null;
    const scored = rows.map((x) => scoreToken(x, btc));
    const kept = scored.filter((s) => !s.excluded && s.score != null)
      .filter((s) => !opt.minMc || s.mc >= opt.minMc)
      .filter((s) => !opt.size || opt.size === "all" || s.size.id === opt.size)
      .filter((s) => !opt.hideRisky || s.risky === 0);
    const by = opt.sort || "score";
    const key = { score: (s) => s.score, strength: (s) => s.parts.strength ?? -1, liquidity: (s) => s.parts.liquidity ?? -1, dilution: (s) => s.parts.dilution ?? -1, ath: (s) => -(s.ath ?? 0) };
    kept.sort((a, b) => (key[by] || key.score)(b) - (key[by] || key.score)(a));
    return { rows: kept, excluded: scored.filter((s) => s.excluded), btc };
  }

  FA.tokens = { scoreToken, screen, exclusion, sizeClass, WEIGHTS };

  /* ------------------------------------------------------------ UI (browser only) */
  if (typeof document === "undefined") return;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const money = (x) => (!ok(x) ? "—" : x >= 1e9 ? (x / 1e9).toFixed(1) + "B" : x >= 1e6 ? (x / 1e6).toFixed(0) + "M" : (x / 1e3).toFixed(0) + "K");
  const pct = (x, d = 0) => (ok(x) ? (x > 0 ? "+" : "") + x.toFixed(d) + "%" : "—");
  const U = { data: load("fa_tokens_cache", null), opt: Object.assign({ minMc: 100e6, size: "all", sort: "score", hideRisky: false, pages: 1 }, load("fa_tokens_opt", {})), busy: false, err: "", tech: {}, open: null };

  async function fetchMarkets() {
    const D = FA.data, all = [];
    for (let p = 1; p <= U.opt.pages; p++) {
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}&price_change_percentage=7d,30d`;
      const rows = await D.hedge(D.jsonTasks([url], 25000), 1500);
      if (!Array.isArray(rows)) throw new Error("پاسخ نامعتبر از CoinGecko");
      all.push(...rows);
    }
    return all;
  }

  async function refresh(force) {
    if (U.busy) return;
    if (!force && U.data && Date.now() - U.data.t < 10 * 60 * 1000 && U.data.pages === U.opt.pages) return render();
    U.busy = true; U.err = ""; render();
    try {
      const rows = await fetchMarkets();
      U.data = { t: Date.now(), rows, pages: U.opt.pages };
      save("fa_tokens_cache", U.data);
    } catch (e) {
      U.err = "دریافت داده از CoinGecko ممکن نشد: " + (e.message || e) + (U.data ? " — آخرین داده‌ی ذخیره‌شده نمایش داده می‌شود." : " — اگر سایت در شبکه‌ی شما بسته است، «رله‌ی شخصی» را در ⚙ تنظیمات بگذارید.");
    } finally { U.busy = false; render(); }
  }

  /* technical check with the existing engine (daily candles), one token at a time */
  async function techCheck(list) {
    for (const s of list) {
      if (U.tech[s.id] && U.tech[s.id].state !== "error") continue;
      U.tech[s.id] = { state: "loading" }; render();
      const sym = { id: s.symbol + "USDT", name: s.name, group: "کریپتو", bn: s.symbol + "USDT", tv: "BINANCE:" + s.symbol + "USDT" };
      try {
        const D = FA.data, tf = D.TIMEFRAMES.find((t) => t.id === "1d");
        const r = await D.fetchCandles(sym, tf, load("fa_keys", {}), 500);
        const a = FA.signal.analyze(r.candles, { early: true, threshold: load("fa_thr", 70), useSetups: load("fa_use_setups", false) });
        U.tech[s.id] = a.error ? { state: "error", err: a.error } : { state: "ok", dir: a.direction, conf: a.confluence, tradeable: a.tradeable, type: a.signalType, setups: a.setups ? a.setups.setups.length : 0 };
      } catch (e) { U.tech[s.id] = { state: "error", err: "این توکن در صرافی‌های منبع (بایننس/نوبیتکس/والکس) جفت USDT ندارد یا پاسخ نیامد" }; }
      render();
    }
  }

  function openChart(s) {
    const sym = { id: s.symbol + "USDT", name: `${s.name} (${s.symbol})`, short: s.symbol, group: "کریپتو", bn: s.symbol + "USDT", tv: "BINANCE:" + s.symbol + "USDT", yh: s.symbol + "-USD" };
    if (FA.app && FA.app.openSymbol) FA.app.openSymbol(sym);
  }

  const bar = (v) => (v == null ? '<span class="hint">—</span>' : `<span class="tkbar"><i style="width:${Math.round(v * 100)}%"></i></span><small>${Math.round(v * 100)}</small>`);
  const DIRW = { long: "<b class='win'>خرید</b>", short: "<b class='loss'>فروش</b>", none: "بدون جهت" };

  function render() {
    const box = $("#tokScreen"); if (!box) return;
    const o = U.opt, res = U.data ? screen(U.data.rows, o) : null, top = res ? res.rows.slice(0, 40) : [];
    const techCell = (s) => {
      const t = U.tech[s.id]; if (!t) return `<button class="btn ghost" data-tk-tech="${esc(s.id)}">بررسی</button>`;
      if (t.state === "loading") return '<span class="hint">…</span>';
      if (t.state === "error") return `<span class="hint" title="${esc(t.err)}">ندارد</span>`;
      return `${DIRW[t.dir]} <small>${t.conf}${t.tradeable ? " ✓" : ""}</small>`;
    };
    const rowsHtml = top.map((s) => `
      <tr class="${U.open === s.id ? "hl" : ""}">
        <td class="tkn"><b>${esc(s.symbol)}</b><small>#${s.rank || "—"} ${esc(s.name)}</small></td>
        <td class="mono">${money(s.mc)}</td><td><b>${s.score}</b></td>
        <td class="mono ${s.rs30 > 0 ? "win" : s.rs30 < 0 ? "loss" : ""}">${pct(s.rs30)}</td>
        <td>${s.risky ? `<span class="badge wait">${s.risky} ریسک</span>` : '<span class="hint">—</span>'}</td>
        <td>${techCell(s)}</td>
        <td><button class="btn ghost" data-tk-more="${esc(s.id)}">${U.open === s.id ? "▴" : "▾"}</button></td></tr>
      ${U.open === s.id ? `<tr class="mtf-detail"><td colspan="7"><div class="mtf-card" style="--c:var(--acc)">
        <div class="mtf-dh"><b>${esc(s.name)} (${esc(s.symbol)})</b> <span class="hint">رتبه ${s.rank || "—"} · ${esc(s.size.fa)} · قیمت $${s.price}</span></div>
        <div class="mtf-kv">
          <div><span>ارزش بازار / ارزش کاملاً رقیق‌شده</span><b class="mono">${money(s.mc)} / ${money(s.fdv)}${s.fdvRatio ? ` (×${s.fdvRatio.toFixed(2)})` : ""}</b></div>
          <div><span>عرضه‌ی در گردش از کل</span><b class="mono">${s.circ != null ? Math.round(s.circ * 100) + "%" : "نامشخص"}</b></div>
          <div><span>حجم ۲۴ ساعته / ارزش بازار</span><b class="mono">${money(s.vol)} (${s.turnover != null ? (s.turnover * 100).toFixed(1) + "%" : "—"})</b></div>
          <div><span>تغییر ۷ / ۳۰ روزه</span><b class="mono">${pct(s.d7, 1)} / ${pct(s.d30, 1)}</b></div>
          <div><span>نسبت به بیت‌کوین (۷ / ۳۰ روزه)</span><b class="mono">${pct(s.rs7, 1)} / ${pct(s.rs30, 1)}</b></div>
          <div><span>فاصله از سقف تاریخی (ATH)</span><b class="mono">${pct(s.ath, 0)}</b></div>
          <div><span>نقدشوندگی (۳۰٪)</span><b>${bar(s.parts.liquidity)}</b></div>
          <div><span>ریسک رقیق‌شدن کم (۳۵٪)</span><b>${bar(s.parts.dilution)}</b></div>
          <div><span>قدرت نسبی در برابر بیت‌کوین (۳۵٪)</span><b>${bar(s.parts.strength)}</b></div>
        </div>
        ${s.flags.length ? `<ul class="reasons">${s.flags.map((f) => `<li class="${f.kind === "risk" ? "loss" : f.kind === "good" ? "win" : ""}">${esc(f.text)}</li>`).join("")}</ul>` : ""}
        <div class="row"><button class="btn primary" data-tk-chart="${esc(s.id)}">تحلیل تکنیکال کامل روی چارت</button><a class="btn ghost" href="https://www.coingecko.com/en/coins/${encodeURIComponent(s.id)}" target="_blank" rel="noopener">صفحه‌ی CoinGecko (تیم، پروژه، آنلاک‌ها)</a></div>
      </div></td></tr>` : ""}`).join("");
    const age = U.data ? Math.round((Date.now() - U.data.t) / 60000) : null;
    box.innerHTML = `
      <h4>غربالگری توکن‌های کریپتو (بنیادی) <span class="hint">داده‌ی رایگان CoinGecko</span></h4>
      <p class="hint">توکن‌ها بر اساس <b>نقدشوندگی</b> (حجم به ارزش بازار، ۳۰٪)، <b>ریسک رقیق‌شدن</b> (عرضه‌ی در گردش و نسبت ارزش رقیق‌شده، ۳۵٪) و <b>قدرت نسبی در برابر بیت‌کوین</b> (۷ و ۳۰ روزه، ۳۵٪) امتیاز می‌گیرند. استیبل‌کوین‌ها، توکن‌های وابسته به دلار و طلا حذف می‌شوند.</p>
      <div class="row tkctl">
        <select data-tk-opt="minMc">${[[0, "همه‌ی اندازه‌ها"], [10e6, "ارزش بازار ≥ ۱۰M$"], [100e6, "≥ ۱۰۰M$"], [1e9, "≥ ۱B$"]].map(([v, n]) => `<option value="${v}" ${+o.minMc === v ? "selected" : ""}>${n}</option>`).join("")}</select>
        <select data-tk-opt="size">${[["all", "همه‌ی کلاس‌ها"], ["large", "بزرگ"], ["mid", "متوسط"], ["small", "کوچک"], ["micro", "خیلی کوچک"]].map(([v, n]) => `<option value="${v}" ${o.size === v ? "selected" : ""}>${n}</option>`).join("")}</select>
        <select data-tk-opt="sort">${[["score", "مرتب: امتیاز کل"], ["strength", "قدرت نسبی"], ["liquidity", "نقدشوندگی"], ["dilution", "ریسک رقیق‌شدن کم"], ["ath", "بیشترین فاصله از سقف"]].map(([v, n]) => `<option value="${v}" ${o.sort === v ? "selected" : ""}>${n}</option>`).join("")}</select>
        <select data-tk-opt="pages"><option value="1" ${o.pages == 1 ? "selected" : ""}>۲۵۰ توکن اول</option><option value="2" ${o.pages == 2 ? "selected" : ""}>۵۰۰ توکن اول</option></select>
        <label class="hint"><input type="checkbox" data-tk-opt="hideRisky" ${o.hideRisky ? "checked" : ""}> فقط بدون هشدار ریسک</label>
        <button class="btn primary" data-tk-refresh>${U.busy ? "در حال دریافت…" : "دریافت داده"}</button>
        ${top.length ? `<button class="btn ghost" data-tk-techtop>بررسی تکنیکال ۱۰ توکن اول</button>` : ""}
      </div>
      ${U.err ? `<div class="warn">${esc(U.err)}</div>` : ""}
      ${res ? `<div class="hint">به‌روزرسانی: ${age === 0 ? "همین الان" : age + " دقیقه پیش"} · ${res.rows.length} توکن پس از فیلتر · ${res.excluded.length} حذف‌شده (استیبل/طلا/داده‌ی ناقص) · بیت‌کوین ۳۰ روزه ${pct(res.btc && res.btc.price_change_percentage_30d_in_currency, 1)}</div>
        <div class="mtf-wrap"><table class="btable tktable"><thead><tr><th>توکن</th><th>ارزش بازار</th><th>امتیاز</th><th title="تغییر ۳۰ روزه منهای تغییر بیت‌کوین">در برابر BTC</th><th>هشدار</th><th title="موتور تحلیل اپ روی کندل روزانه؛ ✓ = سیگنال معتبر">تکنیکال روزانه</th><th></th></tr></thead><tbody>${rowsHtml || '<tr><td colspan="7" class="hint">با این فیلترها توکنی نماند.</td></tr>'}</tbody></table></div>`
        : '<div class="empty">برای شروع «دریافت داده» را بزنید.</div>'}
      <ul class="warns">
        <li>این غربالگری اولین فیلتر است، نه فهرست خرید: تیم، کاربرد واقعی، درآمد پروژه، تقویم آنلاک و داده‌ی آن‌چین را نمی‌بیند. برای این‌ها صفحه‌ی CoinGecko هر توکن را بخوانید.</li>
        <li>امتیاز احتمال رشد نیست؛ چون تاریخچه‌ی این داده در دسترس نیست، خود امتیاز بک‌تست نشده است. «بررسی» تکنیکال همان موتور اپ را روی کندل روزانه‌ی توکن اجرا می‌کند و تب «بک‌تست» عملکرد آن را روی هر توکن نشان می‌دهد.</li>
        <li>توکن‌های کوچک‌تر بیشترین نوسان را دارند: هم رشد و هم سقوط شدیدتر.</li></ul>`;
  }

  function boot() {
    const best = $("#r-best"); if (!best) return;
    const box = document.createElement("div"); box.id = "tokScreen"; box.className = "tokscreen"; best.append(box);
    box.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("[data-tk-refresh]")) return refresh(true);
      if (t.closest("[data-tk-techtop]")) { const r = screen(U.data.rows, U.opt).rows.slice(0, 10); return techCheck(r); }
      const a = t.closest("[data-tk-tech]"); if (a) { const s = screen(U.data.rows, U.opt).rows.find((x) => x.id === a.dataset.tkTech); if (s) techCheck([s]); return; }
      const m = t.closest("[data-tk-more]"); if (m) { U.open = U.open === m.dataset.tkMore ? null : m.dataset.tkMore; return render(); }
      const c = t.closest("[data-tk-chart]"); if (c) { const s = screen(U.data.rows, U.opt).rows.find((x) => x.id === c.dataset.tkChart); if (s) openChart(s); }
    });
    box.addEventListener("change", (e) => {
      const el = e.target.closest("[data-tk-opt]"); if (!el) return;
      const k = el.dataset.tkOpt;
      U.opt[k] = el.type === "checkbox" ? el.checked : k === "size" || k === "sort" ? el.value : +el.value;
      save("fa_tokens_opt", U.opt);
      if (k === "pages") refresh(true); else render();
    });
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})(typeof window !== "undefined" ? window : globalThis);
