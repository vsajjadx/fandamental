/* Fandamental — MetaTrader 5 bridge (web-app side).
   Sends the signals that js/signal.js ALREADY produced to the bridge server (server/), and manages
   MT5 connections: status, mode (display / manual approval / automatic), risk settings, live switch,
   and the per-account execution log. It never changes how signals are produced.

   Pure helpers (payload building, ids) are exported on FA.mt5 so they can be unit-tested in Node. */
(function (g) {
  "use strict";
  const FA = (g.FA = g.FA || {});

  /* ------------------------------------------------------------ pure helpers */
  const TTL_BY_TF = { "5m": 600, "15m": 1800, "1h": 3600, "4h": 14400, "1d": 86400 };

  function clientSignalId(sym, tf, res) {
    // deterministic: re-sending the same analysis of the same candle is a no-op on the server
    const p = res.plan || {};
    return [sym.id, tf.id, res.lastTime, res.direction, res.signalType, Math.round((p.entry || 0) * 1e6)].join(":").replace(/[^A-Za-z0-9_.:\-]/g, "_").slice(0, 100);
  }

  /** Turns one analyze() result into the bridge payload, or explains why it cannot be sent. */
  function buildPayload(res, sym, tf, analyzedAtMs) {
    if (!res || res.error) return { error: "هنوز تحلیلی انجام نشده." };
    if (!res.plan || res.direction === "none") return { error: "سیگنال فعلی جهت/پلن معامله ندارد؛ چیزی برای ارسال نیست." };
    if (sym.tse) return { error: "نمادهای بورس تهران در متاتریدر معامله نمی‌شوند." };
    if (!/^[A-Za-z0-9._\-/]{1,32}$/.test(sym.id)) return { error: "این نماد برای MT5 قابل ارسال نیست." };
    const p = res.plan, buy = res.direction === "long";
    const nums = [p.entry, p.sl, p.tps[0]];
    if (!nums.every((x) => typeof x === "number" && isFinite(x) && x > 0)) return { error: "سطوح ورود/حد ضرر/تارگت نامعتبر است." };
    if (buy ? !(p.sl < p.entry && p.entry < p.tps[0]) : !(p.sl > p.entry && p.entry > p.tps[0])) return { error: "ترتیب حد ضرر/ورود/تارگت با جهت معامله سازگار نیست." };
    const ok = (t) => typeof t === "number" && isFinite(t) && (buy ? t > p.entry : t < p.entry);
    const payload = {
      client_signal_id: clientSignalId(sym, tf, res),
      symbol: sym.id,
      direction: buy ? "buy" : "sell",
      order_type: p.isLimit ? "limit" : "market",
      entry: p.entry, sl: p.sl, tp: p.tps[0],
      timeframe: tf.id,
      generated_at: Math.floor((analyzedAtMs || Date.now()) / 1000),
      valid_for_sec: TTL_BY_TF[tf.id] || 3600,
      confluence: Math.max(0, Math.min(100, Math.round(res.confluence || 0))),
      signal_type: res.signalType || "entry",
      note: res.tradeable ? "" : "below confluence threshold",
    };
    if (ok(p.tps[1])) payload.tp2 = p.tps[1];
    if (ok(p.tps[2]) && payload.tp2 !== undefined) payload.tp3 = p.tps[2];
    return { payload };
  }

  function normalizeBase(url) {
    const u = String(url || "").trim().replace(/\/+$/, "");
    if (!u) return { error: "آدرس سرور خالی است." };
    if (!/^https:\/\//i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(u)) return { error: "آدرس سرور باید با https:// شروع شود." };
    return { base: u };
  }

  function makeClient(base, key, fetchImpl) {
    const f = fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(g) : null);
    return async function api(method, path, body) {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const t = ctl ? setTimeout(() => ctl.abort(), 12000) : null;
      let r;
      try {
        r = await f(base + path, {
          method, signal: ctl ? ctl.signal : undefined,
          headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        throw Object.assign(new Error("سرور در دسترس نیست (" + (e.name === "AbortError" ? "timeout" : e.message) + ")"), { network: true });
      } finally { if (t) clearTimeout(t); }
      let data = {};
      try { data = await r.json(); } catch (e) { /* empty body */ }
      if (!r.ok) {
        const er = (data && data.error) || {};
        throw Object.assign(new Error(er.message || "HTTP " + r.status), { status: r.status, code: er.code, data: er });
      }
      return data;
    };
  }

  const STATE_FA = {
    awaiting_approval: "منتظر تأیید شما", pending: "در صف ارسال", approved: "تأیید شد", delivered: "تحویل به MT5", sending: "در حال ارسال سفارش",
    unknown: "نامشخص (در حال تطبیق)", displayed: "نمایش داده شد", filled: "اجرا شد", placed: "سفارش لیمیت ثبت شد", rejected: "رد شد",
    failed: "خطای بروکر", expired: "منقضی شد", cancelled: "لغو شد",
  };
  const MODE_FA = { notify: "فقط نمایش سیگنال", confirm: "اجرا پس از تأیید من", auto: "اجرای خودکار" };

  FA.mt5 = { buildPayload, clientSignalId, normalizeBase, makeClient, TTL_BY_TF, STATE_FA, MODE_FA };

  /* ------------------------------------------------------------ UI (browser only) */
  if (typeof document === "undefined") return;

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const ago = (ts) => { if (!ts) return "هرگز"; const s = Math.max(0, Math.floor(Date.now() / 1000 - ts)); return s < 60 ? s + " ثانیه پیش" : s < 3600 ? Math.floor(s / 60) + " دقیقه پیش" : new Date(ts * 1000).toLocaleString("fa-IR", { hour12: false }); };
  const fx = (x) => (x == null ? "—" : String(+(+x).toPrecision(8)));

  const M = {
    cfg: load("fa_mt5", { url: "", key: "", autoSend: false }),
    last: null, sentIds: load("fa_mt5_sent", []), accounts: [], executions: [], timer: null, newKey: null, err: "", busy: false,
  };
  const api = () => {
    const n = normalizeBase(M.cfg.url);
    if (n.error) throw new Error(n.error);
    if (!M.cfg.key) throw new Error("کلید API وب‌اپ را وارد کنید.");
    return makeClient(n.base, M.cfg.key);
  };
  const configured = () => !!(M.cfg.url && M.cfg.key);
  const toast = (msg, kind) => {
    const wrap = $("#toasts"); if (!wrap) return;
    const d = document.createElement("div"); d.className = "toast " + (kind || "info"); d.innerHTML = msg; wrap.append(d);
    setTimeout(() => d.remove(), 6000);
  };

  async function send(auto) {
    if (!M.last) { toast("اول «تحلیل کن» را بزنید.", "err"); return; }
    const { res, sym, tf, at } = M.last;
    const b = buildPayload(res, sym, tf, at);
    if (b.error) { if (!auto) toast(esc(b.error), "err"); return; }
    if (!auto && !res.tradeable && !confirm("امتیاز هم‌سویی این سیگنال به حد «سیگنال معتبر» نرسیده است. باز هم به MT5 ارسال شود؟")) return;
    try {
      const r = await api()("POST", "/api/v1/signals", b.payload);
      M.sentIds = [b.payload.client_signal_id, ...M.sentIds.filter((x) => x !== b.payload.client_signal_id)].slice(0, 50); save("fa_mt5_sent", M.sentIds);
      const n = (r.signal.executions || []).length;
      toast(r.created ? `سیگنال ${esc(sym.name)} به ${n} اتصال MT5 ارسال شد.` : "این سیگنال قبلاً ارسال شده بود (ارسال تکراری انجام نشد).", "info");
      paintBar(); refresh();
    } catch (e) {
      toast("ارسال به MT5 ناموفق: " + esc(e.message) + (e.code === "stale_signal" ? " — دوباره «تحلیل کن» را بزنید." : ""), "err");
    }
  }

  function paintBar() {
    const box = $("#signalBox"); if (!box || !M.last) return;
    let bar = $("#mt5Bar");
    if (!bar) { bar = document.createElement("div"); bar.id = "mt5Bar"; bar.className = "mt5bar"; box.append(bar); }
    const b = buildPayload(M.last.res, M.last.sym, M.last.tf, M.last.at);
    if (b.error) { bar.innerHTML = `<span class="hint">MT5: ${esc(b.error)}</span>`; return; }
    const sent = M.sentIds.includes(b.payload.client_signal_id);
    bar.innerHTML = configured()
      ? `<button class="btn ${sent ? "ghost" : "primary"}" id="btnMt5Send">${sent ? "✓ ارسال شد به MT5" : "ارسال این سیگنال به MT5"}</button>
         <span class="hint">${M.cfg.autoSend ? "ارسال خودکار سیگنال‌های معتبر روشن است" : ""}</span>`
      : `<span class="hint">برای ارسال به متاتریدر، تب «MT5» را تنظیم کنید.</span>`;
    const btn = $("#btnMt5Send"); if (btn) btn.onclick = () => send(false);
  }

  function onAnalysis(ev) {
    M.last = { ...ev.detail, at: Date.now() };
    paintBar();
    if (M.cfg.autoSend && configured() && M.last.res && M.last.res.tradeable) {
      const b = buildPayload(M.last.res, M.last.sym, M.last.tf, M.last.at);
      if (!b.error && !M.sentIds.includes(b.payload.client_signal_id)) send(true);
    }
  }

  /* ---------- MT5 tab ---------- */
  async function refresh() {
    const pane = $("#r-mt5"); if (!pane || !pane.classList.contains("on") || !configured() || M.busy) return;
    M.busy = true;
    try {
      const c = api();
      const [a, e] = await Promise.all([c("GET", "/api/v1/accounts"), c("GET", "/api/v1/executions?limit=40")]);
      M.accounts = a.accounts; M.executions = e.executions; M.err = "";
    } catch (e) { M.err = e.message; }
    finally { M.busy = false; }
    render();
  }

  function settingsForm(a) {
    const s = a.settings, f = (k, label, attrs) => `<label>${label}<input data-k="${k}" value="${esc(s[k] == null ? "" : s[k])}" ${attrs || ""}></label>`;
    return `<details class="mt5set"><summary>تنظیمات ریسک و نماد</summary><div class="mt5grid">
      ${f("risk_percent", "ریسک هر معامله (% موجودی)", 'type="number" step="0.1" min="0.1" max="5"')}
      ${f("fixed_lot", "لات ثابت (خالی = از روی ریسک)", 'type="number" step="0.01" min="0"')}
      ${f("max_lot", "حداکثر لات", 'type="number" step="0.01" min="0.01"')}
      ${f("max_open_positions", "حداکثر پوزیشن باز هم‌زمان", 'type="number" min="1" max="50"')}
      ${f("max_daily_loss_percent", "حد ضرر روزانه (% موجودی)", 'type="number" step="0.5" min="0"')}
      ${f("max_spread_points", "حداکثر اسپرد (پوینت؛ ۰ = خاموش)", 'type="number" min="0"')}
      ${f("max_spread_sl_ratio", "حداکثر اسپرد نسبت به فاصله‌ی حد ضرر", 'type="number" step="0.05" min="0" max="1"')}
      ${f("max_entry_dev_sl_ratio", "حداکثر فاصله‌ی قیمت از نقطه‌ی ورود (نسبت به حد ضرر)", 'type="number" step="0.05" min="0" max="1"')}
      <label>تارگت مورد استفاده<select data-k="tp_index">${[1, 2, 3].map((i) => `<option value="${i}" ${s.tp_index === i ? "selected" : ""}>تارگت ${i}</option>`).join("")}</select></label>
      ${f("symbol_suffix", "پسوند نماد بروکر (مثلاً .m)", 'dir="ltr" maxlength="12"')}
      <label class="wide">نگاشت نماد (JSON) <small>مثلاً {"SPX":"US500","BTCUSDT":"BTCUSD"}</small><input data-k="symbol_map" dir="ltr" value="${esc(JSON.stringify(s.symbol_map || {}))}"></label>
      </div><div class="row"><button class="btn primary" data-act="save" data-id="${a.id}">ذخیره‌ی تنظیمات</button></div></details>`;
  }

  function accountCard(a) {
    const t = a.terminal, real = t.trade_mode && t.trade_mode !== "demo";
    const conn = t.connected ? `<span class="badge ok">● متصل</span>` : `<span class="badge wait">○ ${t.last_seen_at ? "قطع" : "هنوز وصل نشده"}</span>`;
    const acct = t.login ? `${esc(t.company || "")} · ${esc(t.server || "")} · #${esc(t.login)} · <b class="${real ? "loss" : ""}">${t.trade_mode === "demo" ? "دمو" : t.trade_mode === "real" ? "واقعی" : esc(t.trade_mode || "?")}</b>` : "اکسپرت هنوز به این اتصال وصل نشده است.";
    return `<div class="mt5acc ${a.enabled ? "" : "off"}">
      <div class="mt5head"><b>${esc(a.name)}</b> ${conn} <span class="hint">آخرین ارتباط: ${ago(t.last_seen_at)}</span></div>
      <div class="hint">${acct}${t.balance != null ? ` · موجودی ${fx(t.balance)} ${esc(t.currency || "")} · اکوئیتی ${fx(t.equity)}` : ""}${t.ea_version ? " · EA v" + esc(t.ea_version) : ""}</div>
      <div class="row">
        <label class="hint"><input type="checkbox" data-act="enabled" data-id="${a.id}" ${a.enabled ? "checked" : ""}> اتصال فعال</label>
        <select data-act="mode" data-id="${a.id}">${Object.entries(MODE_FA).map(([k, v]) => `<option value="${k}" ${a.mode === k ? "selected" : ""}>${v}</option>`).join("")}</select>
      </div>
      <div class="row">
        <span class="hint">معامله‌ی واقعی: <b class="${a.live_enabled ? "loss" : ""}">${a.live_enabled ? "فعال" : "غیرفعال"}</b></span>
        <button class="btn ghost" data-act="${a.live_enabled ? "live-off" : "live-on"}" data-id="${a.id}">${a.live_enabled ? "غیرفعال کردن معامله‌ی واقعی" : "فعال‌سازی معامله‌ی واقعی…"}</button>
        <button class="btn ghost" data-act="rotate" data-id="${a.id}" title="کلید قبلی بلافاصله باطل می‌شود">کلید جدید ترمینال</button>
        ${t.login ? `<button class="btn ghost" data-act="unbind" data-id="${a.id}" title="برای وصل کردن همین کلید به حساب MT5 دیگر">جداکردن حساب</button>` : ""}
      </div>
      ${settingsForm(a)}
    </div>`;
  }

  function execTable() {
    if (!M.executions.length) return `<div class="empty">هنوز سیگنالی به MT5 ارسال نشده.</div>`;
    const accName = (id) => (M.accounts.find((a) => a.id === id) || {}).name || id.slice(0, 6);
    const cls = (s) => (["filled", "placed", "displayed"].includes(s) ? "win" : ["rejected", "failed", "expired", "cancelled", "unknown"].includes(s) ? "loss" : "");
    return `<table class="btable mt5ex"><tr><th>زمان</th><th>نماد</th><th>جهت</th><th>حساب</th><th>وضعیت</th><th>اجرا</th><th></th></tr>` +
      M.executions.map((e) => {
        const s = e.signal || {};
        const act = e.state === "awaiting_approval"
          ? `<button class="btn primary" data-act="approve" data-id="${e.id}">تأیید</button> <button class="btn ghost" data-act="reject" data-id="${e.id}">رد</button>`
          : ["pending", "approved", "delivered"].includes(e.state) ? `<button class="btn ghost" data-act="reject" data-id="${e.id}">لغو</button>` : "";
        const exec = e.fill_price ? `${fx(e.fill_price)} × ${fx(e.volume)}${e.ticket ? " #" + esc(e.ticket) : ""}` : e.ticket ? "#" + esc(e.ticket) : "—";
        const pl = e.position_status === "closed" ? `<br><span class="${e.profit >= 0 ? "win" : "loss"}">بسته شد (${esc(e.close_reason || "")}) ${fx(e.profit)}</span>` : e.position_status === "open" ? "<br><span class='hint'>پوزیشن باز</span>" : "";
        return `<tr><td>${new Date(e.created_at * 1000).toLocaleTimeString("fa-IR", { hour12: false })}</td><td>${esc(e.broker_symbol || s.symbol)}</td>
          <td class="${s.direction === "buy" ? "win" : "loss"}">${s.direction === "buy" ? "خرید" : "فروش"}</td><td>${esc(accName(e.account_id))}</td>
          <td class="${cls(e.state)}" title="${esc(e.reason)}">${esc(STATE_FA[e.state] || e.state)}${e.reason ? `<br><small class="hint">${esc(e.reason)}</small>` : ""}</td>
          <td>${exec}${pl}</td><td>${act}</td></tr>`;
      }).join("") + "</table>";
  }

  function render() {
    const pane = $("#r-mt5"); if (!pane) return;
    const keyBox = M.newKey ? `<div class="warn mt5key"><b>کلید ترمینال (فقط همین یک بار نمایش داده می‌شود):</b><code dir="ltr">${esc(M.newKey)}</code>
        <div class="row"><button class="btn ghost" data-act="copykey">کپی</button><button class="btn ghost" data-act="hidekey">کپی کردم، پنهان کن</button></div>
        <div class="hint">این کلید را در ورودی InpTerminalKey اکسپرت FandamentalBridge در متاتریدر بچسبانید.</div></div>` : "";
    pane.innerHTML = `
      <p class="hint">سیگنال‌های همین وب‌اپ را به متاتریدر ۵ می‌فرستد. پیش‌فرض «فقط نمایش» است و هیچ معامله‌ی واقعی بدون فعال‌سازی صریح شما انجام نمی‌شود. اول روی حساب <b>دمو</b> آزمایش کنید. راهنمای کامل: <code>docs/MT5.md</code></p>
      <details ${configured() ? "" : "open"} class="mt5set"><summary>اتصال به سرور پل (Bridge)</summary>
        <label>آدرس سرور<input id="mt5Url" dir="ltr" placeholder="https://bridge.example.com" value="${esc(M.cfg.url)}"></label>
        <label>کلید API وب‌اپ <small>(fa_u_… — از ادمین سرور)</small><input id="mt5Key" type="password" dir="ltr" autocomplete="off" value="${esc(M.cfg.key)}"></label>
        <div class="row"><button class="btn primary" data-act="savecfg">ذخیره و آزمایش اتصال</button><button class="btn ghost" data-act="clearcfg">پاک کردن</button></div>
        <p class="warn">کلید فقط در مرورگر همین دستگاه ذخیره می‌شود. روی دستگاه عمومی ذخیره نکنید.</p>
      </details>
      ${configured() ? `
      <label class="hint"><input type="checkbox" id="mt5Auto" ${M.cfg.autoSend ? "checked" : ""}> ارسال خودکار «سیگنال‌های معتبر» به MT5 بعد از هر تحلیل</label>
      ${M.err ? `<div class="warn">خطا: ${esc(M.err)}</div>` : ""}
      ${keyBox}
      <h4>اتصال‌های متاتریدر</h4>
      ${M.accounts.map(accountCard).join("") || `<div class="empty">هنوز اتصالی ساخته نشده.</div>`}
      <div class="row"><input id="mt5NewName" placeholder="نام اتصال (مثلاً دمو آلپاری)" maxlength="60"><button class="btn primary" data-act="create">ساخت اتصال جدید</button></div>
      <h4>سیگنال‌های ارسالی و نتیجه‌ی سفارش‌ها <button class="btn ghost" data-act="refresh">↻</button></h4>
      ${execTable()}` : ""}`;
  }

  async function act(el) {
    const a = el.dataset.act, id = el.dataset.id;
    try {
      if (a === "savecfg") {
        const n = normalizeBase($("#mt5Url").value);
        if (n.error) { toast(esc(n.error), "err"); return; }
        M.cfg = { ...M.cfg, url: n.base, key: $("#mt5Key").value.trim() }; save("fa_mt5", M.cfg);
        const me = await api()("GET", "/api/v1/me");
        toast(`اتصال برقرار شد (کاربر: ${esc(me.user.name)}).`, "info"); paintBar(); return refresh();
      }
      if (a === "clearcfg") { M.cfg = { url: "", key: "", autoSend: false }; save("fa_mt5", M.cfg); M.accounts = []; M.executions = []; paintBar(); return render(); }
      if (a === "copykey") { try { await navigator.clipboard.writeText(M.newKey); toast("کپی شد.", "info"); } catch (e) { toast("کپی خودکار ممکن نشد؛ دستی کپی کنید.", "err"); } return; }
      if (a === "hidekey") { M.newKey = null; return render(); }
      if (a === "refresh") return refresh();
      const c = api();
      if (a === "create") {
        const name = ($("#mt5NewName").value || "").trim() || "MT5";
        const r = await c("POST", "/api/v1/accounts", { name, mode: "notify" });
        M.newKey = r.terminal_key; toast("اتصال ساخته شد؛ حالت پیش‌فرض «فقط نمایش» است.", "info");
      } else if (a === "rotate") {
        if (!confirm("کلید فعلی اکسپرت بلافاصله باطل می‌شود. ادامه؟")) return;
        M.newKey = (await c("POST", `/api/v1/accounts/${id}/rotate-key`)).terminal_key;
      } else if (a === "unbind") {
        if (!confirm("حساب MT5 از این اتصال جدا و «معامله‌ی واقعی» خاموش می‌شود. ادامه؟")) return;
        await c("POST", `/api/v1/accounts/${id}/reset-binding`);
      } else if (a === "live-on") {
        const acc = M.accounts.find((x) => x.id === id);
        if (!acc.terminal.login) { toast("اول اکسپرت را یک‌بار به این اتصال وصل کنید.", "err"); return; }
        const phrase = `ENABLE LIVE ${acc.terminal.login}`;
        const typed = prompt(`هشدار: با این کار، سیگنال‌ها روی حساب واقعی با پول واقعی اجرا می‌شوند و ممکن است ضرر کنید.\nهیچ سیستمی سود را تضمین نمی‌کند.\nدر اکسپرت هم باید AllowRealAccount=true باشد.\n\nبرای تأیید دقیقاً بنویسید:\n${phrase}`);
        if (typed === null) return;
        await c("POST", `/api/v1/accounts/${id}/live`, { enable: true, confirm: typed.trim() });
        toast("معامله‌ی واقعی برای این اتصال فعال شد.", "info");
      } else if (a === "live-off") {
        await c("POST", `/api/v1/accounts/${id}/live`, { enable: false });
      } else if (a === "approve") {
        await c("POST", `/api/v1/executions/${id}/approve`);
      } else if (a === "reject") {
        await c("POST", `/api/v1/executions/${id}/reject`, { reason: "" });
      } else if (a === "save") {
        const card = el.closest(".mt5set"), body = {};
        for (const inp of card.querySelectorAll("[data-k]")) {
          const k = inp.dataset.k, v = inp.value.trim();
          if (k === "symbol_map") { try { body[k] = v ? JSON.parse(v) : {}; } catch (e) { toast("نگاشت نماد باید JSON معتبر باشد.", "err"); return; } }
          else if (k === "symbol_suffix") body[k] = v;
          else if (k === "fixed_lot") body[k] = v === "" ? 0 : +v;
          else if (v !== "") body[k] = +v;
        }
        await c("PATCH", `/api/v1/accounts/${id}`, body);
        toast("تنظیمات ذخیره شد.", "info");
      }
      await refresh();
    } catch (e) { toast(esc(e.message), "err"); }
  }

  async function change(el) {
    const a = el.dataset.act, id = el.dataset.id;
    try {
      if (el.id === "mt5Auto") { M.cfg.autoSend = el.checked; save("fa_mt5", M.cfg); paintBar(); return; }
      if (a === "mode") {
        if (el.value !== "notify" && !confirm(el.value === "auto"
          ? "در حالت «اجرای خودکار» اکسپرت بدون پرسیدن سفارش ثبت می‌کند (روی حساب واقعی فقط اگر معامله‌ی واقعی را جداگانه فعال کرده باشید). ادامه؟"
          : "در این حالت هر سیگنال بعد از تأیید شما در همین صفحه اجرا می‌شود. ادامه؟")) { render(); return; }
        await api()("PATCH", `/api/v1/accounts/${id}`, { mode: el.value });
      } else if (a === "enabled") {
        await api()("PATCH", `/api/v1/accounts/${id}`, { enabled: el.checked });
      } else return;
      await refresh();
    } catch (e) { toast(esc(e.message), "err"); render(); }
  }

  function boot() {
    const pane = $("#r-mt5"); if (!pane) return;
    pane.addEventListener("click", (e) => { const b = e.target.closest("button[data-act]"); if (b) act(b); });
    pane.addEventListener("change", (e) => { const t = e.target; if (t.matches("select[data-act], input[type=checkbox]")) change(t); });
    const tabs = $("#rightTabs");
    if (tabs) tabs.addEventListener("click", (e) => { const b = e.target.closest("[data-rt]"); if (b && b.dataset.rt === "mt5") setTimeout(() => { render(); refresh(); }, 0); });
    g.addEventListener("fa:analysis", onAnalysis);
    M.timer = setInterval(() => { if (!document.hidden) refresh(); }, 10000);
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})(typeof window !== "undefined" ? window : globalThis);
