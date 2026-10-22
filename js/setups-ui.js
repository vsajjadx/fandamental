/* Fandamental — "سبک‌ها و ستاپ‌ها" tab + setup drawings on the chart (uses js/setups.js). Display only. */
(function (g) {
  "use strict";
  const FA = (g.FA = g.FA || {});
  if (typeof document === "undefined") return;
  const X = FA.setups;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const fmt = (x, ref) => (FA.signal ? FA.signal.fmt(x, ref) : String(x));
  const DIR = { 1: "خرید", "-1": "فروش" };

  /* Short explanations of every topic, each pointing to where the app uses it (or saying honestly that it does not). */
  const KNOWLEDGE = [
    { title: "مبانی: ترید، نمودار قیمت، نمودار شمعی، تایم‌فریم", items: [
      ["مفهوم ترید", "خرید و فروش یک دارایی (ارز، طلا، سهام، کریپتو) برای سود از تغییر قیمت؛ در هر دو جهت (خرید = لانگ، فروش = شورت). هر معامله باید حد ضرر و هدف از پیش تعیین‌شده داشته باشد."],
      ["نمودار قیمت", "نمایش تاریخچه‌ی قیمت در زمان. نمودار خطی فقط قیمت بسته شدن را نشان می‌دهد؛ میله‌ای و شمعی، باز، بالا، پایین و بسته را."],
      ["نمودار شمعی", "هر کندل = یک بازه‌ی زمانی: بدنه بین باز و بسته (سبز صعودی، قرمز نزولی) و سایه‌ها تا بالاترین/پایین‌ترین قیمت. الگوهای کندلی (چکش، پین‌بار، انگالف، ستاره‌ی صبحگاهی/شامگاهی…) در اپ خودکار شناسایی می‌شوند."],
      ["تایم‌فریم", "مدت زمان هر کندل (5 دقیقه تا روزانه). تایم بالاتر جهت کلی و تایم پایین‌تر نقطه‌ی ورود را می‌دهد؛ پنل «تحلیل چندتایم‌فریمی» بالای چارت همه را کنار هم نشان می‌دهد."],
    ] },
    { title: "سبک‌های ترید (بر اساس مدت نگهداری)", items: [
      ["لیست سبک‌ها", "اسکالپ، ترید روزانه، سوئینگ، پوزیشن. تفاوت اصلی: تایم‌فریم، مدت نگهداری، تعداد معاملات و میزان وقتی که پای چارت هستید. دکمه‌های بالای همین تب سبک را انتخاب می‌کنند."],
      ["بهترین سبک", "سبک «بهترین» وجود ندارد؛ سبکی مناسب است که با وقت آزاد، سرمایه، تحمل ریسک و هزینه‌ی معامله‌ی شما بخواند و در بک‌تست و دمو روی بازار شما نتیجه‌ی مثبت بدهد. برای تازه‌کارها معمولاً سوئینگ کم‌استرس‌تر است."],
      ["اسکالپ", "معاملات بسیار کوتاه (دقیقه‌ای) با هدف سود کم و تکرار زیاد؛ اسپرد و کارمزد بخش بزرگی از سود را می‌خورد. در اپ: ورود روی 5m با تأیید 15m/1H."],
      ["ترید روزانه", "باز و بسته کردن معامله در همان روز بدون نگه داشتن شبانه. در اپ: ورود روی 15m/1H با تأیید 4H."],
      ["سوئینگ تریدینگ", "گرفتن موج‌های چندروزه تا چندهفته‌ای بازار. در اپ: ورود روی 1H/4H با تأیید 1D."],
      ["پوزیشن تریدینگ", "نگهداری هفته‌ها تا ماه‌ها بر اساس روند بلندمدت و تحلیل بنیادی. در اپ: تایم 1D (تایم هفتگی در منابع رایگان موجود نیست)."],
    ] },
    { title: "سبک‌های تحلیل بازار", items: [
      ["انواع تحلیل", "تکنیکال (رفتار قیمت و حجم)، بنیادی (ارزش واقعی و اخبار اقتصادی)، و تحلیل احساسات بازار. اپ تکنیکال و پرایس اکشن را با موتور خودش و بنیادی را با «تحلیل خبری AI» ترکیب می‌کند."],
      ["ترید با تحلیل بنیادی", "معامله بر اساس اخبار و داده‌های اقتصادی (نرخ بهره، تورم، اشتغال، درآمد شرکت‌ها). در اپ: تب «فاندامنتال و اخبار» و تقویم اقتصادی؛ نتیجه‌ی AI سومین لایه‌ی امتیاز است."],
      ["ارزش‌گذاری در تحلیل بنیادی", "مقایسه‌ی قیمت با ارزش ذاتی: برای سهام مثل P/E و جریان نقدی، برای ارز تفاوت نرخ بهره و تراز تجاری، برای کریپتو ارزش بازار، عرضه‌ی در گردش و کاربرد. ارزش‌گذاری عددی در اپ پیاده نشده است."],
      ["سبک‌های تحلیل تکنیکال", "کلاسیک (الگوها و خطوط)، اندیکاتوری (RSI، MACD، میانگین‌ها…)، پرایس اکشن و اسمارت مانی، و روش‌های موجی (الیوت). اپ بیش از ۲۸ اندیکاتور + پرایس اکشن + ستاپ‌های این تب را دارد؛ الیوت ندارد."],
      ["سبک‌های پرایس اکشن", "پرایس اکشن کلاسیک (حمایت/مقاومت، خط روند، الگوهای کندلی)، ساختار بازار (سقف و کف‌ها)، عرضه و تقاضا / RTM و اسمارت مانی (BOS، CHoCH، اوردر بلاک، FVG، نقدینگی). همه در ستاپ‌های این تب هستند."],
    ] },
    { title: "سبک‌ها بر اساس بازار", items: [
      ["انواع ترید در فارکس", "اسکالپ و روزانه روی جفت‌ارزهای پرنقدشونده، سوئینگ، ترید خبری، و کری ترید (سود از اختلاف نرخ بهره؛ در اپ نیست). منبع رایگان فارکس در اپ روزانه است؛ برای تایم‌های دقیقه‌ای کلید Twelve Data لازم است."],
      ["انواع تریدر ارز دیجیتال", "اسپات (خرید واقعی)، فیوچرز با اهرم (ریسک لیکویید شدن)، هولدر بلندمدت و تریدر کوتاه‌مدت. کریپتو در اپ تمام تایم‌فریم‌ها و حجم واقعی دارد."],
      ["توکن‌های مستعد رشد", "بررسی کاربرد پروژه، تیم، ارزش بازار و ارزش رقیق‌شده، عرضه و آنلاک‌ها، نقدشوندگی و رشد حجم. این غربالگری در اپ پیاده نشده و به داده‌ی بنیادی جداگانه نیاز دارد."],
      ["تحلیل تکنیکال فارکس", "همان اصول تکنیکال، با توجه به ساعات جلسات معاملاتی، اسپرد و اینکه حجم یک منبع، حجم کل بازار نیست (در اپ اندیکاتورهای حجمی برای منبع بدون حجم کنار گذاشته می‌شوند)."],
    ] },
    { title: "حمایت و مقاومت", items: [
      ["حمایت و مقاومت", "نواحی (نه یک خط دقیق) که قیمت قبلاً چند بار از آن برگشته است. اپ سقف و کف‌های تأییدشده را خوشه‌بندی می‌کند و تعداد برخورد هر ناحیه را می‌شمارد."],
      ["ترید با ناحیه‌ی مقاومت", "دو روش: فروش هنگام پس‌زده شدن قیمت از مقاومت با کندل برگشتی (ستاپ «برگشت از ناحیه‌ی مقاومت») یا خرید بعد از شکست مقاومت و پولبک به آن (ستاپ «شکست مقاومت و پولبک»)."],
      ["ترید با ناحیه‌ی حمایت", "خرید هنگام برگشت از حمایت با کندل برگشتی صعودی (ستاپ «برگشت از ناحیه‌ی حمایت») یا فروش بعد از شکست حمایت و پولبک به آن (تبدیل حمایت به مقاومت)."],
    ] },
    { title: "خط روند", items: [
      ["روند صعودی", "سقف‌ها و کف‌های بالاتر (HH/HL). خط روند صعودی از وصل کردن کف‌های بالاتر رسم می‌شود؛ اپ معتبرترین خط را با بیشترین برخورد پیدا و روی چارت رسم می‌کند."],
      ["پولبک به خط روند صعودی", "خرید وقتی قیمت به خط برمی‌گردد و با کندل صعودی بالای آن بسته می‌شود؛ حد ضرر زیر خط."],
      ["شکست خط روند صعودی", "بسته شدن قاطع زیر خط = ضعف روند؛ ستاپ فروش با حد ضرر بالای خط. اغلب بهتر است تا تغییر ساختار (CHoCH) صبر کرد."],
      ["روند نزولی", "سقف‌ها و کف‌های پایین‌تر (LH/LL)؛ خط روند نزولی از وصل کردن سقف‌های پایین‌تر رسم می‌شود."],
      ["برگشت به خط روند نزولی", "فروش وقتی قیمت به خط نزولی می‌رسد و با کندل نزولی زیر آن بسته می‌شود."],
      ["شکست خط روند نزولی", "بسته شدن قاطع بالای خط = پایان احتمالی روند نزولی؛ ستاپ خرید."],
      ["روند خنثی و الگوی مستطیل", "نوسان بین سقف و کف تقریباً افقی. داخل مستطیل: خرید در کف و فروش در سقف؛ شکست مستطیل: ورود در جهت شکست با هدف هم‌اندازه‌ی ارتفاع مستطیل، با تأیید حجم (اگر منبع حجم دارد)."],
    ] },
    { title: "اسمارت مانی و ساختارهای قیمتی", items: [
      ["اسمارت مانی", "رد پای سفارش‌های بزرگ: BOS (شکست سقف/کف در جهت روند)، CHoCH (اولین شکست خلاف روند = هشدار تغییر روند)، اوردر بلاک (آخرین کندل مخالف قبل از حرکت قوی)، FVG (شکاف بین سایه‌ی کندل اول و سوم) و Sweep (رفتن سایه پشت سقف/کف قبلی برای جمع‌آوری حد ضررها و برگشت)."],
      ["ساختار قیمت", "ترتیب سقف و کف‌های تأییدشده؛ پایه‌ی تشخیص روند صعودی، نزولی یا خنثی در اپ."],
      ["ساختار ادامه‌دهنده‌ی صعودی", "پرچم صعودی (حرکت قوی + اصلاح کم‌عمق و فشرده + شکست سقف اصلاح) و شکست مثلث در جهت روند صعودی."],
      ["ساختار ادامه‌دهنده‌ی نزولی", "پرچم نزولی و شکست مثلث در جهت روند نزولی."],
      ["برگشتی صعودی به نزولی", "سقف دوقلو و سر و شانه: فقط بعد از شکست خط گردن معتبر می‌شوند؛ هدف = ارتفاع الگو."],
      ["برگشتی نزولی به صعودی", "کف دوقلو و سر و شانه‌ی معکوس با شکست خط گردن به بالا."],
    ] },
  ];

  const U = { style: load("fa_style", "all"), show: load("fa_ov_setups", true), res: null, sym: null, tf: null, chart: null, series: [] };

  /* ---------- chart drawings (called by app.js after it draws the chart) ---------- */
  function draw(chart, cs, res, candles) {
    U.chart = chart; U.series = [];
    if (!U.show || !res || !res.setups || !candles) return;
    const T = candles.map((x) => x.t), n = T.length;
    const seg = (i1, p1, i2, p2, color, style, title, width) => {
      if (!(i1 >= 0 && i2 < n && i2 > i1 && isFinite(p1) && isFinite(p2))) return;
      try {
        const s = chart.addLineSeries({ color, lineWidth: width || 1, lineStyle: style, priceLineVisible: false, lastValueVisible: !!title, title: title || "", crosshairMarkerVisible: false, autoscaleInfoProvider: () => null });
        s.setData([{ time: T[i1], value: p1 }, { time: T[i2], value: p2 }]);
        U.series.push(s);
      } catch (e) { /* ignore one bad drawing */ }
    };
    for (const d of res.setups.drawings) {
      if (d.type === "line") seg(d.i1, d.p1, d.i2, d.p2, d.color, d.dash ? 2 : 0, d.label, 2);
      else if (d.type === "zone") { seg(d.i1, d.top, d.i2, d.top, d.color, 1, d.label, 1); seg(d.i1, d.bottom, d.i2, d.bottom, d.color, 1, "", 1); }
    }
  }
  function clearDrawings() { const ch = U.chart; U.series.forEach((s) => { try { ch.removeSeries(s); } catch (e) { /* chart rebuilt */ } }); U.series = []; }

  /* ---------- tab ---------- */
  function styleVerdict(key) {
    const st = X.STYLES[key], V = FA.mtf && FA.mtf._state, rows = V ? V.rows : {};
    const dirOf = (id) => { const r = rows[id]; return r && r.sum && !r.sum.error ? r.sum.direction : null; };
    const lab = (id) => ({ "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" }[id] || id);
    const word = { long: "<b class='up'>خرید</b>", short: "<b class='dn'>فروش</b>", none: "بدون جهت", null: "<span class='hint'>تحلیل نشده</span>" };
    const e = st.entry.map((id) => `${lab(id)}: ${word[dirOf(id)]}`).join(" · "), cf = st.confirm.map((id) => `${lab(id)}: ${word[dirOf(id)]}`).join(" · ");
    const ed = st.entry.map(dirOf).filter((d) => d && d !== "none"), cd = st.confirm.map(dirOf).filter((d) => d && d !== "none");
    let v = "";
    if (ed.length && cd.length) {
      const agree = ed.every((d) => cd.every((x) => x === d));
      const against = ed.some((d) => cd.some((x) => x !== d));
      v = agree ? `<div class="note-early" style="border-color:var(--up);color:#bdebd8">تایم ورود و تایم تأیید هم‌جهت‌اند (${ed[0] === "long" ? "خرید" : "فروش"}).</div>`
        : against ? `<div class="note-early" style="border-color:var(--warn);color:#ffd28a">تایم ورود خلاف جهت تایم بالاتر است؛ در این سبک معمولاً یا صبر می‌کنند یا با حجم کمتر وارد می‌شوند.</div>` : "";
    }
    const onTf = st.entry.includes(U.tf) ? "" : `<div class="row"><span class="hint">چارت فعلی ${esc(lab(U.tf))} است؛ تایم ورود این سبک:</span>${st.entry.map((id) => `<button class="btn ghost" data-go-tf="${id}">${lab(id)}</button>`).join("")}</div>`;
    return `<div class="mt5acc"><div class="mt5head"><b>${esc(st.name)}</b> <span class="hint">نگهداری: ${esc(st.hold)}</span></div>
      <div class="hint">${esc(st.note)}</div>
      <div class="hint">تایم ورود — ${e}${cf ? `<br>تایم تأیید — ${cf}` : ""}</div>${v}${onTf}</div>`;
  }

  function render() {
    const pane = $("#r-setups"); if (!pane) return;
    const r = U.res, d = r && r.setups;
    const styles = [["all", "همه"], ...Object.entries(X.STYLES).map(([k, s]) => [k, s.name])];
    const famOrder = ["struct", "trend", "sr", "range", "smc", "cont", "rev"], famName = { struct: "ساختار", ...X.FAMILY };
    const setupsHtml = !d ? '<div class="empty">برای شروع «تحلیل کن» را بزنید.</div>'
      : d.setups.length ? d.setups.map((s) => {
        const p = s.plan, ref = r.price;
        return `<div class="setup ${s.dir === 1 ? "long" : "short"}">
          <div class="mt5head"><span class="pill ${s.dir === 1 ? "long" : "short"}">${DIR[s.dir]}</span> <b>${esc(s.name)}</b> <span class="hint">${esc(X.FAMILY[s.family])} · قدرت ${Math.round(s.strength * 100)}٪</span></div>
          <div class="hint">${esc(s.why)}</div>
          <div class="setup-plan"><span>ورود <b class="mono">${fmt(p.entry, ref)}</b></span><span>حد ضرر <b class="mono dn">${fmt(p.sl, ref)}</b></span><span>هدف <b class="mono up">${fmt(p.tp, ref)}</b></span><span>R:R <b class="mono">${p.rr.toFixed(1)}</b></span></div></div>`;
      }).join("") : '<div class="hint">روی آخرین کندل این تایم‌فریم، هیچ ستاپ فعالی تشکیل نشده است. (گاهی تصمیم درست، معامله نکردن است.)</div>';
    const infoHtml = d && d.info.length ? famOrder.map((f) => {
      const it = d.info.filter((x) => x.family === f); if (!it.length) return "";
      return `<div class="setup-info"><b>${esc(famName[f])}</b><ul>${it.map((x) => `<li>${esc(x.text)}</li>`).join("")}</ul></div>`;
    }).join("") : "";
    const openSet = new Set([...pane.querySelectorAll("details[open] summary")].map((x) => x.textContent));
    pane.innerHTML = `
      <div class="seg mt5seg" role="group">${styles.map(([k, n]) => `<button data-style="${k}" class="${U.style === k ? "on" : ""}">${esc(n)}</button>`).join("")}</div>
      ${U.style !== "all" ? styleVerdict(U.style) : '<p class="hint">یک سبک ترید انتخاب کنید تا تایم ورود/تأیید آن و هم‌جهتی‌شان (از پنل چندتایم‌فریمی) نمایش داده شود.</p>'}
      <h4>ستاپ‌های فعال روی ${esc(U.tf ? ({ "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" }[U.tf]) : "")} ${r && r.usedSetups ? '<span class="badge ok">در امتیاز لحاظ می‌شود</span>' : '<span class="badge wait">فقط نمایش (در امتیاز لحاظ نمی‌شود)</span>'}</h4>
      ${setupsHtml}
      ${infoHtml ? `<h4>وضعیت بازار از دید سبک‌ها</h4>${infoHtml}` : ""}
      <label class="hint"><input type="checkbox" id="ovSetups" ${U.show ? "checked" : ""}> رسم خطوط روند، مستطیل، اوردر بلاک، FVG و خط گردن روی چارت</label>
      <ul class="warns"><li>هر ستاپ یک قانون دقیق و قابل‌تست است، نه پیش‌گویی. عملکرد واقعی هر ستاپ روی همین نماد را در تب «بک‌تست» ببینید و فقط به ستاپی با نمونه‌ی کافی و نتیجه‌ی مثبت اعتماد کنید.</li></ul>
      <h4>آموزش سبک‌ها و مفاهیم</h4>
      ${KNOWLEDGE.map((grp) => `<details class="mt5set"><summary>${esc(grp.title)}</summary><dl class="kb">${grp.items.map(([t, x]) => `<dt>${esc(t)}</dt><dd>${esc(x)}</dd>`).join("")}</dl></details>`).join("")}`;
    pane.querySelectorAll("details summary").forEach((s) => { if (openSet.has(s.textContent)) s.parentElement.open = true; });
  }

  function boot() {
    const tabs = $("#rightTabs"), right = $("aside.right");
    if (!tabs || !right || !X) return;
    const btn = document.createElement("button"); btn.dataset.rt = "setups"; btn.textContent = "سبک‌ها و ستاپ‌ها";
    const after = tabs.querySelector('[data-rt="ind"]'); if (after) after.insertAdjacentElement("afterend", btn); else tabs.append(btn);
    const pane = document.createElement("div"); pane.className = "rpane card"; pane.id = "r-setups";
    const ref = $("#r-ind"); if (ref) ref.insertAdjacentElement("afterend", pane); else right.append(pane);
    pane.addEventListener("click", (e) => {
      const s = e.target.closest("[data-style]"); if (s) { U.style = s.dataset.style; save("fa_style", U.style); render(); return; }
      const t = e.target.closest("[data-go-tf]"); if (t) { const b = document.querySelector(`#tfs [data-tf="${t.dataset.goTf}"]`); if (b) b.click(); }
    });
    pane.addEventListener("change", (e) => {
      if (e.target.id !== "ovSetups") return;
      U.show = e.target.checked; save("fa_ov_setups", U.show);
      clearDrawings(); if (U.show && U.chart && U.res && FA.app && FA.app.candles) draw(U.chart, null, U.res, FA.app.candles());
    });
    tabs.addEventListener("click", (e) => { const b = e.target.closest("[data-rt]"); if (b && b.dataset.rt === "setups") setTimeout(render, 0); });
    g.addEventListener("fa:analysis", (ev) => { const dt = ev.detail || {}; U.res = dt.res; U.sym = dt.sym; U.tf = dt.tf && dt.tf.id; if (pane.classList.contains("on")) render(); });
    setInterval(() => { if (pane.classList.contains("on") && U.style !== "all" && !pane.contains(document.activeElement)) render(); }, 5000);   // multi-timeframe rows arrive later
    render();
  }

  FA.setupsUI = { draw, KNOWLEDGE, _state: U };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})(typeof window !== "undefined" ? window : globalThis);
