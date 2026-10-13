/* Fandamental — UI controller. */
(function () {
  "use strict";
  const FA = window.FA, D = FA.data, ok = FA.ind.ok;
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const fmt = (x, ref) => FA.signal.fmt(x, ref);
  const VD = { buy: "خرید", sell: "فروش", neutral: "خنثی" };

  const S = {
    sym: D.SYMBOLS.find((s) => s.id === load("fa_sym", "BTCUSDT")) || D.SYMBOLS[0],
    tf: D.TIMEFRAMES.find((t) => t.id === load("fa_tf", "1h")) || D.TIMEFRAMES[2],
    keys: Object.assign({ provider: "gemini", models: {} }, load("fa_keys", {})), thr: load("fa_thr", 70),
    candles: [], res: null, fund: null, source: "", note: "",
    ov: load("fa_ov", { ema: true, bb: false, vwap: false, st: false, levels: true, plan: true }),
    journal: load("fa_journal", []), chat: [], img: null, busy: false, timer: null,
    dirty: { tv: true, overview: true, news: true }, centerTab: "analytic", rightTab: "signal", charts: null, calc: load("fa_calc", { bal: 1000, risk: 1 }),
  };

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

  /* ---------------- boot ---------------- */
  function init() {
    // symbol select + watchlist
    const groups = [...new Set(D.SYMBOLS.map((s) => s.group))];
    $("#symbol").innerHTML = groups.map((g) => `<optgroup label="${esc(g)}">${D.SYMBOLS.filter((s) => s.group === g).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</optgroup>`).join("");
    $("#symbol").value = S.sym.id;
    $("#watch").innerHTML = groups.map((g) => `<h5>${esc(g)}</h5>` + D.SYMBOLS.filter((s) => s.group === g).map((s) => `<button data-sym="${s.id}" class="${s.id === S.sym.id ? "on" : ""}">${esc(s.name)}<span>${esc(s.id)}</span></button>`).join("")).join("");
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
    $("#btnFund").onclick = runFund;
    $("#btnBt").onclick = runBt;
    $("#btnSend").onclick = () => { const t = $("#chatText").value.trim(); if (t || S.img) { $("#chatText").value = ""; send(t || "این چارت را تحلیل کن."); } };
    $("#chatText").onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#btnSend").click(); };
    $("#btnAttach").onclick = () => $("#imgFile").click();
    $("#imgFile").onchange = attachImage;
    $("#btnReview").onclick = reviewJournal;
    $("#jForm").onsubmit = addJournal;
    $("#jFill").onclick = fillJournal;
    $("#jExport").onclick = exportJournal;
    $("#jList").onclick = (e) => { const b = e.target.closest("[data-del]"); if (b) { S.journal = S.journal.filter((x) => x.id !== +b.dataset.del); save("fa_journal", S.journal); renderJournal(); } };

    embed($("#tape"), "ticker-tape", {
      symbols: [["Gold", "OANDA:XAUUSD"], ["Silver", "OANDA:XAGUSD"], ["EURUSD", "OANDA:EURUSD"], ["GBPUSD", "OANDA:GBPUSD"], ["USDJPY", "OANDA:USDJPY"], ["DXY", "TVC:DXY"], ["BTC", "BINANCE:BTCUSDT"], ["ETH", "BINANCE:ETHUSDT"], ["S&P500", "FOREXCOM:SPXUSD"], ["Oil", "TVC:USOIL"]].map(([title, proName]) => ({ title, proName })),
      showSymbolLogo: true, colorTheme: "dark", isTransparent: true, displayMode: "adaptive", locale: "en",
    });
    new ResizeObserver(() => resizeCharts()).observe($("#chartMain").parentElement);
    renderJournal(); updateFundHint();
    run();
  }

  function setSymbol(id) {
    S.sym = D.SYMBOLS.find((s) => s.id === id) || S.sym; save("fa_sym", S.sym.id);
    $("#symbol").value = S.sym.id; $$("#watch [data-sym]").forEach((b) => b.classList.toggle("on", b.dataset.sym === S.sym.id));
    S.fund = null; $("#fundBox").className = "empty"; $("#fundBox").textContent = "تحلیل خبری برای این نماد اجرا نشده."; S.dirty.tv = S.dirty.news = true;
    if (S.centerTab === "tv") renderTV(); if (S.rightTab === "fund") renderNews();
    run();
  }
  function setTf(id) {
    S.tf = D.TIMEFRAMES.find((t) => t.id === id) || S.tf; save("fa_tf", S.tf.id);
    $$("#tfs [data-tf]").forEach((b) => b.classList.toggle("on", b.dataset.tf === S.tf.id)); S.dirty.tv = true;
    if (S.centerTab === "tv") renderTV(); run();
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
    if (tab === "fund" && S.dirty.news) renderNews();
  }

  /* ---------------- TradingView widgets ---------------- */
  function renderTV() {
    S.dirty.tv = false;
    embed($("#tvChart"), "advanced-chart", {
      autosize: true, symbol: S.sym.tv, interval: S.tf.tv, timezone: "Etc/UTC", theme: "dark", style: "1", locale: "en",
      enable_publishing: false, allow_symbol_change: true, withdateranges: true, save_image: true, studies: ["RSI@tv-basicstudies", "MACD@tv-basicstudies"],
      support_host: "https://www.tradingview.com",
    });
  }
  function renderOverview() {
    S.dirty.overview = false;
    const pick = (g) => D.SYMBOLS.filter((s) => s.group === g).map((s) => ({ s: s.tv, d: s.name.replace(/[^\x00-\x7F]+/g, "").trim() || s.id }));
    embed($("#tvOverview"), "market-overview", {
      colorTheme: "dark", dateRange: "1D", showChart: true, locale: "en", isTransparent: true, showSymbolLogo: true, showFloatingTooltip: false, width: "100%", height: "100%",
      tabs: [{ title: "Forex", symbols: pick("فارکس") }, { title: "Metals", symbols: pick("فلزات و کالا") }, { title: "Crypto", symbols: pick("کریپتو") }, { title: "Indices", symbols: pick("شاخص‌ها") }],
    });
  }
  function renderNews() {
    S.dirty.news = false;
    embed($("#tvNews"), "timeline", { feedMode: "symbol", symbol: S.sym.tv, colorTheme: "dark", isTransparent: true, displayMode: "regular", width: "100%", height: 420, locale: "en" });
    embed($("#tvCal"), "events", { colorTheme: "dark", isTransparent: true, width: "100%", height: 420, locale: "en", importanceFilter: "-1,0,1", currencyFilter: "USD,EUR,GBP,JPY,CHF,AUD,CAD,NZD,CNY" });
  }

  /* ---------------- data + analysis ---------------- */
  const dedupe = (c) => { const m = new Map(); c.forEach((x) => m.set(x.t, x)); return [...m.values()].sort((a, b) => a.t - b.t).filter((x) => [x.o, x.h, x.l, x.c].every(ok)); };

  async function run(opt) {
    if (S.busy) return;
    S.busy = true; $("#btnRun").disabled = true;
    try {
      if (!(opt && opt.keepCandles)) {
        status(`در حال دریافت داده‌ی <b>${esc(S.sym.name)}</b>…`);
        const r = await D.fetchCandles(S.sym, S.tf, S.keys, 1000);
        S.candles = dedupe(r.candles); S.source = r.source; S.note = r.note;
      }
      reanalyze();
      const last = S.candles[S.candles.length - 1];
      status(`<b>${esc(S.sym.name)}</b> · ${S.tf.label} · منبع: ${esc(S.source)} · ${S.candles.length} کندل · آخرین کندل: ${fmtTime(last.t)}${S.note ? " · " + esc(S.note) : ""}`);
    } catch (e) { status("خطا: " + esc(e.message), true); }
    finally { S.busy = false; $("#btnRun").disabled = false; }
  }
  function reanalyze() {
    S.res = FA.signal.analyze(S.candles, { fund: S.fund, threshold: S.thr });
    renderChart(); renderSignal(); renderInd();
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
      p.tps.forEach((t, i) => pl(t, "#2ebd85", `TP${i + 1} (${p.rr[i].toFixed(1)}R)`, 0));
    }
    const mk = r.pa_data.patterns.filter((p) => p.dir !== 0 && p.i >= S.candles.length - 3).map((p) => ({ time: T[p.i], position: p.dir === 1 ? "belowBar" : "aboveBar", color: p.dir === 1 ? "#2ebd85" : "#f6465d", shape: p.dir === 1 ? "arrowUp" : "arrowDown", text: p.name }));
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
    const badge = r.tradeable ? `<span class="badge ok">سیگنال معتبر (هم‌سویی ≥ ${r.threshold})</span>` : r.direction === "none" ? `<span class="badge wait">فعلاً وارد نشو</span>` : `<span class="badge wait">هم‌سویی کافی نیست؛ صبر کن</span>`;
    const all = r.items.concat(r.paItems), ds = r.direction === "short" ? -1 : 1, rank = (a, b) => b.w * Math.abs(b.score) - a.w * Math.abs(a.score);
    const sup = r.direction === "none" ? [] : all.filter((x) => Math.sign(x.score) === ds && Math.abs(x.score) >= 0.25).sort(rank).slice(0, 6);
    const opp = r.direction === "none" ? [] : all.filter((x) => Math.sign(x.score) === -ds && Math.abs(x.score) >= 0.25).sort(rank).slice(0, 3);
    const li = (x) => `<li><b>${esc(x.name)}</b>: ${esc(x.value)} → ${VD[x.verdict]}</li>`;
    let plan = "";
    if (r.plan) {
      const p = r.plan, f = (x) => fmt(x, r.price), side = p.side === "long";
      plan = `<table class="plan">
        <tr><td>ورود ${p.isLimit ? "(سفارش لیمیت روی پولبک)" : "(قیمت بازار)"}</td><td class="ac">${f(p.entry)}</td></tr>
        <tr><td>ناحیه‌ی ورود</td><td>${f(p.entryZone[0])} – ${f(p.entryZone[1])}</td></tr>
        <tr><td>حد ضرر</td><td class="dn">${f(p.sl)}</td></tr>
        ${p.tps.map((t, i) => `<tr><td>تارگت ${i + 1}<span class="tag">${p.rr[i].toFixed(2)}R</span></td><td class="up">${f(t)}</td></tr>`).join("")}
        <tr><td>ریسک هر واحد (≈ATR)</td><td>${f(p.risk)}</td></tr></table>
        <div class="calc">محاسبه‌ی حجم:
          <div class="row"><input id="cBal" type="number" value="${S.calc.bal}" min="0"> موجودی &nbsp; <input id="cRisk" type="number" value="${S.calc.risk}" step="0.25" min="0.1"> % ریسک</div>
          <div id="cOut" class="hint"></div></div>`;
    }
    box.innerHTML = `
      <div class="sig-head">
        <div class="ring"><svg width="92" height="92" viewBox="0 0 92 92"><circle cx="46" cy="46" r="40" fill="none" stroke="#222a3b" stroke-width="8"/><circle cx="46" cy="46" r="40" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - r.confluence / 100)}"/></svg><b style="color:${col}">${r.confluence}</b></div>
        <div><span class="pill ${r.direction}">${dirTxt}</span><br>${badge}
          <div class="hint">امتیاز هم‌سویی سیگنال‌ها (نه احتمال سود) · ${r.buys} خرید / ${r.sells} فروش از ${all.length} مورد</div></div>
      </div>
      ${plan}
      ${r.fund ? `<div class="hint" style="margin-top:8px">فاندامنتال AI: <b>${esc(r.fund.bias)}</b> (اطمینان ${Math.round(r.fund.confidence)}%)</div>` : ""}
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

  /* ---------------- AI: fundamentals ---------------- */
  function requireKey() {
    if (!S.keys[S.keys.provider || "gemini"]) { openSettings(); return false; } return true;
  }
  function updateFundHint() {
    const p = FA.ai.PROVIDERS[S.keys.provider || "gemini"];
    $("#fundHint").textContent = p.search ? "جستجوی زنده‌ی وب با کلید شما" : "تیترهای زنده از GDELT/CryptoCompare + تحلیل مدل " + p.label;
  }
  async function runFund() {
    if (!requireKey() || !S.res || S.res.error) return;
    const btn = $("#btnFund"), box = $("#fundBox"); btn.disabled = true; box.className = "empty"; box.textContent = "در حال جستجوی اخبار و تحلیل… (۲۰ تا ۶۰ ثانیه)";
    try {
      const r = S.res, tech = `${r.direction}, confluence ${r.confluence}, tech ${r.tech.toFixed(2)}, price action ${r.pa.toFixed(2)}`;
      const f = await FA.ai.fundamental(S.keys, { name: S.sym.name, tv: S.sym.tv, tf: S.tf.label, price: fmt(r.price, r.price), tech, sym: S.sym, today: new Date().toISOString().slice(0, 10) });
      S.fund = f; renderFund(); reanalyze();
    } catch (e) { box.className = "empty"; box.innerHTML = `<span class="loss">${esc(e.message)}</span>`; }
    finally { btn.disabled = false; }
  }
  function renderFund() {
    const f = S.fund, box = $("#fundBox"); if (!f) return; box.className = "";
    const bias = { bullish: "صعودی", bearish: "نزولی", neutral: "خنثی" };
    const dir = (d) => ({ bullish: "▲", bearish: "▼", neutral: "●" }[d] || "●");
    box.innerHTML = `<div class="fbias"><span class="pill ${f.bias === "bullish" ? "long" : f.bias === "bearish" ? "short" : "none"}">${bias[f.bias] || esc(f.bias)}</span><span class="hint">امتیاز ${f.score.toFixed(2)} · اطمینان ${Math.round(f.confidence)}%</span></div>
      <div class="hint">منبع: ${esc(f.sourceNote || "")}</div>
      <p>${esc(f.summary)}</p>
      ${(f.drivers || []).map((d) => `<div class="fcard imp-${esc(d.impact)}"><b>${dir(d.direction)} ${esc(d.headline)}</b>${esc(d.why)}<br><small>${esc(d.source)}</small></div>`).join("")}
      ${(f.upcoming_events || []).length ? "<h4>رویدادهای پیش‌رو</h4>" : ""}
      ${(f.upcoming_events || []).map((e) => `<div class="fcard imp-${esc(e.importance)}"><b>${esc(e.event)}</b><small>${esc(e.when)}</small><br>${esc(e.risk)}</div>`).join("")}
      ${(f.risks || []).length ? `<h4>ریسک‌ها</h4><ul class="warns">${f.risks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}`;
  }

  /* ---------------- AI: chat ---------------- */
  function ctx() {
    const r = S.res || {}, round = (x) => (ok(x) ? +x.toPrecision(7) : null);
    const out = { symbol: S.sym.name, timeframe: S.tf.label, journal: journalStats() };
    if (r && !r.error && r.plan !== undefined) {
      Object.assign(out, {
        price: round(r.price), direction: r.direction, confluence: r.confluence, tradeable: r.tradeable, techScore: round(r.tech), priceActionScore: round(r.pa), warnings: r.warnings,
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
    const pending = addMsg("ai", "…"); $("#btnSend").disabled = true;
    try {
      // only the latest image is re-sent; older ones are reduced to text to keep requests small
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

  /* ---------------- backtest ---------------- */
  async function runBt() {
    const box = $("#btBox"), btn = $("#btnBt");
    if (S.candles.length < 300) { box.className = "empty"; box.textContent = "حداقل ۳۰۰ کندل لازم است."; return; }
    btn.disabled = true; box.className = "empty"; box.textContent = "در حال اجرا…";
    try {
      const res = await FA.backtest.run(S.candles, { window: 300, horizon: 48, onProgress: (p) => ($("#btProg").textContent = Math.round(p * 100) + "%") });
      $("#btProg").textContent = ""; box.className = "";
      const pct = (x) => (x == null ? "—" : x.toFixed(1) + "%"), num = (x) => (x == null ? "—" : x.toFixed(2));
      box.innerHTML = `<div class="hint">${esc(S.sym.name)} · ${S.tf.label} · ${res.bars} کندل · ورود در قیمت بازار، تارگت اول در برابر حد ضرر، حداکثر ۴۸ کندل</div>
        <table class="btable"><thead><tr><th>هم‌سویی ≥</th><th>تعداد</th><th>نرخ برد</th><th>سر‌به‌سر</th><th>میانگین R</th><th>جمع R</th><th>منقضی</th></tr></thead><tbody>
        ${res.summary.map((b) => `<tr class="${b.threshold === S.thr ? "hl" : ""}"><td>${b.threshold}</td><td>${b.count}</td><td class="${b.winRate != null && b.breakeven != null && b.winRate > b.breakeven ? "win" : "loss"}">${pct(b.winRate)}</td><td>${pct(b.breakeven)}</td><td>${num(b.avgR)}</td><td>${num(b.totalR)}</td><td>${b.expired}</td></tr>`).join("")}</tbody></table>
        <ul class="warns" style="margin-top:12px">
          <li>«نرخ برد» باید از «سر‌به‌سر» بالاتر باشد تا سیستم روی این نماد سودده باشد.</li>
          <li>اگر تعداد معاملات کمتر از ۳۰ است، نتیجه از نظر آماری قابل اتکا نیست.</li>
          <li>این بک‌تست فقط تکنیکال و پرایس‌اکشن را می‌سنجد (فاندامنتال در گذشته قابل بازسازی نیست)؛ کارمزد و اسلیپیج لحاظ نشده است.</li></ul>`;
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
    $("#kProvNote").textContent = m.search ? "این سرویس جستجوی زنده‌ی وب دارد؛ تحلیل خبری دقیق‌تر است ولی پولی است." : "رایگان است (با محدودیت تعداد درخواست). جستجوی وب ندارد؛ تیترهای خبری را اپ از GDELT/CryptoCompare می‌گیرد و به مدل می‌دهد، پس عمق تحلیل خبری کمتر از حالت پولی است.";
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
