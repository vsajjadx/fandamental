/* Fandamental — UI controller. */
(function () {
  "use strict";
  const FA = window.FA, D = FA.data, ok = FA.ind.ok;
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  // every handler is bound through this guard: a single missing node must never abort boot()
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const fmt = (x, ref) => FA.signal.fmt(x, ref);
  const VD = { buy: "خرید", sell: "فروش", neutral: "خنثی" };
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

  const S = {
    sym: D.SYMBOLS.find((s) => s.id === load("fa_sym", "BTCUSDT")) || D.SYMBOLS[0],
    tf: D.TIMEFRAMES.find((t) => t.id === load("fa_tf", "1h")) || D.TIMEFRAMES[2],
    keys: Object.assign({ provider: "gemini", models: {} }, load("fa_keys", {})), thr: load("fa_thr", 70),
    candles: [], res: null, fund: null, source: "", note: "",
    ov: load("fa_ov", { ema: true, bb: false, vwap: false, st: false, levels: true, plan: true }),
    journal: load("fa_journal", []), chat: [], img: null, busy: false, timer: null,
    dirty: { tv: true, overview: true, news: true }, centerTab: "analytic", rightTab: "signal", charts: null, calc: load("fa_calc", { bal: 1000, risk: 1 }),
    alarms: load("fa_alarms", []), lastSig: load("fa_lastSig", null), notifyOn: load("fa_notify", false),
    scan: null, ranked: null, scanning: false, newsCache: {}, autoFundBusy: false, newsLoaded: false, spot: null, tse: [],
  };
  const TSE_GROUP = "بورس تهران";

  /* ---------------- helpers ---------------- */
  function md(t) {
    return esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/^\s*[-*] /gm, "• ").replace(/\n/g, "<br>");
  }
  function status(html, err) { const el = $("#status"); el.className = "status" + (err ? " err" : ""); el.innerHTML = html; }
  function embed(el, name, cfg) {
    el.innerHTML = "";
    const w = document.createElement("div"); w.className = "tradingview-widget-container"; w.style.cssText = "height:100%;width:100%";
    const inner = document.createElement("div"); inner.className = "tradingview-widget-container__widget"; inner.style.cssText = "height:100%;width:100%";
    const sc = document.createElement("script"); sc.async = true; sc.src = `https://s3.tradingview.com/external-embedding/embed-widget-${name}.js`; sc.text = JSON.stringify(cfg);
    w.append(inner, sc); el.append(w);
  }
  const fmtTime = (t) => new Date(t * 1000).toLocaleString("fa-IR", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const fR = (x, d) => (ok(x) && isFinite(x) ? x.toFixed(d == null ? 2 : d) : "—");

  window.addEventListener("error", (e) => { try { toast("خطای داخلی: " + e.message, "err"); } catch (x) { /* ignore */ } });

  /* ---------------- alarms (in-app + browser notification + sound) ---------------- */
  let audioCtx = null;
  function beep(n) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      for (let k = 0; k < (n || 2); k++) {
        const o = audioCtx.createOscillator(), gn = audioCtx.createGain(), t0 = audioCtx.currentTime + k * 0.28;
        o.type = "sine"; o.frequency.value = k % 2 ? 660 : 880;
        gn.gain.setValueAtTime(0.0001, t0); gn.gain.exponentialRampToValueAtTime(0.25, t0 + 0.03); gn.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
        o.connect(gn); gn.connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.26);
      }
    } catch (e) { /* autoplay blocked until user interacts */ }
  }
  function toast(msg, kind) {
    const wrap = $("#toasts"); if (!wrap) return alert(msg);
    const d = document.createElement("div"); d.className = "toast " + (kind || "info"); d.innerHTML = msg;
    d.onclick = () => d.remove(); wrap.append(d);
    setTimeout(() => d.remove(), 10000);
  }
  function notify(title, body) {
    toast(`<b>${esc(title)}</b><br>${body}`, "alarm");
    if (S.notifyOn && "Notification" in window && Notification.permission === "granted") { try { new Notification(title, { body: String(body).replace(/<[^>]+>/g, "") }); } catch (e) { /* ignore */ } }
    beep(2);
  }
  function pushAlarm(kind, text) {
    S.alarms.unshift({ kind, text, t: Date.now() });
    S.alarms = S.alarms.slice(0, 50); save("fa_alarms", S.alarms);
    renderAlarms();
  }
  function renderAlarms() {
    const el = $("#alarmList"); if (!el) return;
    const ic = { sig: "🎯", early: "⚡", wrong: "🚫", news: "📰", info: "ℹ️" };
    el.innerHTML = S.alarms.length ? S.alarms.map((a) => `<div class="alarm a-${esc(a.kind)}"><span>${ic[a.kind] || "•"}</span><div>${esc(a.text)}<small>${new Date(a.t).toLocaleString("fa-IR", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</small></div></div>`).join("")
      : '<div class="empty">آلارمی ثبت نشده. با هر «تحلیل کن» یا خبر مهم، آلارم اینجا می‌آید.</div>';
  }
  function checkAlarms(r) {
    if (!r || r.error) return;
    const name = S.sym.name;
    if (r.tradeable && r.signalType === "early") {
      pushAlarm("early", `${name} · ${S.tf.label} — سیگنال زودهنگام ${r.direction === "long" ? "خرید" : "فروش"}: ${r.timing || ""} (ورود ${fmt(r.plan.entry, r.price)})`);
      notify(`⚡ سیگنال زودهنگام ${name}`, `${r.direction === "long" ? "خرید" : "فروش"} · ${r.timing || ""}`);
    } else if (r.tradeable && r.signalType === "entry") {
      pushAlarm("sig", `${name} · ${S.tf.label} — سیگنال معتبر ${r.direction === "long" ? "خرید" : "فروش"} · هم‌سویی ${r.confluence} (ورود ${fmt(r.plan.entry, r.price)})`);
      notify(`🎯 سیگنال ${name}`, `${r.direction === "long" ? "خرید" : "فروش"} · هم‌سویی ${r.confluence}`);
    }
    // wrong-signal detection: rapid direction churn + AI-disagreement
    const now = Date.now();
    if (S.lastSig && r.direction !== "none" && S.lastSig.dir !== r.direction && now - S.lastSig.t < 6 * 3600e3) {
      const prev = S.lastSig.dir === "long" ? "خرید" : "فروش";
      pushAlarm("wrong", `${name} — احتمال سیگنال اشتباه: ${prev === "خرید" ? "قبلاً خرید" : "قبلاً فروش"} صادر شده بود و جهت الان برعکس شده. صبر برای تثبیت.`);
      notify(`🚫 هشدار سیگنال ${name}`, `چرخش جهت از ${prev} — ریسک سیگنال اشتباه`);
    }
    if (r.fund && r.direction !== "none" && ok(r.fund.score) && Math.sign(r.fund.score) !== 0 && sgn(r.fund.score) !== (r.direction === "long" ? 1 : -1) && r.fund.confidence >= 40) {
      pushAlarm("wrong", `${name} — تحلیل AI: فاندامنتال (${r.fund.bias === "bullish" ? "صعودی" : r.fund.bias === "bearish" ? "نزولی" : "خنثی"}) مخالف سیگنال تکنیکال است؛ احتمال سیگنال اشتباه بالاست.`);
      notify(`🚫 ${name} — تضاد AI و تکنیکال`, "جهت فاندامنتال مخالف سیگنال است");
    }
    if (r.tradeable) S.lastSig = { dir: r.direction, t: now, sym: S.sym.id }; save("fa_lastSig", S.lastSig);
  }

  /* ---------------- boot ---------------- */
  function init() {
    const groups = [...new Set(D.SYMBOLS.map((s) => s.group))];
    // NOTE: #watchList is a separate node from the TSE search boxes, so re-rendering the
    // list can never delete the inputs (this used to throw and kill the whole boot()).
    const renderWatch = () => {
      const box = $("#watchList"); if (!box) return;
      box.innerHTML = groups.filter((g) => D.SYMBOLS.some((s) => s.group === g)).map((g) => {
        const rows = D.SYMBOLS.filter((s) => s.group === g);
        const hint = g === TSE_GROUP ? '<div class="whint">هر سهم بورس تهران را از کادر بالا جستجو کنید (شپنا، خودرو، فولاد…) یا کد نماد را بچسبانید.</div>' : "";
        return `<h5>${esc(g)} <em>${rows.length}</em></h5>` + hint + rows.map((s) => `<button data-sym="${esc(s.id)}" class="${s.id === S.sym.id ? "on" : ""}">${esc(s.name)}<span>${esc(s.short || s.id)}</span></button>`).join("");
      }).join("");
    };
    renderSymbolOptions();
    renderWatch();
    $("#tfs").innerHTML = D.TIMEFRAMES.map((t) => `<button data-tf="${t.id}" class="${t.id === S.tf.id ? "on" : ""}">${t.label}</button>`).join("");
    $$("[data-ov]").forEach((c) => (c.checked = !!S.ov[c.dataset.ov]));

    $("#symbol").onchange = (e) => setSymbol(e.target.value);
    $("#watch").onclick = (e) => { const b = e.target.closest("[data-sym]"); if (b) setSymbol(b.dataset.sym); };
    $("#tfs").onclick = (e) => { const b = e.target.closest("[data-tf]"); if (b) setTf(b.dataset.tf); };
    $("#btnRun").onclick = () => run();
    $("#centerTabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) showCenter(b.dataset.tab); };
    $("#rightTabs").onclick = (e) => { const b = e.target.closest("[data-rt]"); if (b) showRight(b.dataset.rt); };
    $$("[data-ov]").forEach((c) => (c.onchange = () => { S.ov[c.dataset.ov] = c.checked; save("fa_ov", S.ov); renderChart(); }));
    $("#autoRefresh").onchange = (e) => { clearInterval(S.timer); if (e.target.checked) S.timer = setInterval(() => { if (!document.hidden) run(); }, 60000); };

    $("#btnSettings").onclick = openSettings;
    $("#btnCsv").onclick = () => $("#csvFile").click();
    $("#csvFile").onchange = importCsv;
    $("#btnFund").onclick = () => runFund();
    $("#btnBt").onclick = runBt;
    $("#btEarly").onchange = () => { /* takes effect on next run */ };
    $("#btnSend").onclick = () => { const t = $("#chatText").value.trim(); if (t || S.img) { $("#chatText").value = ""; send(t || "این چارت را تحلیل کن."); } };
    $("#chatText").onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#btnSend").click(); };
    $("#btnAttach").onclick = () => $("#imgFile").click();
    $("#imgFile").onchange = attachImage;
    $("#btnReview").onclick = reviewJournal;
    $("#jForm").onsubmit = addJournal;
    $("#jFill").onclick = fillJournal;
    $("#jExport").onclick = exportJournal;
    $("#jList").onclick = (e) => { const b = e.target.closest("[data-del]"); if (b) { S.journal = S.journal.filter((x) => x.id !== +b.dataset.del); save("fa_journal", S.journal); renderJournal(); } };
    $("#btnScan").onclick = scanMarkets;
    $("#btnRankAI").onclick = rankWithAI;
    $("#btnNotify").onclick = async () => {
      if (!("Notification" in window)) { toast("مرورگر شما پشتیبانی نمی‌کند.", "err"); return; }
      const p = await Notification.requestPermission();
      S.notifyOn = p === "granted"; save("fa_notify", S.notifyOn);
      $("#btnNotify").textContent = S.notifyOn ? "🔔 آلارم روشن" : "🔕 آلارم خاموش";
      if (S.notifyOn) toast("آلارم مرورگر فعال شد.", "info");
    };
    $("#btnAlarmClear").onclick = () => { S.alarms = []; save("fa_alarms", S.alarms); renderAlarms(); };
    on("#btnTseSearch", "click", () => tseSearchFlow($("#tseQuery").value.trim()));
    on("#tseQuery", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tseSearchFlow($("#tseQuery").value.trim()); } });
    on("#btnTseAdd", "click", () => tseAddByCode($("#tseCode").value.trim()));
    on("#tseCode", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tseAddByCode($("#tseCode").value.trim()); } });
    on("#btnRefreshNews", "click", () => loadNews(true));
    if ($("#btnNotify")) $("#btnNotify").textContent = S.notifyOn ? "🔔 آلارم روشن" : "🔕 آلارم خاموش";

    embed($("#tape"), "ticker-tape", {
      symbols: [["Gold", "OANDA:XAUUSD"], ["Silver", "OANDA:XAGUSD"], ["EURUSD", "OANDA:EURUSD"], ["GBPUSD", "OANDA:GBPUSD"], ["USDJPY", "OANDA:USDJPY"], ["DXY", "TVC:DXY"], ["BTC", "BINANCE:BTCUSDT"], ["ETH", "BINANCE:ETHUSDT"], ["S&P500", "FOREXCOM:SPXUSD"], ["Oil", "TVC:USOIL"]].map(([title, proName]) => ({ title, proName })),
      showSymbolLogo: true, colorTheme: "dark", isTransparent: true, displayMode: "adaptive", locale: "en",
    });
    if ($("#chartMain") && window.ResizeObserver) new ResizeObserver(() => resizeCharts()).observe($("#chartMain").parentElement);
    renderJournal(); renderAlarms(); updateFundHint();
    loadNews();
    run();
  }

  function renderSymbolOptions() {
    const groups = [...new Set(D.SYMBOLS.map((s) => s.group))];
    const sel = $("#symbol"); if (!sel) return;
    sel.innerHTML = groups.map((g) => `<optgroup label="${esc(g)}">` + D.SYMBOLS.filter((s) => s.group === g).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("") + "</optgroup>").join("");
    sel.value = S.sym.id;
  }

  function setTf(id) {
    S.tf = D.TIMEFRAMES.find((t) => t.id === id) || S.tf; save("fa_tf", S.tf.id);
    paintTf(); S.dirty.tv = true;
    if (S.centerTab === "tv") renderTV(); run();
  }
  function paintTf() { $$("#tfs [data-tf]").forEach((b) => b.classList.toggle("on", b.dataset.tf === S.tf.id)); }

  function setSymbol(id) {
    S.sym = D.SYMBOLS.find((s) => s.id === id) || S.sym; save("fa_sym", S.sym.id);
    $("#symbol").value = S.sym.id; $$("#watch [data-sym]").forEach((b) => b.classList.toggle("on", b.dataset.sym === S.sym.id));
    S.fund = null; $("#fundBox").className = "empty"; $("#fundBox").textContent = "تحلیل خبری برای این نماد اجرا نشده."; S.dirty.tv = S.dirty.news = true;
    if (S.centerTab === "tv") renderTV(); if (S.rightTab === "fund") renderNews();
    loadNews();
    run();
  }
  function showCenter(tab) {
    S.centerTab = tab;
    $$("#centerTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    $$(".center > .pane").forEach((p) => p.classList.toggle("on", p.id === "pane-" + tab));
    if (tab === "tv" && S.dirty.tv) renderTV();
    if (tab === "overview" && S.dirty.overview) renderOverview();
    if (tab === "analytic") setTimeout(resizeCharts, 30);
  }
  function showRight(tab) {
    S.rightTab = tab;
    $$("#rightTabs button").forEach((b) => b.classList.toggle("on", b.dataset.rt === tab));
    $$(".rpane").forEach((p) => p.classList.toggle("on", p.id === "r-" + tab));
    if (tab === "fund") { renderNews(); if (!S.newsLoaded) loadNews(); }
    if (tab === "best") renderScan();
  }

  /* ---------------- TSETMC stock search (all Tehran symbols) ---------------- */
  function addTseSymbol(rec) {
    const id = "TSE-" + (rec.ticker || rec.name || rec.insCode);
    let sym = D.SYMBOLS.find((s) => s.id === id);
    if (!sym) {
      sym = { id, name: rec.name || rec.ticker || rec.insCode, short: rec.ticker || rec.insCode, group: TSE_GROUP, tv: "", tse: String(rec.insCode), td: "", yh: "" };
      D.SYMBOLS.push(sym);
      renderSymbolOptions(); watchRender();
    }
    return sym.id;
  }
  const watchRender = () => { const box = $("#watchList"); if (!box) return; const sel = $("#symbol"); renderSymbolOptions(); if (sel) sel.value = S.sym.id; box.querySelectorAll("[data-sym]").forEach((b) => b.classList.toggle("on", b.dataset.sym === S.sym.id)); };
  async function tseSearchFlow(q) {
    if (!q) { toast("نام یا نماد سهام را بنویسید (مثلاً فولاد یا شپنا).", "info"); return; }
    const btn = $("#btnTseSearch"); if (btn) btn.disabled = true;
    try {
      const rows = await D.tseSearch(q);
      if (!rows.length) {
        if (/^\d{6,}$/.test(q)) { addTseSymbol({ insCode: q, name: "سهم " + q, ticker: q }); toast("نمادی با این کد نماد اضافه شد؛ اگر داده نیامد کد درست نیست.", "info"); setSymbol("TSE-" + q); return; }
        toast("نمادی پیدا نشد.", "err"); return;
      }
      const r = rows[0];
      const id = addTseSymbol(r);
      setSymbol(id);
      toast(`نماد «${esc(r.name || r.ticker)}» اضافه و بارگذاری شد.`, "info");
    } catch (e) { toast(esc(e.message), "err"); }
    finally { if (btn) btn.disabled = false; }
  }
  async function tseAddByCode(code) {
    if (!code) { toast("کد نماد (insCode) را بچسبانید.", "info"); return; }
    const c = code.replace(/[^\d]/g, "");
    if (!c) { toast("کد نماد باید عددی باشد.", "err"); return; }
    const id = addTseSymbol({ insCode: c, name: "سهم " + c, ticker: c });
    setSymbol(id);
  }

  /* ---------------- TradingView widgets ---------------- */
  function renderTV() {
    S.dirty.tv = false;
    embed($("#tvChart"), "advanced-chart", {
      autosize: true, symbol: S.sym.tv || (S.sym.tse ? (S.sym.id.replace("TSE-", "")) : "BINANCE:BTCUSDT"), interval: S.tf.tv, timezone: "Etc/UTC", theme: "dark", style: "1", locale: "en",
      enable_publishing: false, allow_symbol_change: true, withdateranges: true, save_image: true, studies: ["RSI@tv-basicstudies", "MACD@tv-basicstudies"],
      support_host: "https://www.tradingview.com",
    });
    renderTvPlan();
  }
  function renderTvPlan() {
    const el = $("#tvPlan"), r = S.res;
    if (!el) return;
    if (S.sym.tse && !S.sym.tv) { el.innerHTML = '<span class="hint">TradingView بورس تهران را پوشش نمی‌دهد؛ سطوح ورود/تارگت روی «چارت تحلیلی» رسم شده‌اند.</span>'; return; }
    if (!r || r.error || !r.plan) { el.innerHTML = ""; return; }
    const p = r.plan, f = (x) => fmt(x, r.price);
    el.innerHTML = `<span class="lv side">${p.side === "long" ? "خرید" : "فروش"}</span><span class="lv en">ورود ${f(p.entry)}</span><span class="lv sl">حد ضرر ${f(p.sl)}</span>` +
      p.tps.map((t, i) => `<span class="lv tp">تارگت ${i + 1}: ${f(t)} (${fR(p.rr[i])}R)</span>`).join("") +
      '<span class="hint">این سطوح روی «چارت تحلیلی» با خطوط رنگی رسم شده‌اند.</span>';
  }
  function renderOverview() {
    S.dirty.overview = false;
    const pick = (g) => D.SYMBOLS.filter((s) => s.group === g && s.tv).map((s) => ({ s: s.tv, d: s.name.replace(/[^\x00-\x7F]+/g, "").trim() || s.id }));
    embed($("#tvOverview"), "market-overview", {
      colorTheme: "dark", dateRange: "1D", showChart: true, locale: "en", isTransparent: true, showSymbolLogo: true, showFloatingTooltip: false, width: "100%", height: "100%",
      tabs: [{ title: "Forex", symbols: pick("فارکس") }, { title: "Metals", symbols: pick("فلزات و کالا") }, { title: "Crypto", symbols: pick("کریپتو") }, { title: "Indices", symbols: pick("شاخص‌ها") }],
    });
  }
  function renderNews() {
    S.dirty.news = false;
    const nw = $("#tvNews");
    if (S.sym.tv) { if (nw) embed(nw, "timeline", { feedMode: "symbol", symbol: S.sym.tv, colorTheme: "dark", isTransparent: true, displayMode: "regular", width: "100%", height: 420, locale: "en" }); }
    else if (nw) nw.innerHTML = '<div class="hint">TradingView برای بورس تهران خبر پوشش نمی‌دهد؛ از فهرست بالای همین صفحه استفاده کنید و در صورت نیاز «به‌روزرسانی اخبار» را بزنید.</div>';
    embed($("#tvCal"), "events", { colorTheme: "dark", isTransparent: true, width: "100%", height: 420, locale: "en", importanceFilter: "-1,0,1", currencyFilter: "USD,EUR,GBP,JPY,CHF,AUD,CAD,NZD,CNY" });
    const listEl = $("#newsList");
    if (listEl && /در حال دریافت/.test(listEl.textContent || "")) listEl.textContent = "برای دریافت اخبار، دکمه‌ی «به‌روزرسانی اخبار» را بزنید.";
  }

  /* ---------------- data + analysis ---------------- */
  const dedupe = (c) => { const m = new Map(); c.forEach((x) => m.set(x.t, x)); return [...m.values()].sort((a, b) => a.t - b.t).filter((x) => [x.o, x.h, x.l, x.c].every(ok)); };

  async function run(opt) {
    if (S.busy) return;
    S.busy = true; const btn = $("#btnRun"); if (btn) btn.disabled = true;
    try {
      if (!(opt && opt.keepCandles)) {
        // free daily sources cannot serve 5m/15m/1h — switch to 1D instead of returning wrong data
        const fit = D.resolveTimeframe(S.sym, S.tf, S.keys);
        if (fit.changed) { S.tf = fit.tf; save("fa_tf", S.tf.id); paintTf(); }
        status(`در حال دریافت داده‌ی <b>${esc(S.sym.name)}</b>…`);
        const r = await D.fetchCandles(S.sym, S.tf, S.keys, 1000);
        S.candles = dedupe(r.candles); S.source = r.source; S.note = (fit.changed ? fit.reason + " · " : "") + (r.note || "");
      }
      if (!S.candles.length) throw new Error("کندلی دریافت نشد؛ منبع داده برای این نماد پاسخ نداد.");
      reanalyze();
      S.spot = null; paintStatus();
      if (S.sym.spot) D.spotPrice(S.sym).then((sp) => { if (sp) { S.spot = sp; paintStatus(); } }).catch(() => {});
      checkAlarms(S.res);
      autoFund();
    } catch (e) { status("خطا: " + esc(e.message), true); }
    finally { S.busy = false; const b = $("#btnRun"); if (b) b.disabled = false; }
  }
  function paintStatus() {
    const last = S.candles[S.candles.length - 1]; if (!last) return;
    const sp = S.spot && isFinite(S.spot.price) ? ` · قیمت لحظه‌ای ${esc(S.sym.spot)}: <b>${S.spot.price}</b> (${esc(S.spot.src)})` : "";
    status(`<b>${esc(S.sym.name)}</b> · ${S.tf.label} · منبع: ${esc(S.source)} · ${S.candles.length} کندل · آخرین کندل: ${fmtTime(last.t)}${sp}${S.note ? " · " + esc(S.note) : ""}`);
  }
  function reanalyze() {
    S.res = FA.signal.analyze(S.candles, { fund: S.fund, threshold: S.thr, early: true });
    renderChart(); renderSignal(); renderInd(); renderTvPlan();
  }

  /* ---------------- chart ---------------- */
  function destroyCharts() { if (S.charts) { Object.values(S.charts).forEach((c) => { try { c.remove(); } catch (e) { /* ignore */ } }); S.charts = null; } }
  function resizeCharts() { if (!S.charts) return; [["main", "#chartMain"], ["rsi", "#chartRsi"], ["macd", "#chartMacd"]].forEach(([k, sel]) => { const w = $(sel).clientWidth; if (w > 0) S.charts[k].applyOptions({ width: w }); }); }

  function renderChart() {
    const r = S.res; if (!r || r.error || !window.LightweightCharts) { if (!window.LightweightCharts) status("کتابخانه‌ی چارت بارگذاری نشد (اینترنت/CDN).", true); return; }
    destroyCharts();
    const LW = window.LightweightCharts, d = FA.signal.digitsFor(r.price);
    const base = (sel, h, tv) => LW.createChart($(sel), {
      width: Math.max(300, $(sel).clientWidth), height: h,
      layout: { background: { type: "solid", color: "transparent" }, textColor: "#8b95a7", fontFamily: "JetBrains Mono, monospace", fontSize: 11 },
      grid: { vertLines: { color: "rgba(255,255,255,.035)" }, horzLines: { color: "rgba(255,255,255,.035)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,.08)" }, timeScale: { borderColor: "rgba(255,255,255,.08)", timeVisible: true, secondsVisible: false, visible: tv },
      crosshair: { mode: 0 },
    });
    const main = base("#chartMain", 440, true), rsi = base("#chartRsi", 110, false), macd = base("#chartMacd", 120, true);
    S.charts = { main, rsi, macd };
    const cs = main.addCandlestickSeries({ upColor: "#2ebd85", downColor: "#f6465d", borderVisible: false, wickUpColor: "#2ebd85", wickDownColor: "#f6465d", priceFormat: { type: "price", precision: d, minMove: Math.pow(10, -d) } });
    cs.setData(S.candles.map((x) => ({ time: x.t, open: x.o, high: x.h, low: x.l, close: x.c })));
    const sr = r.series, T = sr.t;
    const line = (chart, arr, color, w, style) => {
      const s = chart.addLineSeries({ color, lineWidth: w || 1, lineStyle: style || 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(arr.map((v, i) => (ok(v) ? { time: T[i], value: v } : null)).filter(Boolean)); return s;
    };
    if (S.ov.ema) { line(main, sr.ema20, "#f5a623"); line(main, sr.ema50, "#4aa3ff"); line(main, sr.ema200, "#b388ff", 2); }
    if (S.ov.bb) { line(main, sr.bb.upper, "#6b7a90", 1, 2); line(main, sr.bb.lower, "#6b7a90", 1, 2); line(main, sr.bb.mid, "#44506a", 1, 1); }
    if (S.ov.vwap && sr.hasVol) line(main, sr.vwap, "#ffd166", 1);
    if (S.ov.st) {
      const s = main.addLineSeries({ lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(sr.st.line.map((v, i) => (ok(v) ? { time: T[i], value: v, color: sr.st.dir[i] === 1 ? "#2ebd85" : "#f6465d" } : null)).filter(Boolean));
    }
    const pl = (price, color, title, style) => cs.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    if (S.ov.levels) {
      r.pa_data.sups.slice(0, 3).forEach((l) => pl(l.price, "rgba(46,189,133,.65)", "S×" + l.touches, 2));
      r.pa_data.ress.slice(0, 3).forEach((l) => pl(l.price, "rgba(246,70,93,.65)", "R×" + l.touches, 2));
    }
    if (S.ov.plan && r.plan) {
      const p = r.plan;
      pl(p.entry, "#4aa3ff", p.isLimit ? "ENTRY (limit)" : "ENTRY", 0); pl(p.sl, "#f6465d", "SL", 0);
      p.tps.forEach((t, i) => pl(t, "#2ebd85", `TP${i + 1} (${fR(p.rr[i], 1)}R)`, 0));
    }
    const seenT = new Set();
    const mk = r.pa_data.patterns.filter((p) => p.dir !== 0 && p.i >= S.candles.length - 3 && !seenT.has(T[p.i]) && seenT.add(T[p.i])).map((p) => ({ time: T[p.i], position: p.dir === 1 ? "belowBar" : "aboveBar", color: p.dir === 1 ? "#2ebd85" : "#f6465d", shape: p.dir === 1 ? "arrowUp" : "arrowDown", text: p.name }));
    mk.sort((a, b) => a.time - b.time); if (mk.length) cs.setMarkers(mk);

    const rl = line(rsi, sr.rsi, "#b388ff", 2);
    [30, 70].forEach((v) => rl.createPriceLine({ price: v, color: "rgba(255,255,255,.25)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "" }));
    const hs = macd.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    hs.setData(sr.macd.hist.map((v, i) => (ok(v) ? { time: T[i], value: v, color: v >= 0 ? "rgba(46,189,133,.6)" : "rgba(246,70,93,.6)" } : null)).filter(Boolean));
    line(macd, sr.macd.line, "#4aa3ff", 1); line(macd, sr.macd.signal, "#f5a623", 1);

    let lock = false;
    const sync = (src, others) => src.timeScale().subscribeVisibleLogicalRangeChange((rg) => { if (lock || !rg) return; lock = true; others.forEach((o) => o.timeScale().setVisibleLogicalRange(rg)); lock = false; });
    sync(main, [rsi, macd]); sync(rsi, [main, macd]); sync(macd, [main, rsi]);
    const n = S.candles.length; main.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 130), to: n + 6 });
  }

  /* ---------------- signal panel ---------------- */
  function renderSignal() {
    const box = $("#signalBox"), r = S.res;
    if (!r) return;
    if (r.error) { box.className = "empty"; box.textContent = r.error; return; }
    box.className = "";
    const dirTxt = { long: "خرید (Long)", short: "فروش (Short)", none: "بدون جهت مشخص" }[r.direction];
    const col = r.direction === "long" ? "#2ebd85" : r.direction === "short" ? "#f6465d" : "#8b95a7", C = 2 * Math.PI * 40;
    const timingBadge = r.signalType === "early"
      ? `<span class="badge early">⚡ سیگنال زودهنگام — قبل از تکمیل حرکت روند</span>`
      : r.tradeable ? `<span class="badge ok">سیگنال معتبر (هم‌سویی ≥ ${r.threshold})</span>` : r.direction === "none" ? `<span class="badge wait">فعلاً وارد نشو</span>` : `<span class="badge wait">هم‌سویی کافی نیست؛ صبر کن</span>`;
    const all = r.items.concat(r.paItems), ds = r.direction === "short" ? -1 : 1, rank = (a, b) => b.w * Math.abs(b.score) - a.w * Math.abs(a.score);
    const sup = r.direction === "none" ? [] : all.filter((x) => Math.sign(x.score) === ds && Math.abs(x.score) >= 0.25).sort(rank).slice(0, 6);
    const opp = r.direction === "none" ? [] : all.filter((x) => Math.sign(x.score) === -ds && Math.abs(x.score) >= 0.25).sort(rank).slice(0, 3);
    const li = (x) => `<li><b>${esc(x.name)}</b>: ${esc(x.value)} → ${VD[x.verdict]}</li>`;
    let plan = "";
    if (r.plan) {
      const p = r.plan, f = (x) => fmt(x, r.price);
      plan = `<table class="plan">
        <tr><td>ورود ${p.isLimit ? "(سفارش لیمیت روی پولبک)" : "(قیمت بازار)"}</td><td class="ac">${f(p.entry)}</td></tr>
        <tr><td>ناحیه‌ی ورود</td><td>${f(p.entryZone[0])} – ${f(p.entryZone[1])}</td></tr>
        <tr><td>حد ضرر</td><td class="dn">${f(p.sl)}</td></tr>
        ${p.tps.map((t, i) => `<tr><td>تارگت ${i + 1}<span class="tag">${fR(p.rr[i])}R</span></td><td class="up">${f(t)}</td></tr>`).join("")}
        <tr><td>ریسک هر واحد (≈ATR)</td><td>${f(p.risk)}</td></tr></table>
        <div class="calc">محاسبه‌ی حجم:
          <div class="row"><input id="cBal" type="number" value="${S.calc.bal}" min="0"> موجودی &nbsp; <input id="cRisk" type="number" value="${S.calc.risk}" step="0.25" min="0.1"> % ریسک</div>
          <div id="cOut" class="hint"></div></div>`;
    }
    box.innerHTML = `
      <div class="sig-head">
        <div class="ring"><svg width="92" height="92" viewBox="0 0 92 92"><circle cx="46" cy="46" r="40" fill="none" stroke="#222a3b" stroke-width="8"/><circle cx="46" cy="46" r="40" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - r.confluence / 100)}"/></svg><b style="color:${col}">${r.confluence}</b></div>
        <div><span class="pill ${r.direction}">${dirTxt}</span><br>${timingBadge}
          <div class="hint">امتیاز هم‌سویی سیگنال‌ها (نه احتمال سود) · ${r.buys} خرید / ${r.sells} فروش از ${all.length} مورد</div></div>
      </div>
      ${r.signalType === "early" && r.timing ? `<div class="note-early">⚡ ${esc(r.timing)}</div>` : ""}
      ${plan}
      ${r.fund ? `<div class="hint" style="margin-top:8px">فاندامنتال AI: <b>${esc({ bullish: "صعودی", bearish: "نزولی", neutral: "خنثی" }[r.fund.bias] || r.fund.bias)}</b> (اطمینان ${Math.round(r.fund.confidence)}%)</div>` : ""}
      ${sup.length ? `<h4>دلایل هم‌جهت</h4><ul class="reasons">${sup.map(li).join("")}</ul>` : ""}
      ${opp.length ? `<h4>نشانه‌های مخالف</h4><ul class="reasons">${opp.map(li).join("")}</ul>` : ""}
      ${r.warnings.length ? `<ul class="warns">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}`;
    const calc = () => {
      if (!r.plan) return; const bal = +$("#cBal").value || 0, rk = +$("#cRisk").value || 0; S.calc = { bal, risk: rk }; save("fa_calc", S.calc);
      const amt = (bal * rk) / 100, units = amt / r.plan.risk;
      $("#cOut").innerHTML = `ریسک: <b>${amt.toFixed(2)}</b> · حجم تقریبی: <b>${units >= 100 ? units.toFixed(0) : units.toFixed(3)}</b> واحد (برای لات فارکس بر اساس اندازه‌ی قرارداد کارگزار تبدیل کنید)`;
    };
    if (r.plan) { $("#cBal").oninput = $("#cRisk").oninput = calc; calc(); }
  }

  /* ---------------- indicators panel ---------------- */
  function renderInd() {
    const box = $("#indBox"), r = S.res; if (!r || r.error) return;
    box.className = "";
    const all = r.items.concat(r.paItems), cnt = (v) => all.filter((x) => x.verdict === v).length, tot = all.length;
    const sect = (title, arr) => (arr.length ? `<tr><td class="grp" colspan="3">${title}</td></tr>` + arr.map((x) => `<tr><td>${esc(x.name)}</td><td class="v">${esc(x.value)}</td><td><span class="vd ${x.verdict}">${VD[x.verdict]}</span></td></tr>`).join("") : "");
    const pa = r.pa_data;
    box.innerHTML = `
      <div class="hint">${cnt("buy")} خرید · ${cnt("neutral")} خنثی · ${cnt("sell")} فروش</div>
      <div class="bar"><i class="b" style="width:${(100 * cnt("buy")) / tot}%"></i><i class="n" style="width:${(100 * cnt("neutral")) / tot}%"></i><i class="s" style="width:${(100 * cnt("sell")) / tot}%"></i></div>
      <table class="itable"><thead><tr><th>اندیکاتور</th><th>مقدار</th><th>نظر</th></tr></thead><tbody>
        ${sect("روند", r.items.filter((x) => x.group === "trend"))}
        ${sect("مومنتوم و نوسان‌نما", r.items.filter((x) => x.group === "osc"))}
        ${sect("حجم", r.items.filter((x) => x.group === "vol"))}
        ${sect("پرایس‌اکشن", r.paItems)}
      </tbody></table>
      <h4>سطوح کلیدی</h4>
      <div class="hint" dir="ltr" style="text-align:left">
        ${pa.ress.slice(0, 3).reverse().map((l) => `R ${fmt(l.price, r.price)} ×${l.touches}`).join("<br>")}<br><b style="color:#e6eaf2">▶ ${fmt(r.price, r.price)}</b><br>
        ${pa.sups.slice(0, 3).map((l) => `S ${fmt(l.price, r.price)} ×${l.touches}`).join("<br>")}
        ${pa.pivots ? `<br><br>Pivot P ${fmt(pa.pivots.P, r.price)} · R1 ${fmt(pa.pivots.R1, r.price)} · S1 ${fmt(pa.pivots.S1, r.price)}` : ""}
        ${pa.fib ? `<br>Fib (${pa.fib.dir}): ` + pa.fib.levels.map((x) => `${x.r} → ${fmt(x.price, r.price)}`).join(" · ") : ""}
      </div>`;
  }

  /* ---------------- AI: fundamentals (auto-runs after every analysis) ---------------- */
  function requireKey() {
    if (!S.keys[S.keys.provider || "gemini"]) { openSettings(); return false; } return true;
  }
  function updateFundHint() {
    const p = FA.ai.PROVIDERS[S.keys.provider || "gemini"];
    $("#fundHint").textContent = p.search ? "جستجوی زنده‌ی وب با کلید شما" : "تیترهای زنده از GDELT + تحلیل مدل " + p.label;
  }
  async function runFund(auto) {
    if (S.autoFundBusy) return;
    if (!requireKey()) return;
    if (!S.res || S.res.error) return;
    const btn = $("#btnFund"), box = $("#fundBox"); btn.disabled = true; S.autoFundBusy = true;
    box.className = "empty"; box.textContent = auto ? "تحلیل فاندامنتال به‌صورت خودکار اجرا می‌شود…" : "در حال جستجوی اخبار و تحلیل…";
    const prog = (m) => { box.className = "empty"; box.textContent = m + " — لطفاً صبر کنید (تا ۲ دقیقه)."; };
    try {
      const r = S.res, tech = `${r.direction}, confluence ${r.confluence}, tech ${r.tech.toFixed(2)}, price action ${r.pa.toFixed(2)}`;
      const f = await FA.ai.fundamental(S.keys, { name: S.sym.name, tv: S.sym.tv, tf: S.tf.label, price: fmt(r.price, r.price), tech, sym: S.sym, today: new Date().toISOString().slice(0, 10) }, prog);
      S.fund = f; renderFund(); reanalyze(); checkAlarms(S.res);
      // خبرهای آینده‌ی مهم -> آلارم
      (f.future_events || []).concat(f.upcoming_events || []).slice(0, 3).forEach((e) => {
        if (e.importance === "high") pushAlarm("news", `${S.sym.name} — رویداد پیش‌رو: ${e.event} (${e.when || "زمان نامشخص"}) — ${e.effect || e.risk || ""}`);
      });
    } catch (e) { if (!auto) { box.className = "empty"; box.innerHTML = `<span class="loss">${esc(e.message)}</span>`; } }
    finally { btn.disabled = false; S.autoFundBusy = false; }
  }
  function autoFund() {
    if (S.fund || S.autoFundBusy) return;
    if (S.keys[S.keys.provider || "gemini"]) runFund(true);
  }
  function renderFund() {
    const f = S.fund, box = $("#fundBox"); if (!f) return; box.className = "";
    const bias = { bullish: "صعودی", bearish: "نزولی", neutral: "خنثی" };
    const dir = (d) => ({ bullish: "▲", bearish: "▼", neutral: "●" }[d] || "●");
    box.innerHTML = `<div class="fbias"><span class="pill ${f.bias === "bullish" ? "long" : f.bias === "bearish" ? "short" : "none"}">${bias[f.bias] || esc(f.bias)}</span><span class="hint">امتیاز ${f.score.toFixed(2)} · اطمینان ${Math.round(f.confidence)}%</span></div>
      <div class="hint">منبع: ${esc(f.sourceNote || "")}</div>
      <p>${esc(f.summary)}</p>
      ${(f.drivers || []).map((d) => `<div class="fcard imp-${esc(d.impact)}"><b>${dir(d.direction)} ${esc(d.headline)}</b>${esc(d.why)}<br><small>${esc(d.source)}</small></div>`).join("")}
      ${(f.future_events || []).length ? "<h4>خبرها و رویدادهایی که در آینده روی این دارایی اثر می‌گذارند</h4>" : ""}
      ${(f.future_events || []).map((e) => `<div class="fcard imp-${esc(e.importance)}"><b>📌 ${esc(e.event)}</b><small>${esc(e.when || "")}</small><br>${esc(e.effect || "")}</div>`).join("")}
      ${(f.upcoming_events || []).length ? "<h4>رویدادهای پیش‌رو</h4>" : ""}
      ${(f.upcoming_events || []).map((e) => `<div class="fcard imp-${esc(e.importance)}"><b>${esc(e.event)}</b><small>${esc(e.when)}</small><br>${esc(e.risk)}</div>`).join("")}
      ${(f.risks || []).length ? `<h4>ریسک‌ها</h4><ul class="warns">${f.risks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}`;
  }

  /* ---------------- free news layer (no AI key needed) ---------------- */
  async function loadNews() {
    const listEl = $("#newsList"), calEl = $("#calList");
    try {
      const [cal, heads] = await Promise.allSettled([FA.news.economicCalendar(), FA.news.assetNews(S.sym)]);
      // calendar filtered for this symbol's currencies
      if (calEl) {
        if (cal.status === "fulfilled") {
          const rel = FA.news.matchCalendar(cal.value, S.sym);
          const upcoming = rel.filter((e) => e.ts > Date.now() / 1000 - 3600).sort((a, b) => a.ts - b.ts).slice(0, 12);
          calEl.className = "";
          calEl.innerHTML = upcoming.length ? upcoming.map((e) => `<div class="fcard imp-${e.impact}"><b>${esc(e.country)}: ${esc(e.title)}</b><small>📅 ${esc(e.date)}</small>${e.forecast ? `<br><small>پیش‌بینی: ${esc(e.forecast)} · قبلی: ${esc(e.previous)}</small>` : ""}</div>`).join("") : '<div class="hint">رویداد پراثری برای ارزهای این نماد در روزهای آینده نیست.</div>';
          upcoming.filter((e) => e.impact === "high" && e.ts > Date.now() / 1000 && e.ts < Date.now() / 1000 + 48 * 3600).forEach((e) => {
            const k = "cal-" + e.country + e.title + e.ts;
            if (!S.newsCache[k]) { S.newsCache[k] = 1; pushAlarm("news", `${S.sym.name} — رویداد پراثر پیش‌رو: ${e.country} ${e.title} (${e.date})`); }
          });
        } else { calEl.className = "empty"; calEl.textContent = "تقویم اقتصادی در دسترس نیست (فیلترینگ/قطع دسترسی)."; }
      }
      if (listEl) {
        if (heads.status === "fulfilled" && heads.value.length) {
          listEl.className = "";
          listEl.innerHTML = heads.value.slice(0, 15).map((h) => `<div class="fcard"><b>${esc(h.title)}</b><small>${esc(h.src)}${h.ts ? " · " + new Date(h.ts * 1000).toLocaleDateString("fa-IR") : ""}</small></div>`).join("");
        } else if (heads.status === "fulfilled") { listEl.className = "empty"; listEl.textContent = "خبر تازه‌ای برای این نماد پیدا نشد."; }
        else { listEl.className = "empty"; listEl.textContent = "دریافت اخبار ممکن نشد (GDELT گاهی محدود می‌شود؛ بعداً دوباره امتحان کنید)."; }
      }
      if (S.rightTab === "fund") renderNews();
    } catch (e) { /* silent */ }
  }

  /* ---------------- AI: chat ---------------- */
  function ctx() {
    const r = S.res || {}, round = (x) => (ok(x) ? +x.toPrecision(7) : null);
    const out = { symbol: S.sym.name, timeframe: S.tf.label, journal: journalStats() };
    if (r && !r.error && r.plan !== undefined) {
      Object.assign(out, {
        price: round(r.price), direction: r.direction, signalType: r.signalType, timing: r.timing, confluence: r.confluence, tradeable: r.tradeable, techScore: round(r.tech), priceActionScore: round(r.pa), warnings: r.warnings,
        plan: r.plan && { side: r.plan.side, entry: round(r.plan.entry), sl: round(r.plan.sl), tps: r.plan.tps.map(round), rr: r.plan.rr.map((x) => +x.toFixed(2)) },
        structure: r.pa_data.st.trend, fundamental: r.fund && { bias: r.fund.bias, confidence: r.fund.confidence, summary: r.fund.summary },
        indicators: r.items.concat(r.paItems).map((x) => `${x.name}: ${x.value} (${x.verdict})`),
      });
    }
    return out;
  }
  function addMsg(cls, html) { const log = $("#chatLog"); if (log.querySelector(".empty")) log.innerHTML = ""; const d = document.createElement("div"); d.className = "msg " + cls; d.innerHTML = html; log.append(d); log.scrollTop = log.scrollHeight; return d; }
  async function send(text) {
    if (!requireKey()) return;
    showRight("chat");
    const img = S.img; S.img = null; $("#attachChip").hidden = true;
    const content = img ? [{ type: "image", source: { type: "base64", media_type: img.type, data: img.data } }, { type: "text", text }] : text;
    S.chat.push({ role: "user", content });
    addMsg("user", (img ? `<img src="data:${img.type};base64,${img.data}" alt="">` : "") + md(text));
    const pending = addMsg("ai", "<span class='hint'>در حال پاسخ… (اگر مدل شلوغ باشد خودکار دوباره تلاش می‌شود)</span>"); $("#btnSend").disabled = true;
    try {
      let h = S.chat.slice(-14).map((m, i, a) => (i < a.length - 1 && Array.isArray(m.content) ? { role: m.role, content: m.content.filter((b) => b.type === "text") } : m));
      while (h.length && h[0].role !== "user") h.shift();
      const reply = await FA.ai.chat(S.keys, h, FA.ai.chatSystem(ctx()));
      S.chat.push({ role: "assistant", content: reply }); pending.innerHTML = md(reply);
    } catch (e) { S.chat.pop(); pending.className = "msg ai err"; pending.textContent = e.message; }
    finally { $("#btnSend").disabled = false; $("#chatLog").scrollTop = 1e9; }
  }
  function attachImage(e) {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    if (f.size > 4.5 * 1024 * 1024) { alert("حجم تصویر باید کمتر از ۴٫۵ مگابایت باشد."); return; }
    const rd = new FileReader();
    rd.onload = () => { const m = /^data:(.+?);base64,(.*)$/.exec(rd.result); if (m) { S.img = { type: m[1], data: m[2] }; const c = $("#attachChip"); c.hidden = false; c.textContent = "🖼 " + f.name + " (با پیام بعدی ارسال می‌شود)"; } };
    rd.readAsDataURL(f);
  }

  /* ---------------- market screener (راهنمای بهترین فرصت‌ها) ---------------- */
  async function scanMarkets() {
    if (S.scanning) return;
    S.scanning = true; $("#btnScan").disabled = true; $("#scanProg").textContent = "شروع اسکن…";
    const rows = [];
    // همه‌ی بازارها شامل بورس تهران؛ TSETMC آهسته است و به pacing نیاز دارد — یک‌به‌یک و با وقفه اسکن می‌شود
    const list = D.SYMBOLS.slice();
    for (let k = 0; k < list.length; k++) {
      const sym = list[k];
      $("#scanProg").textContent = `اسکن ${k + 1}/${list.length}: ${sym.name}${sym.tse ? " (TSETMC — ممکن است کمی طول بکشد)" : ""}`;
      try {
        if (k) await D.sleep(sym.tse ? 1500 : 120);
        const r = await D.fetchCandles(sym, S.tf, S.keys, 400);
        const c = dedupe(r.candles);
        const a = FA.signal.analyze(c, { early: true, marketEntry: true, threshold: 0 });
        if (a.error) throw new Error(a.error);
        const atrPct = ok(a.atr) ? (100 * a.atr) / a.price : null;
        rows.push({
          sym, name: sym.name, price: a.price, direction: a.direction, conf: a.confluence,
          rr: a.plan ? a.plan.rr[0] : null, atrPct, tech: a.tech, pa: a.pa, fund: a.fund,
          alert: a.signalType === "early" ? a.timing : "", score: a.score,
        });
      } catch (e) { rows.push({ sym, name: sym.name, error: e.message }); }
    }
    rows.sort((x, y) => (y.score || -9) - (x.score || -9));
    S.scan = rows; S.scanning = false; $("#btnScan").disabled = false; $("#scanProg").textContent = "";
    save("fa_scan", { t: Date.now(), rows: rows.map((r) => ({ id: r.sym.id, direction: r.direction, conf: r.conf, rr: r.rr, atrPct: r.atrPct, score: r.score, tech: r.tech, pa: r.pa, alert: r.alert, error: r.error })) });
    renderScan();
    const good = rows.filter((r) => r.score != null && Math.abs(r.score) >= 0.25).length;
    pushAlarm("info", `اسکن بازار انجام شد: ${good} نماد با سیگنال مشخص از ${rows.length}. تب «بهترین‌ها» را ببینید.`);
    if (S.rightTab === "best") toast("اسکن کامل شد.", "info");
  }
  const riskOf = (atrPct) => (atrPct == null ? "—" : atrPct < 0.6 ? "کم" : atrPct < 2 ? "متوسط" : "زیاد");
  function renderScan() {
    const box = $("#scanBox");
    if (!S.scan) {
      let cached = load("fa_scan", null);
      if (cached && Date.now() - cached.t < 6 * 3600e3) {
        box.className = ""; box.innerHTML = `<div class="hint">آخرین اسکن: ${new Date(cached.t).toLocaleString("fa-IR", { hour12: false })} — برای اسکن تازه دکمه را بزنید.</div>` + scanTable(cached.rows.map((r) => ({ name: r.id, direction: r.direction, conf: r.conf, rr: r.rr, atrPct: r.atrPct, alert: r.alert, error: r.error, score: r.score })), null);
      } else { box.className = "empty"; box.textContent = "برای یافتن بهترین فرصت‌ها، دکمه‌ی «اسکن همه‌ی بازارها» را بزنید."; }
      return;
    }
    box.className = "";
    box.innerHTML = scanTable(S.scan, S.ranked);
  }
  function scanTable(rows, ranked) {
    const dirTxt = { long: "خرید", short: "فروش", none: "—" };
    if (ranked && ranked.ranked && ranked.ranked.length) {
      const imp = (x) => (x.risk_level === "low" ? "low" : x.risk_level === "medium" ? "medium" : "high");
      const cards = ranked.ranked.filter((x) => x.side !== "none").map((x) => `<div class="fcard imp-${imp(x)}"><b>#${x.rank} ${esc(x.name || x.symbol)} — ${x.side === "long" ? "خرید" : "فروش"} · ${esc({ excellent: "عالی", good: "خوب", weak: "ضعیف" }[x.entry_quality] || x.entry_quality || "")} · ریسک: ${esc({ low: "کم", medium: "متوسط", high: "زیاد" }[x.risk_level] || x.risk_level || "")}</b>${esc(x.potential || "")}${x.risk_note ? `<br><small>ریسک: ${esc(x.risk_note)}</small>` : ""}</div>`).join("");
      const skip = ranked.ranked.filter((x) => x.side === "none").slice(0, 8);
      const note = ranked.local
        ? `<div class="hint">رتبه‌بندی AI انجام نشد${ranked.aiError ? " («" + esc(ranked.aiError) + "»)" : ""}؛ فهرست زیر را موتور تکنیکال به‌صورت محلی و با معیار «سود بالقوه ÷ ریسک» ساخته است.</div>`
        : ranked.aiError ? `<div class="hint">${esc(ranked.aiError)}</div>` : "";
      return note + `<div class="hint">${ranked.local ? "رتبه‌بندی محلی (بدون AI)" : "رتبه‌بندی AI"} — بهترین‌ها اول (سود بیشتر، ریسک کمتر)${ranked.batches ? " · " + ranked.batches + " دسته" : ""}${ranked.total ? " از " + ranked.total + " بازار" : ""}${ranked.sourceNote ? " · " + esc(ranked.sourceNote) : ""}</div>` + cards +
        (ranked.summary ? `<p class="hint">${esc(ranked.summary)}</p>` : "") +
        (skip.length ? `<h4>پیشنهاد می‌شود فعلاً معامله نشوند</h4>` + skip.map((x) => `<div class="fcard"><b>${esc(x.name || x.symbol)}</b>${esc(x.risk_note || x.potential || "")}</div>`).join("") : "") +
        `<h4>کل نتایج اسکن</h4>` + rawTable(rows);
    }
    return rawTable(rows);
  }
  function rawTable(rows) {
    const dirTxt = { long: "خرید", short: "فروش", none: "—" };
    return `<table class="btable"><thead><tr><th>نماد</th><th>جهت</th><th>هم‌سویی</th><th>R/R تارگت۱</th><th>نوسان (ATR%)</th><th>ریسک</th><th>امتیاز</th></tr></thead><tbody>
      ${rows.map((r) => r.error ? `<tr><td>${esc(r.name)}</td><td colspan="6" class="hint">${esc(r.error)}</td></tr>`
        : `<tr><td>${esc(r.name)}${r.alert ? " ⚡" : ""}</td><td class="${r.direction === "long" ? "win" : r.direction === "short" ? "loss" : ""}">${dirTxt[r.direction] || "—"}</td><td>${r.conf != null ? r.conf : "—"}</td><td>${fR(r.rr)}</td><td>${fR(r.atrPct, 2)}</td><td>${riskOf(r.atrPct)}</td><td>${r.score != null ? r.score.toFixed(2) : "—"}</td></tr>`).join("")}
      </tbody></table>
      ${rows.some((r) => r.alert) ? '<div class="hint">⚡ = سیگنال زودهنگام (قبل از تکمیل حرکت)</div>' : ""}`;
  }
  async function rankWithAI() {
    if (!requireKey()) return;
    if (!S.scan || !S.scan.length) { toast("اول «اسکن همه‌ی بازارها» را اجرا کنید.", "info"); return; }
    const btn = $("#btnRankAI"), btnScan = $("#btnScan"), box = $("#scanBox");
    btn.disabled = true; if (btnScan) btnScan.disabled = true;
    const t0 = Date.now(), secs = () => Math.round((Date.now() - t0) / 1000);
    // a visible clock: the old version looked «فریز شده» during long backoff waits
    const tick = setInterval(() => { if (box.className === "empty") box.textContent = "AI در حال رتبه‌بندی… " + secs() + " ثانیه (تلاش مجدد خودکار؛ صفحه بسته نشده)"; }, 1000);
    try {
      box.className = "empty"; box.textContent = "AI در حال رتبه‌بندی…";
      const markets = S.scan.filter((r) => !r.error).map((r) => ({ id: r.sym.id, name: r.name, price: r.price, direction: r.direction, confluence: r.conf, tech: r.tech, pa: r.pa, atrPct: r.atrPct, rr: r.rr, fund: r.fund, alert: r.alert }));
      S.ranked = await FA.ai.screener(S.keys, { markets }, (m) => { box.textContent = m + " (" + secs() + "s)"; });
      renderScan();
      if (S.ranked && S.ranked.local) toast("AI پاسخ نداد؛ رتبه‌بندی محلی نمایش داده شد.", "info");
    } catch (e) {
      box.className = "empty";
      box.innerHTML = `<span class="loss">${esc(e.message)}</span>${e.detail ? `<br><small class="hint">${esc(e.detail)}</small>` : ""}<br><small class="hint">راه‌حل‌ها: در ⚙ تنظیمات یک مدل دیگر انتخاب کنید، چند دقیقه بعد دوباره بزنید، یا اگر شبکه فیلتر است VPN روشن کنید. جدول خام تکنیکال با دکمه‌ی «اسکن همه‌ی بازارها» همیشه در دسترس است.</small>`;
    }
    finally { clearInterval(tick); btn.disabled = false; if (btnScan) btnScan.disabled = false; }
  }

  /* ---------------- backtest (profit/loss based) ---------------- */
  async function runBt() {
    const box = $("#btBox"), btn = $("#btnBt");
    if (S.candles.length < 300) { box.className = "empty"; box.textContent = "حداقل ۳۰۰ کندل لازم است."; return; }
    const early = $("#btEarly").checked;
    btn.disabled = true; box.className = "empty"; box.textContent = "در حال اجرا…";
    try {
      const res = await FA.backtest.run(S.candles, { window: 300, horizon: 48, early, onProgress: (p) => ($("#btProg").textContent = Math.round(p * 100) + "%") });
      $("#btProg").textContent = ""; box.className = "";
      const pct = (x) => (x == null ? "—" : x.toFixed(1) + "%"), num = (x) => (x == null ? "—" : x.toFixed(2));
      const b0 = res.summary[0];
      const verdict = b0 && b0.totalR != null
        ? (b0.totalR > 0 ? `<div class="note-early" style="border-color:var(--up);color:#bdebd8">نتیجه‌ی نهایی روی این نماد/تایم‌فریم: <b>سودده</b> (جمع ${b0.totalR.toFixed(2)}R از ${b0.count} معامله، شامل ضررها)</div>`
          : `<div class="note-early" style="border-color:var(--dn);color:#f3c2ca">نتیجه‌ی نهایی روی این نماد/تایم‌فریم: <b>زیان‌ده</b> (جمع ${b0.totalR.toFixed(2)}R از ${b0.count} معامله)</div>`)
        : "";
      box.innerHTML = `${verdict}<div class="hint">${esc(S.sym.name)} · ${S.tf.label} · ${res.bars} کندل · ورود در قیمت بازار، تارگت اول در برابر حد ضرر، حداکثر ۴۸ کندل${early ? " · با سیگنال زودهنگام" : ""}</div>
        <table class="btable"><thead><tr><th>هم‌سویی ≥</th><th>تعداد</th><th>سود (R)</th><th>ضرر (R)</th><th>نرخ برد</th><th>سر‌به‌سر</th><th>میانگین R</th><th>جمع R (سود−ضرر)</th><th>فاکتور سود</th><th>بیشترین افت</th></tr></thead><tbody>
        ${res.summary.map((b) => `<tr class="${b.threshold === S.thr ? "hl" : ""}"><td>${b.threshold}</td><td>${b.count}</td><td class="win">${num(b.grossWin)}</td><td class="loss">${num(b.grossLoss)}</td><td>${pct(b.winRate)}</td><td>${pct(b.breakeven)}</td><td>${num(b.avgR)}</td><td class="${b.totalR > 0 ? "win" : b.totalR < 0 ? "loss" : ""}">${num(b.totalR)}</td><td>${b.profitFactor == null ? "—" : b.profitFactor === Infinity ? "∞" : b.profitFactor.toFixed(2)}</td><td>${num(b.maxDD)}</td></tr>`).join("")}</tbody></table>
        <ul class="warns" style="margin-top:12px">
          <li>ستون «جمع R» = سود منهای ضررِ همه‌ی معاملات؛ مثبت یعنی سیستم روی این نماد سودده بوده است (بدون در نظر گرفتن جهت سیگنال خرید/فروش).</li>
          <li>«فاکتور سود» بالای ۱٫۳ و «بیشترین افت» کوچک، یعنی ریسک سیستم قابل‌تحمل است.</li>
          <li>اگر تعداد معاملات کمتر از ۳۰ است، نتیجه از نظر آماری قابل اتکا نیست.</li>
          <li>این بک‌تست walk-forward است (موتور در هر لحظه فقط کندل‌های گذشته را می‌بیند)؛ کارمزد و اسلیپیج لحاظ نشده است.</li></ul>`;
    } catch (e) { box.className = "empty"; box.textContent = e.message; }
    finally { btn.disabled = false; }
  }

  /* ---------------- journal ---------------- */
  function journalStats() {
    const closed = S.journal.filter((x) => x.res === "win" || x.res === "loss" || x.res === "be"), w = closed.filter((x) => x.res === "win").length, l = closed.filter((x) => x.res === "loss").length;
    const rs = closed.map((x) => x.r).filter(ok);
    return { trades: S.journal.length, closed: closed.length, winRate: w + l ? +((100 * w) / (w + l)).toFixed(1) : null, avgR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2) : null, totalR: rs.length ? +rs.reduce((a, b) => a + b, 0).toFixed(2) : null };
  }
  function renderJournal() {
    const st = journalStats(), rl = { open: "باز", win: "برد", loss: "باخت", be: "سر‌به‌سر" };
    $("#jStats").innerHTML = `<div>معاملات<b>${st.trades}</b></div><div>نرخ برد<b>${st.winRate == null ? "—" : st.winRate + "%"}</b></div><div>میانگین R<b>${st.avgR == null ? "—" : st.avgR}</b></div><div>جمع R<b>${st.totalR == null ? "—" : st.totalR}</b></div>`;
    $("#jList").innerHTML = S.journal.length ? S.journal.slice().reverse().map((x) => `<div class="jitem"><div><b>${esc(x.sym)}</b> ${x.side === "long" ? "خرید" : "فروش"} · <span class="${x.res}">${rl[x.res]}</span>${ok(x.r) ? " · " + x.r + "R" : ""}${x.conf != null ? " · هم‌سویی " + x.conf : ""}<br><span class="hint">${esc(x.note)}</span></div><div class="m">${esc(x.entry)} / SL ${esc(x.sl)}${x.tp ? " / TP " + esc(x.tp) : ""}<br>${esc(x.date)}<br><button data-del="${x.id}" title="حذف">✕</button></div></div>`).join("") : '<div class="empty">هنوز معامله‌ای ثبت نشده. ثبت دقیق معاملات، پایه‌ی پیدا کردن اشتباهات است.</div>';
  }
  function addJournal(e) {
    e.preventDefault();
    const num = (id) => { const v = $(id).value; return v === "" ? null : +v; };
    S.journal.push({ id: Date.now(), date: new Date().toLocaleString("en-GB"), sym: S.sym.id, tf: S.tf.id, side: $("#jSide").value, entry: num("#jEntry"), sl: num("#jSl"), tp: num("#jTp"), res: $("#jRes").value, r: num("#jR"), note: $("#jNote").value.trim(), conf: S.res && !S.res.error ? S.res.confluence : null });
    save("fa_journal", S.journal); $("#jForm").reset(); renderJournal();
  }
  function fillJournal() {
    const p = S.res && S.res.plan; if (!p) return;
    $("#jSide").value = p.side; $("#jEntry").value = +p.entry.toPrecision(7); $("#jSl").value = +p.sl.toPrecision(7); $("#jTp").value = +p.tps[0].toPrecision(7);
  }
  function exportJournal() {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(S.journal, null, 2)], { type: "application/json" })); a.download = "fandamental-journal.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function reviewJournal() {
    if (!S.journal.length) { addMsg("ai", "اول چند معامله در تب «ژورنال» ثبت کن تا بتوانم الگوی اشتباهات را پیدا کنم."); showRight("chat"); return; }
    send("این ژورنال معاملات من است. الگوی اشتباهاتم را پیدا کن (ورود، حد ضرر، جهت‌گیری، زمان‌بندی، مدیریت سرمایه، احساسات) و حداکثر دو قانون مشخص برای اصلاح پیشنهاد بده.\n" + JSON.stringify(S.journal.slice(-30)));
  }

  /* ---------------- CSV + settings ---------------- */
  function importCsv(e) {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const c = D.parseCsv(String(rd.result));
      if (c.length < 60) { status("CSV معتبر نبود: ستون‌ها باید time,open,high,low,close[,volume] باشند و حداقل ۶۰ ردیف داشته باشند.", true); return; }
      S.candles = dedupe(c); S.source = "CSV (" + f.name + ")"; S.note = ""; run({ keepCandles: true });
    };
    rd.readAsText(f);
  }
  let tmp = null, curProv = "gemini";
  function fillProv(p) {
    curProv = p; const m = FA.ai.PROVIDERS[p];
    $("#kProv").value = p; $("#kKey").value = tmp[p] || ""; $("#kModel").value = (tmp.models && tmp.models[p]) || m.model;
    $("#kKeyHelp").innerHTML = `<a href="${m.keyUrl}" target="_blank" rel="noopener" style="color:var(--acc)">گرفتن کلید</a>`;
    $("#kProvNote").textContent = m.note || "";
  }
  function stashProv() { tmp[curProv] = $("#kKey").value.trim(); tmp.models = Object.assign({}, tmp.models, { [curProv]: $("#kModel").value.trim() }); }
  function openSettings() {
    tmp = JSON.parse(JSON.stringify(S.keys));
    $("#kProv").innerHTML = Object.entries(FA.ai.PROVIDERS).map(([id, m]) => `<option value="${id}">${esc(m.label)}</option>`).join("");
    $("#kProv").onchange = (e) => { stashProv(); fillProv(e.target.value); };
    fillProv(tmp.provider || "gemini");
    $("#kTwelve").value = S.keys.twelve || ""; $("#kThr").value = S.thr;
    $("#dlgSettings").showModal();
  }
  $("#dlgSettings").addEventListener("close", () => {
    if ($("#dlgSettings").returnValue !== "save") return;
    stashProv(); tmp.provider = $("#kProv").value; tmp.twelve = $("#kTwelve").value.trim(); S.keys = tmp;
    S.thr = Math.max(40, Math.min(95, +$("#kThr").value || 70)); save("fa_keys", S.keys); save("fa_thr", S.thr); updateFundHint();
    if (S.candles.length) reanalyze();
  });
  $("#kClear").onclick = () => { S.keys = { provider: S.keys.provider || "gemini", models: {} }; save("fa_keys", S.keys); $("#kKey").value = $("#kTwelve").value = ""; tmp = JSON.parse(JSON.stringify(S.keys)); };

  init();
})();
