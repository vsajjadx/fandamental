/* Fandamental — multi-timeframe view.
   Runs the EXISTING engine (FA.signal.analyze, unchanged) on every timeframe of the selected symbol and
   shows each timeframe's full analysis in a panel above the chart. Timeframes ticked by the user have their
   trade plan (entry / SL / TP) and nearest support / resistance drawn on the main chart in their own colour.
   Display only: nothing here changes how a signal is produced or what is sent to MT5. */
(function (g) {
  "use strict";
  const FA = (g.FA = g.FA || {});

  /* ------------------------------------------------------------ pure helpers (unit-tested in Node) */
  const TF_COLOR = { "5m": "#ff9f43", "15m": "#feca57", "1h": "#48dbfb", "4h": "#a29bfe", "1d": "#ff6b9d" };
  const DIR_FA = { long: "خرید", short: "فروش", none: "بدون جهت" };
  const ok = (x) => typeof x === "number" && isFinite(x);

  /** Compact, display-ready summary of one analyze() result. */
  function summarize(res) {
    if (!res || res.error) return { error: (res && res.error) || "تحلیل ناموفق" };
    const s = res.series || {}, i = (res.count || 1) - 1, at = (a) => (a && ok(a[i]) ? a[i] : null);
    const adx = s.adx ? at(s.adx.adx) : null;
    const status = res.signalType === "early" ? "early" : res.tradeable ? "valid" : res.direction === "none" ? "none" : "weak";
    const p = res.plan;
    return {
      direction: res.direction, confluence: res.confluence, status, timing: res.timing || "",
      tradeable: !!res.tradeable, price: res.price, atr: res.atr,
      plan: p ? { side: p.side, entry: p.entry, sl: p.sl, tps: p.tps.slice(), rr: p.rr.slice(), isLimit: !!p.isLimit } : null,
      rsi: s.rsi ? at(s.rsi) : null, adx, regime: adx == null ? "" : adx >= 25 ? "روندی قوی" : adx >= 18 ? "روندی" : "رنج / بی‌روند",
      tech: res.tech, pa: res.pa, fund: res.fund ? res.fund.bias : null,
      buys: res.buys, sells: res.sells,
      support: (res.pa_data && res.pa_data.sups && res.pa_data.sups[0]) ? res.pa_data.sups[0].price : null,
      resistance: (res.pa_data && res.pa_data.ress && res.pa_data.ress[0]) ? res.pa_data.ress[0].price : null,
      warnings: (res.warnings || []).slice(), lastTime: res.lastTime,
    };
  }

  /** How many analysed timeframes point each way. */
  function alignment(rows) {
    const out = { long: 0, short: 0, none: 0, total: 0 };
    rows.forEach((r) => { if (r && r.sum && !r.sum.error) { out.total++; out[r.sum.direction] = (out[r.sum.direction] || 0) + 1; } });
    return out;
  }

  /** Price lines to draw for the ticked timeframes (the chart's own timeframe is already drawn by the app). */
  function overlayLines(rows, selected, currentTf) {
    const lines = [];
    rows.forEach((r) => {
      if (!r || !r.sum || r.sum.error || r.tf.id === currentTf || !selected.includes(r.tf.id)) return;
      const c = TF_COLOR[r.tf.id] || "#ccc", L = r.tf.label, s = r.sum;
      if (s.plan) {
        lines.push({ price: s.plan.entry, color: c, title: `${L} ENTRY`, style: 0, width: 2 });
        lines.push({ price: s.plan.sl, color: c, title: `${L} SL`, style: 1, width: 1 });
        lines.push({ price: s.plan.tps[0], color: c, title: `${L} TP1`, style: 1, width: 1 });
      }
      if (ok(s.support)) lines.push({ price: s.support, color: c, title: `${L} S`, style: 3, width: 1 });
      if (ok(s.resistance)) lines.push({ price: s.resistance, color: c, title: `${L} R`, style: 3, width: 1 });
    });
    return lines.filter((l) => ok(l.price) && l.price > 0);
  }

  function cacheTtlSec(tf) { return tf.sec <= 3600 ? 60 : 300; }

  FA.mtf = { TF_COLOR, summarize, alignment, overlayLines, cacheTtlSec };

  /* ------------------------------------------------------------ UI (browser only) */
  if (typeof document === "undefined") return;

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const fmt = (x, ref) => (FA.signal && ok(x) ? FA.signal.fmt(x, ref) : "—");
  const fR = (x) => (ok(x) ? x.toFixed(1) : "—");
  const dedupe = (c) => { const m = new Map(); c.forEach((x) => m.set(x.t, x)); return [...m.values()].sort((a, b) => a.t - b.t).filter((x) => [x.o, x.h, x.l, x.c].every(ok)); };
  const VD = { buy: "خرید", sell: "فروش", neutral: "خنثی" };

  const V = {
    sel: load("fa_mtf_sel", ["4h", "1d"]), open: load("fa_mtf_open", true), detail: null,
    sym: null, curTf: null, fund: null, source: "", token: 0,
    rows: {},              // tfId → { tf, state: 'loading'|'ok'|'error'|'na', sum, res, err, at, source }
    cs: null, drawn: [],
  };

  function tfs() { return (FA.data && FA.data.TIMEFRAMES) || []; }

  /* ---------- data ---------- */
  async function analyzeTf(tf, token) {
    const D = FA.data, keys = load("fa_keys", {}), thr = load("fa_thr", 70);
    const row = V.rows[tf.id] || (V.rows[tf.id] = { tf });
    const fit = D.resolveTimeframe(V.sym, tf, keys);
    if (fit.changed) { Object.assign(row, { state: "na", err: "منابع رایگان برای این دارایی فقط کندل روزانه دارند؛ برای این تایم‌فریم کلید رایگان Twelve Data را در ⚙ تنظیمات وارد کنید." }); return; }
    if (row.state === "ok" && row.at && Date.now() / 1000 - row.at < cacheTtlSec(tf) && row.fund === V.fund) return;
    row.state = row.state === "ok" ? "ok" : "loading"; row.loading = true; paint();
    try {
      const r = await D.fetchCandles(V.sym, tf, keys, 1000);
      if (token !== V.token) return;
      const c = dedupe(r.candles);
      if (c.length < 60) throw new Error("کندل کافی دریافت نشد (" + c.length + ")");
      const res = FA.signal.analyze(c, { fund: V.fund, threshold: thr, early: true });
      Object.assign(row, { state: res.error ? "error" : "ok", res, sum: summarize(res), err: res.error || "", at: Date.now() / 1000, source: r.source, fund: V.fund, count: c.length });
    } catch (e) {
      if (token !== V.token) return;
      Object.assign(row, { state: "error", err: e.message || String(e) });
    } finally { row.loading = false; }
  }

  async function refreshAll() {
    if (!V.sym || !V.open) return;
    const token = V.token, list = tfs().filter((t) => t.id !== V.curTf);
    // two at a time: quick, without flooding the free data sources
    for (let i = 0; i < list.length; i += 2) {
      await Promise.all(list.slice(i, i + 2).map((t) => analyzeTf(t, token)));
      if (token !== V.token) return;
      paint(); drawOverlay();
    }
  }

  function onAnalysis(ev) {
    const { res, sym, tf } = ev.detail || {};
    if (!sym || !tf) return;
    if (!V.sym || V.sym.id !== sym.id) { V.rows = {}; V.token++; }
    V.sym = sym; V.curTf = tf.id; V.fund = res && res.fund ? res.fund : null; V.source = (ev.detail && ev.detail.source) || "";
    const row = V.rows[tf.id] || (V.rows[tf.id] = { tf });
    Object.assign(row, { state: res && !res.error ? "ok" : "error", res, sum: summarize(res), err: (res && res.error) || "", at: Date.now() / 1000, source: V.source, fund: V.fund, count: res && res.count, current: true });
    tfs().forEach((t) => { if (V.rows[t.id] && t.id !== tf.id) V.rows[t.id].current = false; });
    paint();
    refreshAll();
  }

  /* ---------- chart overlay (called by app.js right after it draws the chart) ---------- */
  function overlay(cs) { V.cs = cs; V.drawn = []; drawOverlay(); }
  function drawOverlay() {
    const cs = V.cs; if (!cs) return;
    V.drawn.forEach((l) => { try { cs.removePriceLine(l); } catch (e) { /* chart was rebuilt */ } });
    V.drawn = [];
    if (!V.open) return;
    const rows = tfs().map((t) => V.rows[t.id]).filter(Boolean);
    overlayLines(rows, V.sel, V.curTf).forEach((l) => {
      try { V.drawn.push(cs.createPriceLine({ price: l.price, color: l.color, lineWidth: l.width, lineStyle: l.style, axisLabelVisible: true, title: l.title })); } catch (e) { /* ignore */ }
    });
  }

  /* ---------- rendering ---------- */
  function statusBadge(s) {
    if (s.status === "valid") return '<span class="badge ok">معتبر</span>';
    if (s.status === "early") return '<span class="badge early">⚡ زودهنگام</span>';
    if (s.status === "weak") return '<span class="badge wait">ضعیف</span>';
    return '<span class="badge wait">صبر</span>';
  }

  function rowHtml(t) {
    const r = V.rows[t.id] || { state: "loading" }, s = r.sum, isCur = t.id === V.curTf, col = TF_COLOR[t.id];
    const chk = `<input type="checkbox" data-mtf-sel="${t.id}" ${V.sel.includes(t.id) || isCur ? "checked" : ""} ${isCur ? "disabled title='تایم‌فریم فعلی چارت'" : "title='نمایش سطوح این تایم‌فریم روی چارت'"}>`;
    const tfBtn = `<button class="mtf-tf ${isCur ? "on" : ""}" data-mtf-go="${t.id}" style="--c:${col}" title="باز کردن چارت کامل این تایم‌فریم">${esc(t.label)}</button>`;
    if (r.state === "na" || r.state === "error" || !s || s.error) {
      const msg = r.state === "loading" || r.loading ? "در حال تحلیل…" : r.err || (s && s.error) || "";
      return `<tr class="${isCur ? "cur" : ""}"><td>${chk}</td><td>${tfBtn}</td><td colspan="7" class="hint mtf-msg">${esc(msg)}</td></tr>`;
    }
    const p = s.plan, ref = s.price;
    return `<tr class="${isCur ? "cur" : ""}${V.detail === t.id ? " open" : ""}">
      <td>${chk}</td><td>${tfBtn}</td>
      <td><span class="pill ${s.direction}">${DIR_FA[s.direction]}</span>${r.loading ? ' <span class="hint">↻</span>' : ""}</td>
      <td class="mono">${s.confluence}</td><td>${statusBadge(s)}</td>
      <td class="mono">${p ? fmt(p.entry, ref) : "—"}</td><td class="mono dn">${p ? fmt(p.sl, ref) : "—"}</td>
      <td class="mono up">${p ? fmt(p.tps[0], ref) + ` <small>${fR(p.rr[0])}R</small>` : "—"}</td>
      <td><button class="btn ghost mtf-more" data-mtf-detail="${t.id}">${V.detail === t.id ? "بستن" : "جزئیات"}</button></td></tr>`;
  }

  function detailHtml(t) {
    const r = V.rows[t.id]; if (!r || !r.sum || r.sum.error) return "";
    const s = r.sum, res = r.res, ref = s.price, p = s.plan;
    const all = (res.items || []).concat(res.paItems || []), ds = s.direction === "short" ? -1 : 1;
    const rank = (a, b) => b.w * Math.abs(b.score) - a.w * Math.abs(a.score);
    const sup = s.direction === "none" ? [] : all.filter((x) => Math.sign(x.score) === ds && Math.abs(x.score) >= 0.25).sort(rank).slice(0, 6);
    const opp = s.direction === "none" ? [] : all.filter((x) => Math.sign(x.score) === -ds && Math.abs(x.score) >= 0.25).sort(rank).slice(0, 4);
    const li = (x) => `<li><b>${esc(x.name)}</b>: ${esc(x.value)} → ${VD[x.verdict] || ""}</li>`;
    const lv = (arr, cls) => (arr || []).slice(0, 3).map((l) => `<span class="mono ${cls}">${fmt(l.price, ref)}<small>×${l.touches}</small></span>`).join(" ");
    const pats = ((res.pa_data && res.pa_data.patterns) || []).filter((x) => x.i >= res.count - 3 && x.dir !== 0).map((x) => `${esc(x.name)} (${x.dir === 1 ? "صعودی" : "نزولی"})`);
    const when = s.lastTime ? new Date(s.lastTime * 1000).toLocaleString("fa-IR", { hour12: false }) : "—";
    return `<tr class="mtf-detail"><td colspan="9"><div class="mtf-card" style="--c:${TF_COLOR[t.id]}">
      <div class="mtf-dh"><b>تحلیل کامل ${esc(t.label)}</b> <span class="pill ${s.direction}">${DIR_FA[s.direction]}</span> ${statusBadge(s)}
        <span class="hint">هم‌سویی ${s.confluence} (نه احتمال سود) · ${s.buys} خرید / ${s.sells} فروش · ${r.count || "?"} کندل · آخرین کندل ${when} · منبع ${esc(r.source || "")}</span></div>
      ${s.timing ? `<div class="note-early">${esc(s.timing)}</div>` : ""}
      <div class="mtf-grid">
        <div>${p ? `<table class="plan">
          <tr><td>ورود ${p.isLimit ? "(لیمیت روی پولبک)" : "(قیمت بازار)"}</td><td class="ac">${fmt(p.entry, ref)}</td></tr>
          <tr><td>حد ضرر</td><td class="dn">${fmt(p.sl, ref)}</td></tr>
          ${p.tps.map((x, i) => `<tr><td>تارگت ${i + 1}<span class="tag">${fR(p.rr[i])}R</span></td><td class="up">${fmt(x, ref)}</td></tr>`).join("")}
        </table>` : '<div class="hint">این تایم‌فریم فعلاً پلن معامله ندارد.</div>'}</div>
        <div class="mtf-kv">
          <div><span>قیمت</span><b class="mono">${fmt(s.price, ref)}</b></div>
          <div><span>وضعیت بازار (ADX)</span><b>${s.adx != null ? s.adx.toFixed(0) + " · " + esc(s.regime) : "—"}</b></div>
          <div><span>RSI(14)</span><b class="mono">${s.rsi != null ? s.rsi.toFixed(1) : "—"}</b></div>
          <div><span>ATR</span><b class="mono">${fmt(s.atr, ref)}</b></div>
          <div><span>امتیاز تکنیکال / پرایس‌اکشن</span><b class="mono">${ok(s.tech) ? s.tech.toFixed(2) : "—"} / ${ok(s.pa) ? s.pa.toFixed(2) : "—"}</b></div>
          ${s.fund ? `<div><span>فاندامنتال AI</span><b>${esc({ bullish: "صعودی", bearish: "نزولی", neutral: "خنثی" }[s.fund] || s.fund)}</b></div>` : ""}
          <div><span>حمایت‌ها</span><b>${lv(res.pa_data && res.pa_data.sups, "up") || "—"}</b></div>
          <div><span>مقاومت‌ها</span><b>${lv(res.pa_data && res.pa_data.ress, "dn") || "—"}</b></div>
          ${pats.length ? `<div><span>الگوهای کندلی اخیر</span><b>${pats.join("، ")}</b></div>` : ""}
        </div>
      </div>
      ${sup.length ? `<h4>دلایل هم‌جهت</h4><ul class="reasons">${sup.map(li).join("")}</ul>` : ""}
      ${opp.length ? `<h4>نشانه‌های مخالف</h4><ul class="reasons">${opp.map(li).join("")}</ul>` : ""}
      ${s.warnings.length ? `<ul class="warns">${s.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      ${t.id !== V.curTf ? `<div class="row"><button class="btn primary" data-mtf-go="${t.id}">باز کردن چارت کامل ${esc(t.label)}</button></div>` : ""}
    </div></td></tr>`;
  }

  function paint() {
    const box = $("#mtfPanel"); if (!box) return;
    if (!V.open) {
      box.innerHTML = `<div class="mtf-head"><button class="btn ghost" data-mtf-toggle>▸ تحلیل چندتایم‌فریمی</button></div>`;
      return;
    }
    const rows = tfs().map((t) => V.rows[t.id]).filter(Boolean), al = alignment(rows);
    const legend = tfs().filter((t) => t.id !== V.curTf && V.sel.includes(t.id)).map((t) => `<span class="mtf-key" style="--c:${TF_COLOR[t.id]}">${esc(t.label)}</span>`).join("");
    const csv = /^CSV/.test(V.source) ? '<div class="hint">چارت فعلی از فایل CSV است؛ تایم‌فریم‌های دیگر از منبع آنلاین همین نماد تحلیل می‌شوند.</div>' : "";
    box.innerHTML = `
      <div class="mtf-head">
        <button class="btn ghost" data-mtf-toggle>▾ تحلیل چندتایم‌فریمی</button>
        ${al.total ? `<span class="hint">هم‌جهتی تایم‌فریم‌ها: <b class="up">${al.long} خرید</b> · <b class="dn">${al.short} فروش</b> · ${al.none} بدون جهت (از ${al.total})</span>` : ""}
        <span class="push hint">روی چارت: ${legend || "هیچ"}</span>
        <button class="btn ghost" data-mtf-all>همه</button><button class="btn ghost" data-mtf-none>هیچ</button>
        <button class="btn ghost" data-mtf-refresh title="تحلیل دوباره‌ی همه‌ی تایم‌فریم‌ها">↻</button>
      </div>
      ${csv}
      <div class="mtf-wrap"><table class="mtf">
        <tr><th title="نمایش روی چارت">چارت</th><th>تایم‌فریم</th><th>جهت</th><th>هم‌سویی</th><th>وضعیت</th><th>ورود</th><th>حد ضرر</th><th>تارگت ۱</th><th></th></tr>
        ${tfs().map((t) => rowHtml(t) + (V.detail === t.id ? detailHtml(t) : "")).join("")}
      </table></div>
      <div class="hint">هر تایم‌فریم جداگانه با همان موتور تحلیل می‌شود. خطوط رنگی روی چارت: ورود (ممتد)، حد ضرر و تارگت ۱ (نقطه‌چین)، حمایت/مقاومت (خط‌چین) تایم‌فریم‌های انتخاب‌شده. هم‌جهتی تایم‌فریم‌ها احتمال سود نیست.</div>`;
  }

  function goTf(id) {
    const b = document.querySelector(`#tfs [data-tf="${id}"]`);
    if (b) { b.click(); const c = $("#chartMain"); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: "smooth", block: "center" }); }
  }

  function boot() {
    const pane = $("#pane-analytic"), bar = pane && pane.querySelector(".chartbar");
    if (!pane || !bar) return;
    const box = document.createElement("div"); box.id = "mtfPanel"; box.className = "mtfpanel";
    bar.insertAdjacentElement("afterend", box);
    box.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("[data-mtf-toggle]")) { V.open = !V.open; save("fa_mtf_open", V.open); paint(); drawOverlay(); if (V.open) refreshAll(); return; }
      if (t.closest("[data-mtf-all]")) { V.sel = tfs().map((x) => x.id); save("fa_mtf_sel", V.sel); paint(); drawOverlay(); return; }
      if (t.closest("[data-mtf-none]")) { V.sel = []; save("fa_mtf_sel", V.sel); paint(); drawOverlay(); return; }
      if (t.closest("[data-mtf-refresh]")) { Object.values(V.rows).forEach((r) => { if (!r.current) r.at = 0; }); refreshAll(); return; }
      const go = t.closest("[data-mtf-go]"); if (go) { goTf(go.dataset.mtfGo); return; }
      const d = t.closest("[data-mtf-detail]"); if (d) { V.detail = V.detail === d.dataset.mtfDetail ? null : d.dataset.mtfDetail; paint(); }
    });
    box.addEventListener("change", (e) => {
      const c = e.target.closest("[data-mtf-sel]"); if (!c) return;
      const id = c.dataset.mtfSel;
      V.sel = c.checked ? [...new Set([...V.sel, id])] : V.sel.filter((x) => x !== id);
      save("fa_mtf_sel", V.sel); paint(); drawOverlay();
    });
    g.addEventListener("fa:analysis", onAnalysis);
    paint();
  }

  FA.mtf.overlay = overlay;
  FA.mtf._state = V;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})(typeof window !== "undefined" ? window : globalThis);
