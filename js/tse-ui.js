/* Fandamental — «دیده‌بان بورس تهران» tab (whole market, indices, retail/institutional flow, scan)
   and the fundamentals box for Tehran shares in the news tab. Uses js/tse.js. */
(function (g) {
  "use strict";
  const FA = (g.FA = g.FA || {});
  if (typeof document === "undefined" || !FA.tse) return;
  const T = FA.tse;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  const ok = (x) => typeof x === "number" && isFinite(x);
  const fa = (x, d = 0) => (ok(x) ? x.toLocaleString("fa-IR", { maximumFractionDigits: d, minimumFractionDigits: 0 }) : "—");
  const pct = (x) => (ok(x) ? `<span dir="ltr" class="${x > 0 ? "win" : x < 0 ? "loss" : ""}">${x > 0 ? "+" : ""}${fa(x, 2)}٪</span>` : "—");
  const toman = (rial) => (!ok(rial) ? "—" : Math.abs(rial) >= 1e13 ? fa(rial / 1e13, 1) + " همت" : Math.abs(rial) >= 1e10 ? fa(rial / 1e10, 1) + " میلیارد ت" : fa(rial / 1e7, 0) + " میلیون ت");
  const TSE_GROUP = "بورس تهران";

  const U = {
    rows: null, ct: null, sectors: new Map(), idx1: [], idx2: [], ov: null, err: "", busy: false, at: 0,
    opt: Object.assign({ kind: "stock", sector: "", q: "", sort: "value", baseOnly: false }, load("fa_tse_opt", {})), show: 60,
    tech: {}, scanning: false, prog: "",
  };

  /* ---------- data ---------- */
  async function refresh(force) {
    if (U.busy || (!force && U.rows && Date.now() - U.at < 60e3)) return render();
    U.busy = true; U.err = ""; render();
    const [mw, ct, i1, i2, ov, sec] = await Promise.allSettled([T.api.marketWatch(), T.api.clientTypeAll(), T.api.indexAll(1), T.api.indexAll(2), T.api.overview(1), T.api.sectors()]);
    if (mw.status === "fulfilled") { U.rows = mw.value; U.at = Date.now(); } else U.err = "دیده‌بان بازار از TSETMC دریافت نشد: " + (mw.reason && mw.reason.message);
    if (ct.status === "fulfilled") U.ct = ct.value;
    if (i1.status === "fulfilled") U.idx1 = i1.value;
    if (i2.status === "fulfilled") U.idx2 = i2.value;
    if (ov.status === "fulfilled") U.ov = ov.value;
    if (sec.status === "fulfilled") U.sectors = sec.value;
    U.busy = false; render();
  }

  function enriched() {
    if (!U.rows) return [];
    return U.rows.map((r) => {
      const f = U.ct ? T.flowMetrics(U.ct.get(r.ins), ok(r.close) && r.close > 0 ? r.close : r.last) : null;
      return { ...r, flow: f };
    });
  }

  function filtered() {
    const o = U.opt, q = T.norm(o.q).replace(/\s/g, "");
    let rows = enriched().filter((r) => (o.kind === "all" ? true : r.kind === o.kind))
      .filter((r) => !o.sector || r.sector === o.sector)
      .filter((r) => !q || (r.sym + r.name).replace(/\s/g, "").includes(q))
      .filter((r) => !o.baseOnly || (r.baseVol > 0 && r.volume >= r.baseVol));
    const k = {
      value: (r) => r.value, change: (r) => r.closePct, inflow: (r) => (r.flow ? r.flow.netRetailValue : -Infinity),
      power: (r) => (r.flow && ok(r.flow.buyPower) ? r.flow.buyPower : -Infinity), pe: (r) => (r.pe > 0 ? -r.pe : -Infinity), mcap: (r) => r.mcap,
      tech: (r) => (U.tech[r.ins] && U.tech[r.ins].state === "ok" ? U.tech[r.ins].score : -Infinity),
    }[o.sort] || ((r) => r.value);
    return rows.sort((a, b) => (ok(k(b)) ? k(b) : -Infinity) - (ok(k(a)) ? k(a) : -Infinity));
  }

  const symOf = (r) => ({ id: "TSE-" + r.sym, name: r.name || r.sym, short: r.sym, group: TSE_GROUP, tv: "", tse: r.ins, td: "", yh: "" });
  const indexSym = (x) => ({ id: "TSEIDX-" + x.ins, name: x.name, short: x.name, group: TSE_GROUP, tv: "", tseIndex: x.ins, td: "", yh: "" });
  function open(sym) { if (FA.app && FA.app.openSymbol) FA.app.openSymbol(sym); }

  async function scan(list) {
    if (U.scanning) return;
    U.scanning = true;
    const D = FA.data, tf = D.TIMEFRAMES.find((t) => t.id === "1d");
    for (let k = 0; k < list.length; k++) {
      const r = list[k];
      U.prog = `اسکن ${fa(k + 1)}/${fa(list.length)}: ${r.sym}`; render();
      if (U.tech[r.ins] && U.tech[r.ins].state === "ok") continue;
      try {
        const got = await D.fetchCandles(symOf(r), tf, load("fa_keys", {}), 400);
        const a = FA.signal.analyze(got.candles, { early: true, threshold: load("fa_thr", 70), useSetups: load("fa_use_setups", false) });
        U.tech[r.ins] = a.error ? { state: "error" } : { state: "ok", dir: a.direction, conf: a.confluence, tradeable: a.tradeable, score: a.score };
      } catch (e) { U.tech[r.ins] = { state: "error" }; }
      await D.sleep(600);
    }
    U.scanning = false; U.prog = ""; render();
  }

  /* ---------- render: market watch tab ---------- */
  function render() {
    const pane = $("#pane-tse"); if (!pane) return;
    if (pane.contains(document.activeElement) && document.activeElement.matches("input[type=search]")) { renderTable(); return; }
    const chip = (x) => `<button class="tsechip" data-tse-index="${esc(x.ins)}" title="نمایش و تحلیل روی چارت"><b>${esc(x.name)}</b><span>${fa(x.value, 0)}</span>${pct(x.pct)}</button>`;
    const sel1 = U.idx1.filter((x) => x.selected), sel2 = U.idx2.filter((x) => x.selected).slice(0, 2), sectorIdx = U.idx1.filter((x) => !x.selected);
    const secCodes = [...new Set((U.rows || []).filter((r) => r.kind === "stock").map((r) => r.sector))].filter(Boolean).sort();
    const o = U.opt;
    pane.innerHTML = `
      <div class="tsehead">
        <div class="tsechips">${sel1.map(chip).join("")}${sel2.map((x) => chip({ ...x, name: "فرابورس: " + x.name })).join("")}${!sel1.length && !U.busy ? '<span class="hint">شاخص‌ها هنوز دریافت نشده‌اند.</span>' : ""}</div>
        ${U.ov ? `<div class="hint">بازار: <b>${esc(T.norm(U.ov.marketStateTitle || ""))}</b> · ارزش معاملات ${toman(U.ov.marketActivityQTotCap)} · تعداد معاملات ${fa(U.ov.marketActivityZTotTran)} · ارزش بازار ${toman(U.ov.marketValue)}</div>` : ""}
        ${sectorIdx.length ? `<div class="row"><select id="tseSecIdx">${sectorIdx.map((x) => `<option value="${esc(x.ins)}">${esc(x.name)} (${x.pct > 0 ? "+" : ""}${fa(x.pct, 2)}٪)</option>`).join("")}</select><button class="btn ghost" data-tse-secidx>نمایش شاخص صنعت روی چارت</button></div>` : ""}
      </div>
      <div class="row tsectl">
        <select data-tse-opt="kind"><option value="stock" ${o.kind === "stock" ? "selected" : ""}>سهام</option><option value="fund" ${o.kind === "fund" ? "selected" : ""}>صندوق‌ها</option><option value="all" ${o.kind === "all" ? "selected" : ""}>همه</option></select>
        <select data-tse-opt="sector"><option value="">همه‌ی صنایع</option>${secCodes.map((c) => `<option value="${esc(c)}" ${o.sector === c ? "selected" : ""}>${esc(U.sectors.get(c) || "صنعت " + c)}</option>`).join("")}</select>
        <select data-tse-opt="sort">${[["value", "بیشترین ارزش معاملات"], ["change", "بیشترین رشد قیمت"], ["inflow", "بیشترین ورود پول حقیقی"], ["power", "بیشترین قدرت خریدار"], ["pe", "کمترین P/E"], ["mcap", "بیشترین ارزش بازار"], ["tech", "امتیاز تکنیکال (بعد از اسکن)"]].map(([v, n]) => `<option value="${v}" ${o.sort === v ? "selected" : ""}>${n}</option>`).join("")}</select>
        <label class="hint"><input type="checkbox" data-tse-opt="baseOnly" ${o.baseOnly ? "checked" : ""}> فقط حجم بالای حجم مبنا</label>
        <input type="search" id="tseQ" placeholder="جستجوی نماد یا نام" value="${esc(o.q)}">
        <button class="btn ghost" data-tse-refresh>${U.busy ? "در حال دریافت…" : "↻ به‌روزرسانی"}</button>
        <button class="btn primary" data-tse-scan ${U.scanning || !U.rows ? "disabled" : ""}>اسکن تکنیکال ۳۰ نماد اول</button>
        <span class="hint">${esc(U.prog)}</span>
      </div>
      ${U.err ? `<div class="warn">${esc(U.err)}<br>TSETMC معمولاً فقط از اینترنت ایران باز می‌شود. اگر بیرون از ایران هستید یا باز نمی‌شود، «رله‌ی شخصی» را در ⚙ تنظیمات بگذارید.</div>` : ""}
      <div id="tseTable"></div>
      <div class="hint">پایانی و آخرین نسبت به قیمت دیروز. «ورود پول حقیقی» = خرید حقیقی − فروش حقیقی (امروز)، به تومان. «قدرت خریدار» = سرانه‌ی خرید حقیقی ÷ سرانه‌ی فروش حقیقی (بالای ۱ یعنی خریداران قوی‌ترند). «تکنیکال» = موتور اپ روی کندل روزانه‌ی تعدیل‌شده همراه جریان حقیقی/حقوقی. هیچ‌کدام احتمال سود نیست.</div>`;
    renderTable();
  }

  function renderTable() {
    const box = $("#tseTable"); if (!box) return;
    if (!U.rows) { box.innerHTML = `<div class="empty">${U.busy ? "در حال دریافت دیده‌بان بازار…" : "برای دیدن کل بازار «به‌روزرسانی» را بزنید."}</div>`; return; }
    const rows = filtered(), shown = rows.slice(0, U.show);
    const techCell = (r) => {
      const t = U.tech[r.ins]; if (!t) return '<span class="hint">—</span>';
      if (t.state !== "ok") return '<span class="hint">خطا</span>';
      return `${{ long: "<b class='win'>خرید</b>", short: "<b class='loss'>فروش</b>", none: "بدون جهت" }[t.dir]} <small>${fa(t.conf)}${t.tradeable ? " ✓" : ""}</small>`;
    };
    box.innerHTML = `<div class="hint">${fa(rows.length)} نماد · به‌روزرسانی ${U.at ? new Date(U.at).toLocaleTimeString("fa-IR", { hour12: false }) : "—"}</div>
      <div class="mtf-wrap"><table class="btable tsetable"><thead><tr><th>نماد</th><th>پایانی</th><th>آخرین</th><th>ارزش معاملات</th><th>حجم / مبنا</th><th>P/E</th><th>ورود پول حقیقی</th><th>قدرت خریدار</th><th>تکنیکال</th><th></th></tr></thead><tbody>
      ${shown.map((r) => {
        const lim = r.limitMax > 0 && r.last >= r.limitMax ? ' <span class="badge ok" title="آخرین قیمت روی سقف مجاز">سقف</span>' : r.limitMin > 0 && r.last > 0 && r.last <= r.limitMin ? ' <span class="badge wait" title="آخرین قیمت روی کف مجاز">کف</span>' : "";
        const vb = r.baseVol > 0 ? r.volume / r.baseVol : NaN;
        return `<tr><td class="tkn"><b>${esc(r.sym)}</b>${lim}<small>${esc(r.name)}</small></td>
          <td>${fa(r.close)}<br>${pct(r.closePct)}</td><td>${fa(r.last)}<br>${pct(r.lastPct)}</td>
          <td>${toman(r.value)}</td><td class="${vb >= 1 ? "win" : ""}">${ok(vb) ? fa(vb, 1) + "×" : "—"}</td><td>${r.pe > 0 ? fa(r.pe, 1) : "—"}</td>
          <td>${r.flow && ok(r.flow.netRetailValue) ? `<span class="${r.flow.netRetailValue > 0 ? "win" : r.flow.netRetailValue < 0 ? "loss" : ""}">${toman(r.flow.netRetailValue)}</span>` : "—"}</td>
          <td>${r.flow && ok(r.flow.buyPower) ? `<span class="${r.flow.buyPower >= 1.5 ? "win" : r.flow.buyPower <= 0.67 ? "loss" : ""}">${fa(r.flow.buyPower, 2)}</span>` : "—"}</td>
          <td>${techCell(r)}</td><td><button class="btn ghost" data-tse-open="${esc(r.ins)}">چارت</button></td></tr>`;
      }).join("") || '<tr><td colspan="10" class="hint">با این فیلترها نمادی نماند.</td></tr>'}</tbody></table></div>
      ${rows.length > U.show ? `<div class="row"><button class="btn ghost" data-tse-more>نمایش ${fa(Math.min(60, rows.length - U.show))} نماد بیشتر</button></div>` : ""}`;
  }

  /* ---------- fundamentals box for the current Tehran share (news tab) ---------- */
  let fundTok = 0;
  async function renderFund(sym, res) {
    const box = $("#tseFund"); if (!box) return;
    if (!sym || !(sym.tse || sym.tseIndex)) { box.innerHTML = ""; box.hidden = true; return; }
    box.hidden = false;
    if (sym.tseIndex) { box.innerHTML = `<h4>${esc(sym.name)}</h4><div class="hint">شاخص است؛ اطلاعات بنیادی مخصوص سهم ندارد. جهت کلی بازار را از تحلیل همین شاخص روی چارت ببینید.</div>`; return; }
    const tok = ++fundTok;
    box.innerHTML = `<h4>اطلاعات بنیادی ${esc(sym.short || sym.name)}</h4><div class="empty">در حال دریافت از TSETMC…</div>`;
    try {
      const info = await T.api.info(sym.tse);
      if (tok !== fundTok) return;
      const last = res && res.series ? res.series.c[res.series.c.length - 1] : NaN, v = T.valuation(info, last);
      const lc = res && res.series ? res.series.v[res.series.v.length - 1] : NaN;
      const cl = (FA.app && FA.app.candles ? FA.app.candles() : []).slice(-1)[0] || {};
      const kv = (k, val) => `<div><span>${k}</span><b>${val}</b></div>`;
      box.innerHTML = `<h4>اطلاعات بنیادی ${esc(info.ticker)} <span class="hint">${esc(info.name)}</span></h4>
        <div class="hint">${esc(info.sector)} · ${esc(info.market)}</div>
        <div class="mtf-kv tsekv">
          ${kv("EPS" + (info.epsEstimated ? " (پیش‌بینی شرکت)" : ""), fa(info.eps) + " ریال")}
          ${kv("P/E (قیمت ÷ EPS)", v && ok(v.pe) ? fa(v.pe, 1) : "—")}
          ${kv("P/E گروه", ok(info.sectorPE) ? fa(info.sectorPE, 1) : "—")}
          ${kv("P/E نسبت به گروه", v && ok(v.peVsSector) ? `<span class="${v.peVsSector < 1 ? "win" : "loss"}">${fa(v.peVsSector, 2)}×</span>` : "—")}
          ${kv("ارزش بازار", v ? toman(v.mcap) : "—")}
          ${kv("تعداد سهام", fa(info.shares))}
          ${kv("سهام شناور آزاد", ok(info.freeFloat) ? fa(info.freeFloat) + "٪" : "—")}
          ${kv("حجم مبنا / حجم آخرین روز", `${fa(info.baseVol)} / <span class="${lc >= info.baseVol ? "win" : ""}">${fa(lc)}</span>`)}
          ${kv("میانگین حجم معاملات", fa(info.avgVolume))}
          ${kv("دامنه‌ی مجاز قیمت امروز", ok(info.limitMin) && info.limitMin > 0 ? `${fa(info.limitMin)} تا ${fa(info.limitMax)}` : "—")}
          ${kv("کمترین / بیشترین ۵۲ هفته", `${fa(info.minYear)} / ${fa(info.maxYear)}`)}
          ${kv("فاصله از سقف / کف سالانه", v ? `${pct(v.fromYearHigh)} / ${pct(v.fromYearLow)}` : "—")}
          ${ok(cl.rn) ? kv("جریان حقیقی آخرین روز", `<span class="${cl.rn > 0 ? "win" : "loss"}">${cl.rn > 0 ? "ورود" : "خروج"} ${toman(Math.abs(cl.rn))}</span> · قدرت خریدار ${fa(cl.bp, 2)}`) : ""}
        </div>
        <div class="hint">قیمت‌های اپ برای افزایش سرمایه و سود نقدی تعدیل شده‌اند. P/E با آخرین قیمت تعدیل‌شده و EPS اعلامی شرکت محاسبه می‌شود؛ صورت‌های مالی را در کدال بررسی کنید.</div>`;
    } catch (e) {
      if (tok === fundTok) box.innerHTML = `<h4>اطلاعات بنیادی</h4><div class="empty">از TSETMC دریافت نشد (${esc(e.message)}).</div>`;
    }
  }

  /* ---------- boot ---------- */
  function boot() {
    const tabs = $("#centerTabs"), center = $("section.center");
    if (!tabs || !center) return;
    const b = document.createElement("button"); b.dataset.tab = "tse"; b.textContent = "دیده‌بان بورس تهران"; tabs.append(b);
    const pane = document.createElement("div"); pane.id = "pane-tse"; pane.className = "pane card"; center.append(pane);
    tabs.addEventListener("click", (e) => { const x = e.target.closest("[data-tab]"); if (x && x.dataset.tab === "tse") setTimeout(() => refresh(false), 0); });
    pane.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest("[data-tse-refresh]")) return refresh(true);
      if (t.closest("[data-tse-more]")) { U.show += 60; return renderTable(); }
      if (t.closest("[data-tse-scan]")) return scan(filtered().filter((r) => r.kind === "stock" || U.opt.kind !== "stock").slice(0, 30));
      const ix = t.closest("[data-tse-index]"); if (ix) { const x = U.idx1.concat(U.idx2).find((y) => y.ins === ix.dataset.tseIndex); if (x) open(indexSym(x)); return; }
      if (t.closest("[data-tse-secidx]")) { const ins = $("#tseSecIdx").value, x = U.idx1.find((y) => y.ins === ins); if (x) open(indexSym(x)); return; }
      const op = t.closest("[data-tse-open]"); if (op) { const r = U.rows.find((y) => y.ins === op.dataset.tseOpen); if (r) open(symOf(r)); }
    });
    pane.addEventListener("change", (e) => {
      const el = e.target.closest("[data-tse-opt]"); if (!el) return;
      U.opt[el.dataset.tseOpt] = el.type === "checkbox" ? el.checked : el.value; U.show = 60; save("fa_tse_opt", U.opt); render();
    });
    pane.addEventListener("input", (e) => { if (e.target.id === "tseQ") { U.opt.q = e.target.value; U.show = 60; save("fa_tse_opt", U.opt); renderTable(); } });
    const fund = $("#r-fund");
    if (fund) { const fb = document.createElement("div"); fb.id = "tseFund"; fb.className = "tsefund"; fb.hidden = true; fund.prepend(fb); }
    g.addEventListener("fa:analysis", (ev) => { const d = ev.detail || {}; renderFund(d.sym, d.res); });
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})(typeof window !== "undefined" ? window : globalThis);
