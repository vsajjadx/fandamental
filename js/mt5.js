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
    awaiting_approval: "منتظر تأیید شما", queued: "در صف متاتریدر", pending: "در صف ارسال", approved: "تأیید شد", delivered: "تحویل به MT5", sending: "در حال ارسال سفارش",
    unknown: "نامشخص (در حال تطبیق)", displayed: "نمایش داده شد", filled: "اجرا شد", placed: "سفارش لیمیت ثبت شد", rejected: "رد شد",
    failed: "خطای بروکر", expired: "منقضی شد", cancelled: "لغو شد",
  };
  const MODE_FA = { notify: "فقط نمایش سیگنال", confirm: "اجرا پس از تأیید من", auto: "اجرای خودکار" };

  /* ------------------------------------------------------------ direct mode (no server)
     The web app and MT5 run on the SAME computer. The user picks MT5's shared folder
     <Terminal>\Common\Files once; everything is exchanged as small JSON files under FandamentalBridge/:
       config.json            web app → EA   (enabled, mode, live switch, risk settings)
       inbox/<id>.json        web app → EA   (one file per signal; the EA deletes it once handled)
       status.json            EA → web app   (heartbeat + account)
       outbox/<id>.json       EA → web app   (result)      outbox/<id>.close.json (final P/L)  */
  const DIR_NAME = "FandamentalBridge";
  const DEFAULT_SETTINGS = {
    risk_percent: 0.5, fixed_lot: null, max_lot: 0.1, max_spread_points: 0, max_spread_sl_ratio: 0.2, max_entry_dev_sl_ratio: 0.25,
    max_open_positions: 3, max_daily_loss_percent: 3, tp_index: 1, symbol_suffix: "", symbol_map: {}, allowed_symbols: [],
  };

  // 64-bit FNV-1a → 16 hex chars: deterministic id, so re-sending the same analysis can never create a second order
  function eidFor(clientId) {
    let h = 0xcbf29ce484222325n;
    for (const ch of String(clientId)) { h ^= BigInt(ch.codePointAt(0)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
    return h.toString(16).padStart(16, "0");
  }

  function inboxDoc(payload, action, nowSec) {
    const id = eidFor(payload.client_signal_id);
    const expires = payload.generated_at + (payload.valid_for_sec || 900);
    const sig = { ...payload, expires_at: expires };
    delete sig.valid_for_sec;
    return { execution_id: id, action, tag: "FA:" + id, created_at: nowSec, expires_at: expires, signal: sig };
  }

  function cleanSettings(s) {
    const o = { ...DEFAULT_SETTINGS, ...(s || {}) };
    const num = (v, lo, hi, d) => { const n = +v; return isFinite(n) && n >= lo && n <= hi ? n : d; };
    return {
      risk_percent: num(o.risk_percent, 0.01, 5, 0.5), fixed_lot: o.fixed_lot ? num(o.fixed_lot, 0, 100, null) : null,
      max_lot: num(o.max_lot, 0.01, 100, 0.1), max_spread_points: Math.round(num(o.max_spread_points, 0, 100000, 0)),
      max_spread_sl_ratio: num(o.max_spread_sl_ratio, 0, 1, 0.2), max_entry_dev_sl_ratio: num(o.max_entry_dev_sl_ratio, 0, 1, 0.25),
      max_open_positions: Math.round(num(o.max_open_positions, 1, 50, 3)), max_daily_loss_percent: num(o.max_daily_loss_percent, 0, 50, 3),
      tp_index: [1, 2, 3].includes(+o.tp_index) ? +o.tp_index : 1, symbol_suffix: String(o.symbol_suffix || "").slice(0, 12),
      symbol_map: o.symbol_map && typeof o.symbol_map === "object" ? o.symbol_map : {}, allowed_symbols: Array.isArray(o.allowed_symbols) ? o.allowed_symbols : [],
    };
  }

  function configDoc(local, nowSec) {
    return {
      version: 1, updated_at: nowSec, enabled: !!local.enabled, mode: local.mode || "notify",
      live_enabled: !!local.live_enabled, live_login: local.live_enabled ? String(local.live_login || "") : "",
      settings: cleanSettings(local.settings),
    };
  }

  function statusView(st, nowSec) {
    if (!st || !st.time) return { connected: false, seen: null };
    const tol = Math.max(15, 4 * (+st.poll_seconds || 3));
    return { connected: nowSec - st.time <= tol, seen: st.time, ...st };
  }

  /** Merge EA result files into the local execution list (returns true if anything changed). */
  function applyOutbox(list, docs) {
    let changed = false;
    for (const d of docs) {
      const e = d && list.find((x) => x.id === d.id);
      if (!e || !d.report) continue;
      if (d.kind === "close") {
        if (!e.close) { e.close = { ...d.report, time: d.time }; changed = true; }
        continue;
      }
      if (e.result_time && e.result_time >= d.time) continue;
      const r = d.report;
      e.state = r.state; e.reason = r.reason || ""; e.result_time = d.time;
      for (const k of ["broker_symbol", "requested_price", "fill_price", "volume", "sl", "tp", "ticket", "retcode"]) if (r[k] != null) e[k] = r[k];
      changed = true;
    }
    return changed;
  }

  /* folder helpers — work with any FileSystemDirectoryHandle-like object */
  async function bridgeDirs(root) {
    const b = await root.getDirectoryHandle(DIR_NAME, { create: true });
    return { bridge: b, inbox: await b.getDirectoryHandle("inbox", { create: true }), outbox: await b.getDirectoryHandle("outbox", { create: true }) };
  }
  async function writeJson(dir, name, obj) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();       // written to a temp file and swapped in on close → never half-written
    await w.write(JSON.stringify(obj));
    await w.close();
  }
  async function readJson(dir, name) {
    try { const f = await (await dir.getFileHandle(name)).getFile(); return JSON.parse(await f.text()); }
    catch (e) { return null; }
  }
  async function listJson(dir) {
    const out = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== "file" || !/^[0-9a-f]{16}(\.close)?\.json$/.test(name)) continue;
      try { out.push(JSON.parse(await (await h.getFile()).text())); } catch (e) { /* being written */ }
    }
    return out;
  }
  async function exists(dir, name) { try { await dir.getFileHandle(name); return true; } catch (e) { return false; } }

  FA.mt5 = {
    buildPayload, clientSignalId, normalizeBase, makeClient, TTL_BY_TF, STATE_FA, MODE_FA,
    direct: { DIR_NAME, DEFAULT_SETTINGS, eidFor, inboxDoc, configDoc, cleanSettings, statusView, applyOutbox, bridgeDirs, writeJson, readJson, listJson, exists },
  };


  /* ------------------------------------------------------------ UI (browser only) */
  if (typeof document === "undefined") return;

  const D = FA.mt5.direct;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const nowS = () => Math.floor(Date.now() / 1000);
  const ago = (ts) => { if (!ts) return "هرگز"; const s = Math.max(0, nowS() - ts); return s < 60 ? s + " ثانیه پیش" : s < 3600 ? Math.floor(s / 60) + " دقیقه پیش" : new Date(ts * 1000).toLocaleString("fa-IR", { hour12: false }); };
  const fx = (x) => (x == null || x === "" ? "—" : String(+(+x).toPrecision(8)));
  const canPick = typeof g.showDirectoryPicker === "function";

  const M = {
    cfg: Object.assign({ url: "", key: "", autoSend: false, link: "direct" }, load("fa_mt5", {})),
    // direct-mode connection settings (written to config.json for the EA)
    local: Object.assign({ enabled: true, mode: "notify", live_enabled: false, live_login: "", settings: { ...D.DEFAULT_SETTINGS } }, load("fa_mt5_local", {})),
    list: load("fa_mt5_list", []),          // direct-mode signals sent to MT5 and their results
    last: null, sentIds: load("fa_mt5_sent", []), accounts: [], executions: [], newKey: null, err: "", busy: false,
    dir: null, dirs: null, dirState: canPick ? "none" : "unsupported", status: null, dirName: "", polling: false,
  };
  const saveLocal = () => save("fa_mt5_local", M.local);
  const saveList = () => { M.list = M.list.slice(0, 150); save("fa_mt5_list", M.list); };
  const api = () => {
    const n = normalizeBase(M.cfg.url);
    if (n.error) throw new Error(n.error);
    if (!M.cfg.key) throw new Error("کلید API وب‌اپ را وارد کنید.");
    return makeClient(n.base, M.cfg.key);
  };
  const serverReady = () => !!(M.cfg.url && M.cfg.key);
  const linkReady = () => (M.cfg.link === "server" ? serverReady() : M.dirState === "ready");
  const toast = (msg, kind) => {
    const wrap = $("#toasts"); if (!wrap) return;
    const d = document.createElement("div"); d.className = "toast " + (kind || "info"); d.innerHTML = msg; wrap.append(d);
    setTimeout(() => d.remove(), 6000);
  };

  /* ---------- folder handle persistence (IndexedDB) ---------- */
  function idb(op, val) {
    return new Promise((resolve) => {
      try {
        const rq = indexedDB.open("fa_mt5", 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore("kv");
        rq.onerror = () => resolve(null);
        rq.onsuccess = () => {
          const tx = rq.result.transaction("kv", op === "get" ? "readonly" : "readwrite"), st = tx.objectStore("kv");
          const r = op === "get" ? st.get("dir") : op === "put" ? st.put(val, "dir") : st.delete("dir");
          r.onsuccess = () => resolve(op === "get" ? r.result || null : true);
          r.onerror = () => resolve(null);
        };
      } catch (e) { resolve(null); }
    });
  }

  async function activateDir(handle) {
    M.dir = handle; M.dirName = handle.name;
    M.dirs = await D.bridgeDirs(handle);
    M.dirState = "ready";
    await writeConfig();
    await pollDirect();
  }

  async function restoreDir() {
    if (!canPick) return;
    const h = await idb("get");
    if (!h) return;
    M.dir = h; M.dirName = h.name;
    try {
      const p = await h.queryPermission({ mode: "readwrite" });
      if (p === "granted") await activateDir(h); else M.dirState = "permission";
    } catch (e) { M.dirState = "permission"; }
    render(); paintBar();
  }

  async function pickDir() {
    try {
      const h = await g.showDirectoryPicker({ id: "fa-mt5-common", mode: "readwrite" });
      if (h.name !== "Files" && !confirm(`پوشه‌ی انتخاب‌شده «${h.name}» است، نه «Files». پوشه‌ی درست معمولاً این است:\n...\\MetaQuotes\\Terminal\\Common\\Files\n\nبا همین پوشه ادامه می‌دهید؟`)) return;
      await idb("put", h);
      await activateDir(h);
      toast("پوشه وصل شد. حالا اکسپرت را در متاتریدر اجرا کنید (اگر اجرا نیست).", "info");
    } catch (e) {
      if (e && e.name === "AbortError") return;
      toast("انتخاب پوشه ممکن نشد: " + esc(e.message || e), "err");
    }
    render(); paintBar();
  }

  async function regrant() {
    try {
      const p = await M.dir.requestPermission({ mode: "readwrite" });
      if (p === "granted") await activateDir(M.dir);
    } catch (e) { toast("اجازه داده نشد: " + esc(e.message), "err"); }
    render(); paintBar();
  }

  async function writeConfig() {
    if (M.dirState !== "ready") return;
    try { await D.writeJson(M.dirs.bridge, "config.json", D.configDoc(M.local, nowS())); }
    catch (e) { dirFailed(e); }
  }

  function dirFailed(e) {
    if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) M.dirState = "permission";
    else if (e && e.name === "NotFoundError") M.dirState = "none";
    M.err = "خطا در دسترسی به پوشه: " + (e && e.message ? e.message : e);
    render(); paintBar();
  }

  /** One sync cycle with the EA: read status + results, expire stale queued signals. */
  async function pollDirect() {
    if (M.dirState !== "ready" || M.polling) return;
    M.polling = true;
    try {
      M.status = await D.readJson(M.dirs.bridge, "status.json");
      const docs = await D.listJson(M.dirs.outbox);
      let changed = D.applyOutbox(M.list, docs);
      const t = nowS();
      for (const e of M.list) {
        if ((e.state === "awaiting_approval" || e.state === "queued") && e.expires_at <= t) {
          if (e.state === "queued") {
            if (!(await D.exists(M.dirs.inbox, e.id + ".json"))) continue;   // the EA already took it; its result will arrive
            try { await M.dirs.inbox.removeEntry(e.id + ".json"); } catch (er) { continue; }
          }
          e.state = "expired"; e.reason = "سیگنال قبل از اجرا منقضی شد"; changed = true;
        }
      }
      if (changed) saveList();
      M.err = "";
    } catch (e) { dirFailed(e); }
    finally { M.polling = false; }
    const st = D.statusView(M.status, nowS());
    const sig = [M.dirState, st.connected, st.login, st.trade_mode, st.balance, st.equity, st.trade_allowed, M.err,
      M.list.map((e) => e.id + e.state + (e.close ? "c" : "")).join()].join("|");
    if (sig !== M.lastSig) { M.lastSig = sig; render(true); paintBar(); }
  }

  async function queueDirect(entry) {
    const doc = D.inboxDoc(entry.payload, entry.action, nowS());
    await D.writeJson(M.dirs.inbox, doc.execution_id + ".json", doc);
    entry.state = "queued"; entry.reason = "";
  }

  /* ---------- sending ---------- */
  async function send(auto) {
    if (!M.last) { toast("اول «تحلیل کن» را بزنید.", "err"); return; }
    const { res, sym, tf, at } = M.last;
    const b = buildPayload(res, sym, tf, at);
    if (b.error) { if (!auto) toast(esc(b.error), "err"); return; }
    if (!auto && !res.tradeable && !confirm("امتیاز هم‌سویی این سیگنال به حد «سیگنال معتبر» نرسیده است. باز هم به MT5 ارسال شود؟")) return;
    const remember = () => { M.sentIds = [b.payload.client_signal_id, ...M.sentIds.filter((x) => x !== b.payload.client_signal_id)].slice(0, 50); save("fa_mt5_sent", M.sentIds); };
    if (M.cfg.link === "server") {
      try {
        const r = await api()("POST", "/api/v1/signals", b.payload);
        remember();
        const n = (r.signal.executions || []).length;
        toast(r.created ? `سیگنال ${esc(sym.name)} به ${n} اتصال MT5 ارسال شد.` : "این سیگنال قبلاً ارسال شده بود (ارسال تکراری انجام نشد).", "info");
        paintBar(); refresh();
      } catch (e) {
        toast("ارسال به MT5 ناموفق: " + esc(e.message) + (e.code === "stale_signal" ? " — دوباره «تحلیل کن» را بزنید." : ""), "err");
      }
      return;
    }
    // direct mode
    if (M.dirState !== "ready") { toast("اول در تب MT5 پوشه‌ی متاتریدر را انتخاب کنید.", "err"); return; }
    if (!M.local.enabled) { toast("اتصال MT5 در تب MT5 غیرفعال است.", "err"); return; }
    const id = D.eidFor(b.payload.client_signal_id);
    if (M.list.some((x) => x.id === id)) { remember(); paintBar(); if (!auto) toast("این سیگنال قبلاً ارسال شده بود (ارسال تکراری انجام نشد).", "info"); return; }
    const p = b.payload, exp = p.generated_at + p.valid_for_sec;
    if (exp <= nowS()) { toast("این تحلیل قدیمی شده؛ دوباره «تحلیل کن» را بزنید.", "err"); return; }
    const entry = { id, cid: p.client_signal_id, payload: p, symbol: p.symbol, direction: p.direction, action: M.local.mode === "notify" ? "notify" : "execute",
      state: "awaiting_approval", reason: "", created_at: nowS(), expires_at: exp };
    try {
      if (M.local.mode !== "confirm") await queueDirect(entry);
      M.list.unshift(entry); saveList(); remember();
      toast(M.local.mode === "confirm" ? `سیگنال ${esc(sym.name)} منتظر تأیید شما در تب MT5 است.` : `سیگنال ${esc(sym.name)} به متاتریدر فرستاده شد.`, "info");
    } catch (e) { dirFailed(e); toast("نوشتن در پوشه‌ی متاتریدر ممکن نشد: " + esc(e.message), "err"); }
    paintBar(); render();
  }

  function paintBar() {
    const box = $("#signalBox"); if (!box || !M.last) return;
    let bar = $("#mt5Bar");
    if (!bar) { bar = document.createElement("div"); bar.id = "mt5Bar"; bar.className = "mt5bar"; box.append(bar); }
    const b = buildPayload(M.last.res, M.last.sym, M.last.tf, M.last.at);
    if (b.error) { bar.innerHTML = `<span class="hint">MT5: ${esc(b.error)}</span>`; return; }
    const sent = M.sentIds.includes(b.payload.client_signal_id);
    bar.innerHTML = linkReady()
      ? `<button class="btn ${sent ? "ghost" : "primary"}" id="btnMt5Send">${sent ? "✓ ارسال شد به MT5" : "ارسال این سیگنال به MT5"}</button>
         <span class="hint">${M.cfg.autoSend ? "ارسال خودکار سیگنال‌های معتبر روشن است" : ""}</span>`
      : `<span class="hint">برای ارسال به متاتریدر، تب «MT5» را تنظیم کنید.</span>`;
    const btn = $("#btnMt5Send"); if (btn) btn.onclick = () => send(false);
  }

  function onAnalysis(ev) {
    M.last = { ...ev.detail, at: Date.now() };
    paintBar();
    if (M.cfg.autoSend && linkReady() && M.last.res && M.last.res.tradeable) {
      const b = buildPayload(M.last.res, M.last.sym, M.last.tf, M.last.at);
      if (!b.error && !M.sentIds.includes(b.payload.client_signal_id)) send(true);
    }
  }

  /* ---------- server mode data ---------- */
  async function refresh() {
    if (M.cfg.link !== "server") return pollDirect();
    const pane = $("#r-mt5"); if (!pane || !pane.classList.contains("on") || !serverReady() || M.busy) return;
    M.busy = true;
    try {
      const c = api();
      const [a, e] = await Promise.all([c("GET", "/api/v1/accounts"), c("GET", "/api/v1/executions?limit=40")]);
      M.accounts = a.accounts; M.executions = e.executions; M.err = "";
    } catch (e) { M.err = e.message; }
    finally { M.busy = false; }
    render();
  }

  /* ---------- rendering ---------- */
  function settingsForm(id, s) {
    const f = (k, label, attrs) => `<label>${label}<input data-k="${k}" value="${esc(s[k] == null ? "" : s[k])}" ${attrs || ""}></label>`;
    return `<details class="mt5set"><summary>تنظیمات ریسک و نماد</summary><div class="mt5grid">
      ${f("risk_percent", "ریسک هر معامله (% موجودی)", 'type="number" step="0.1" min="0.1" max="5"')}
      ${f("fixed_lot", "لات ثابت (خالی = از روی ریسک)", 'type="number" step="0.01" min="0"')}
      ${f("max_lot", "حداکثر لات", 'type="number" step="0.01" min="0.01"')}
      ${f("max_open_positions", "حداکثر پوزیشن باز هم‌زمان", 'type="number" min="1" max="50"')}
      ${f("max_daily_loss_percent", "حد ضرر روزانه (% موجودی)", 'type="number" step="0.5" min="0"')}
      ${f("max_spread_points", "حداکثر اسپرد (پوینت؛ ۰ = خاموش)", 'type="number" min="0"')}
      ${f("max_spread_sl_ratio", "حداکثر اسپرد نسبت به فاصله‌ی حد ضرر", 'type="number" step="0.05" min="0" max="1"')}
      ${f("max_entry_dev_sl_ratio", "حداکثر فاصله‌ی قیمت از نقطه‌ی ورود (نسبت به حد ضرر)", 'type="number" step="0.05" min="0" max="1"')}
      <label>تارگت مورد استفاده<select data-k="tp_index">${[1, 2, 3].map((i) => `<option value="${i}" ${+s.tp_index === i ? "selected" : ""}>تارگت ${i}</option>`).join("")}</select></label>
      ${f("symbol_suffix", "پسوند نماد بروکر (مثلاً .m)", 'dir="ltr" maxlength="12"')}
      <label class="wide">نگاشت نماد (JSON) <small>مثلاً {"SPX":"US500","BTCUSDT":"BTCUSD"}</small><input data-k="symbol_map" dir="ltr" value="${esc(JSON.stringify(s.symbol_map || {}))}"></label>
      </div><div class="row"><button class="btn primary" data-act="save" data-id="${id}">ذخیره‌ی تنظیمات</button></div></details>`;
  }

  function readSettingsForm(el) {
    const card = el.closest(".mt5set"), body = {};
    for (const inp of card.querySelectorAll("[data-k]")) {
      const k = inp.dataset.k, v = inp.value.trim();
      if (k === "symbol_map") { try { body[k] = v ? JSON.parse(v) : {}; } catch (e) { throw new Error("نگاشت نماد باید JSON معتبر باشد."); } }
      else if (k === "symbol_suffix") body[k] = v;
      else if (k === "fixed_lot") body[k] = v === "" ? 0 : +v;
      else if (v !== "") body[k] = +v;
    }
    return body;
  }

  const modeSelect = (id, mode) => `<select data-act="mode" data-id="${id}">${Object.entries(MODE_FA).map(([k, v]) => `<option value="${k}" ${mode === k ? "selected" : ""}>${v}</option>`).join("")}</select>`;
  const stateCls = (s) => (["filled", "placed", "displayed"].includes(s) ? "win" : ["rejected", "failed", "expired", "cancelled", "unknown"].includes(s) ? "loss" : "");

  function rowsTable(rows) {
    if (!rows.length) return `<div class="empty">هنوز سیگنالی به MT5 ارسال نشده.</div>`;
    return `<table class="btable mt5ex"><tr><th>زمان</th><th>نماد</th><th>جهت</th>${rows[0].acct !== undefined ? "<th>حساب</th>" : ""}<th>وضعیت</th><th>اجرا</th><th></th></tr>` +
      rows.map((r) => {
        const exec = r.fill_price ? `${fx(r.fill_price)} × ${fx(r.volume)}${r.ticket ? " #" + esc(r.ticket) : ""}` : r.ticket ? "#" + esc(r.ticket) : "—";
        const pl = r.closed ? `<br><span class="${r.profit >= 0 ? "win" : "loss"}">بسته شد (${esc(r.close_reason || "")}) ${fx(r.profit)}</span>` : r.open ? "<br><span class='hint'>پوزیشن باز</span>" : "";
        return `<tr><td>${new Date(r.created_at * 1000).toLocaleTimeString("fa-IR", { hour12: false })}</td><td>${esc(r.symbol)}</td>
          <td class="${r.direction === "buy" ? "win" : "loss"}">${r.direction === "buy" ? "خرید" : "فروش"}</td>${r.acct !== undefined ? `<td>${esc(r.acct)}</td>` : ""}
          <td class="${stateCls(r.state)}">${esc(STATE_FA[r.state] || r.state)}${r.reason ? `<br><small class="hint">${esc(r.reason)}</small>` : ""}</td>
          <td>${exec}${pl}</td><td>${r.actions || ""}</td></tr>`;
      }).join("") + "</table>";
  }

  function serverRows() {
    const accName = (id) => (M.accounts.find((a) => a.id === id) || {}).name || id.slice(0, 6);
    return M.executions.map((e) => {
      const s = e.signal || {};
      const actions = e.state === "awaiting_approval"
        ? `<button class="btn primary" data-act="approve" data-id="${e.id}">تأیید</button> <button class="btn ghost" data-act="reject" data-id="${e.id}">رد</button>`
        : ["pending", "approved", "delivered"].includes(e.state) ? `<button class="btn ghost" data-act="reject" data-id="${e.id}">لغو</button>` : "";
      return { created_at: e.created_at, symbol: e.broker_symbol || s.symbol, direction: s.direction, acct: accName(e.account_id), state: e.state, reason: e.reason,
        fill_price: e.fill_price, volume: e.volume, ticket: e.ticket, closed: e.position_status === "closed", open: e.position_status === "open",
        profit: e.profit, close_reason: e.close_reason, actions };
    });
  }

  function directRows() {
    return M.list.map((e) => ({
      created_at: e.created_at, symbol: e.broker_symbol || e.symbol, direction: e.direction, state: e.state, reason: e.reason,
      fill_price: e.fill_price, volume: e.volume, ticket: e.ticket, closed: !!e.close, open: e.state === "filled" && !e.close,
      profit: e.close && e.close.profit, close_reason: e.close && e.close.close_reason,
      actions: e.state === "awaiting_approval" ? `<button class="btn primary" data-act="d-approve" data-id="${e.id}">تأیید</button> <button class="btn ghost" data-act="d-reject" data-id="${e.id}">رد</button>`
        : e.state === "queued" ? `<button class="btn ghost" data-act="d-cancel" data-id="${e.id}">لغو</button>` : "",
    }));
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
        ${modeSelect(a.id, a.mode)}
      </div>
      <div class="row">
        <span class="hint">معامله‌ی واقعی: <b class="${a.live_enabled ? "loss" : ""}">${a.live_enabled ? "فعال" : "غیرفعال"}</b></span>
        <button class="btn ghost" data-act="${a.live_enabled ? "live-off" : "live-on"}" data-id="${a.id}">${a.live_enabled ? "غیرفعال کردن معامله‌ی واقعی" : "فعال‌سازی معامله‌ی واقعی…"}</button>
        <button class="btn ghost" data-act="rotate" data-id="${a.id}" title="کلید قبلی بلافاصله باطل می‌شود">کلید جدید ترمینال</button>
        ${t.login ? `<button class="btn ghost" data-act="unbind" data-id="${a.id}" title="برای وصل کردن همین کلید به حساب MT5 دیگر">جداکردن حساب</button>` : ""}
      </div>
      ${settingsForm(a.id, a.settings)}
    </div>`;
  }

  function renderServer() {
    const keyBox = M.newKey ? `<div class="warn mt5key"><b>کلید ترمینال (فقط همین یک بار نمایش داده می‌شود):</b><code dir="ltr">${esc(M.newKey)}</code>
        <div class="row"><button class="btn ghost" data-act="copykey">کپی</button><button class="btn ghost" data-act="hidekey">کپی کردم، پنهان کن</button></div>
        <div class="hint">این کلید را در ورودی InpTerminalKey اکسپرت بچسبانید و InpLink را روی «Through the bridge server» بگذارید.</div></div>` : "";
    return `
      <p class="hint">این حالت فقط وقتی لازم است که متاتریدر روی کامپیوتر دیگری (مثلاً VPS) باشد و یک سرور پل (پوشه‌ی <code>server/</code>) راه انداخته باشید.</p>
      <details ${serverReady() ? "" : "open"} class="mt5set"><summary>اتصال به سرور پل</summary>
        <label>آدرس سرور<input id="mt5Url" dir="ltr" placeholder="https://bridge.example.com" value="${esc(M.cfg.url)}"></label>
        <label>کلید API وب‌اپ <small>(fa_u_… — از ادمین سرور)</small><input id="mt5Key" type="password" dir="ltr" autocomplete="off" value="${esc(M.cfg.key)}"></label>
        <div class="row"><button class="btn primary" data-act="savecfg">ذخیره و آزمایش اتصال</button><button class="btn ghost" data-act="clearcfg">پاک کردن</button></div>
        <p class="warn">کلید فقط در مرورگر همین دستگاه ذخیره می‌شود.</p>
      </details>
      ${serverReady() ? `
      ${keyBox}
      <h4>اتصال‌های متاتریدر</h4>
      ${M.accounts.map(accountCard).join("") || `<div class="empty">هنوز اتصالی ساخته نشده.</div>`}
      <div class="row"><input id="mt5NewName" placeholder="نام اتصال (مثلاً دمو آلپاری)" maxlength="60"><button class="btn primary" data-act="create">ساخت اتصال جدید</button></div>
      <h4>سیگنال‌های ارسالی و نتیجه‌ی سفارش‌ها <button class="btn ghost" data-act="refresh">↻</button></h4>
      ${rowsTable(serverRows())}` : ""}`;
  }

  function renderDirect() {
    if (M.dirState === "unsupported") return `<div class="warn">اتصال مستقیم فقط در <b>Chrome</b> یا <b>Edge</b> روی <b>کامپیوتر</b> (ویندوز) کار می‌کند؛ همان کامپیوتری که متاتریدر روی آن نصب است. این مرورگر/دستگاه از دسترسی به پوشه پشتیبانی نمی‌کند.</div>`;
    const st = D.statusView(M.status, nowS()), L = M.local;
    const guide = `<details class="mt5set" ${M.dirState === "ready" ? "" : "open"}><summary>راهنمای اتصال (یک‌بار)</summary><ol class="mt5steps">
        <li>فایل اکسپرت <code>FandamentalBridge.mq5</code> را از <a href="https://github.com/vsajjadx/fandamental/blob/main/mt5/FandamentalBridge.mq5" target="_blank" rel="noopener">این‌جا</a> دانلود کنید، در متاتریدر از منوی <b>File → Open Data Folder</b> در پوشه‌ی <code>MQL5\\Experts</code> بگذارید و در MetaEditor با <b>F7</b> کامپایل کنید.</li>
        <li>اکسپرت را روی یک چارت بکشید (تنظیمات پیش‌فرض کافی است؛ حالت اتصال: Direct). برای ثبت سفارش، دکمه‌ی <b>Algo Trading</b> را روشن کنید.</li>
        <li>این‌جا «انتخاب پوشه‌ی متاتریدر» را بزنید و پوشه‌ی <b>Common\\Files</b> را انتخاب کنید. سریع‌ترین راه: در نوار آدرس پنجره این را بچسبانید و Enter بزنید:<br><code dir="ltr">%APPDATA%\\MetaQuotes\\Terminal\\Common\\Files</code></li>
        <li>اگر مرورگر پرسید، اجازه‌ی «ویرایش فایل‌ها» را بدهید. تمام — وضعیت باید «● متصل» شود.</li>
      </ol></details>`;
    let folder;
    if (M.dirState === "ready") folder = `<span class="badge ok">✓ پوشه: ${esc(M.dirName)}</span> <button class="btn ghost" data-act="pick">تغییر پوشه</button>`;
    else if (M.dirState === "permission") folder = `<span class="badge wait">مرورگر دوباره اجازه می‌خواهد</span> <button class="btn primary" data-act="regrant">اجازه‌ی دسترسی به پوشه‌ی ${esc(M.dirName)}</button>`;
    else folder = `<button class="btn primary" data-act="pick">انتخاب پوشه‌ی متاتریدر (Common\\Files)</button>`;
    let ea = "";
    if (M.dirState === "ready") {
      if (st.connected) {
        const real = st.trade_mode !== "demo";
        ea = `<div class="mt5acc"><div class="mt5head"><b>متاتریدر</b> <span class="badge ok">● متصل</span> <span class="hint">آخرین ارتباط: ${ago(st.seen)}</span></div>
          <div class="hint">${esc(st.company || "")} · ${esc(st.server || "")} · #${esc(st.login)} · <b class="${real ? "loss" : ""}">${st.trade_mode === "demo" ? "دمو" : st.trade_mode === "real" ? "واقعی" : esc(st.trade_mode)}</b> · موجودی ${fx(st.balance)} ${esc(st.currency || "")} · اکوئیتی ${fx(st.equity)} · EA v${esc(st.ea_version)}</div>
          ${!st.connected_to_broker ? `<div class="warn">متاتریدر به سرور بروکر وصل نیست.</div>` : ""}
          ${L.mode !== "notify" && !st.trade_allowed ? `<div class="warn">دکمه‌ی Algo Trading در متاتریدر خاموش است؛ سفارشی ثبت نمی‌شود.</div>` : ""}
          ${L.mode !== "notify" && st.execution_enabled === false ? `<div class="warn">در تنظیمات اکسپرت InpExecutionEnabled خاموش است؛ سفارشی ثبت نمی‌شود.</div>` : ""}</div>`;
      } else {
        ea = `<div class="mt5acc off"><div class="mt5head"><b>متاتریدر</b> <span class="badge wait">○ ${st.seen ? "قطع" : "منتظر اکسپرت"}</span> <span class="hint">آخرین ارتباط: ${ago(st.seen)}</span></div>
          <div class="hint">${st.seen ? "اکسپرت پاسخ نمی‌دهد؛ متاتریدر باز است و اکسپرت روی چارت است؟" : "اکسپرت FandamentalBridge را در متاتریدر روی یک چارت اجرا کنید. اگر اجراست، مطمئن شوید پوشه‌ی انتخاب‌شده دقیقاً Common\\Files است (نه MQL5\\Files)."}</div></div>`;
      }
    }
    const real = st.connected && st.trade_mode && st.trade_mode !== "demo";
    const controls = M.dirState === "ready" ? `
      <div class="row">
        <label class="hint"><input type="checkbox" data-act="d-enabled" ${L.enabled ? "checked" : ""}> اتصال فعال</label>
        ${modeSelect("local", L.mode)}
      </div>
      <div class="row">
        <span class="hint">معامله‌ی واقعی: <b class="${L.live_enabled ? "loss" : ""}">${L.live_enabled ? "فعال برای حساب #" + esc(L.live_login) : "غیرفعال"}</b>${real && !L.live_enabled ? " — روی این حساب واقعی فقط نمایش انجام می‌شود" : ""}</span>
        <button class="btn ghost" data-act="${L.live_enabled ? "d-live-off" : "d-live-on"}">${L.live_enabled ? "غیرفعال کردن معامله‌ی واقعی" : "فعال‌سازی معامله‌ی واقعی…"}</button>
      </div>
      ${settingsForm("local", L.settings)}
      <label class="hint"><input type="checkbox" id="mt5Auto" ${M.cfg.autoSend ? "checked" : ""}> ارسال خودکار «سیگنال‌های معتبر» به MT5 بعد از هر تحلیل</label>
      <div class="hint">برای اجرای خودکار، این صفحه باید باز بماند و «به‌روزرسانی خودکار (۶۰ث)» بالای چارت روشن باشد؛ سیگنال‌ها در همین مرورگر ساخته می‌شوند.</div>
      <h4>سیگنال‌های ارسالی و نتیجه‌ی سفارش‌ها</h4>
      ${rowsTable(directRows())}
      ${M.list.length ? `<div class="row"><button class="btn ghost" data-act="d-clear">پاک کردن تاریخچه‌ی نمایش</button></div>` : ""}` : "";
    return `<p class="hint">بدون سرور: وب‌اپ و متاتریدر روی <b>همین کامپیوتر</b>، از طریق پوشه‌ی مشترک متاتریدر با هم حرف می‌زنند. پیش‌فرض «فقط نمایش» است و معامله‌ی واقعی بدون فعال‌سازی صریح شما انجام نمی‌شود. اول روی حساب <b>دمو</b> امتحان کنید.</p>
      ${guide}<div class="row">${folder}</div>${ea}${controls}`;
  }

  function render(fromPoll) {
    const pane = $("#r-mt5"); if (!pane) return;
    const isServer = M.cfg.link === "server";
    // keep open/closed panels and typed-but-unsaved inputs across re-renders
    const openSet = new Set([...pane.querySelectorAll("details")].map((d) => (d.open ? "o:" : "c:") + (d.querySelector("summary") || {}).textContent));
    if (fromPoll && pane.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) { M.lastSig = null; return; }
    pane.innerHTML = `
      <div class="seg mt5seg" role="group" dir="rtl"><button data-act="link" data-id="direct" class="${isServer ? "" : "on"}">اتصال مستقیم (بدون سرور)</button><button data-act="link" data-id="server" class="${isServer ? "on" : ""}">از طریق سرور (پیشرفته)</button></div>
      ${M.err ? `<div class="warn">${esc(M.err)}</div>` : ""}
      ${isServer ? renderServer() : renderDirect()}`;
    pane.querySelectorAll("details").forEach((d) => {
      const k = (d.querySelector("summary") || {}).textContent;
      if (openSet.has("o:" + k)) d.open = true; else if (openSet.has("c:" + k)) d.open = false;
    });
  }

  /* ---------- actions ---------- */
  async function act(el) {
    const a = el.dataset.act, id = el.dataset.id;
    try {
      if (a === "link") { M.cfg.link = id; save("fa_mt5", M.cfg); M.err = ""; paintBar(); render(); return refresh(); }
      if (a === "pick") return pickDir();
      if (a === "regrant") return regrant();
      if (id === "local" && a === "save") {
        M.local.settings = D.cleanSettings({ ...M.local.settings, ...readSettingsForm(el) }); saveLocal(); await writeConfig();
        toast("تنظیمات ذخیره و برای اکسپرت فرستاده شد.", "info"); return render();
      }
      if (a === "d-live-on") {
        const st = D.statusView(M.status, nowS());
        if (!st.connected || !st.login) { toast("اول اکسپرت باید متصل باشد تا شماره‌ی حساب معلوم شود.", "err"); return; }
        const phrase = `ENABLE LIVE ${st.login}`;
        const typed = prompt(`هشدار: با این کار، سیگنال‌ها روی حساب واقعی #${st.login} با پول واقعی اجرا می‌شوند و ممکن است ضرر کنید.\nهیچ سیستمی سود را تضمین نمی‌کند.\nدر اکسپرت هم باید AllowRealAccount=true باشد.\n\nبرای تأیید دقیقاً بنویسید:\n${phrase}`);
        if (typed === null) return;
        if (typed.trim() !== phrase) { toast("عبارت تأیید درست نبود؛ معامله‌ی واقعی فعال نشد.", "err"); return; }
        M.local.live_enabled = true; M.local.live_login = String(st.login); saveLocal(); await writeConfig();
        toast("معامله‌ی واقعی برای حساب #" + esc(st.login) + " فعال شد.", "info"); return render();
      }
      if (a === "d-live-off") { M.local.live_enabled = false; M.local.live_login = ""; saveLocal(); await writeConfig(); return render(); }
      if (a === "d-approve" || a === "d-reject" || a === "d-cancel") {
        const e = M.list.find((x) => x.id === id); if (!e) return;
        if (a === "d-approve") {
          if (e.state !== "awaiting_approval") return;
          if (e.expires_at <= nowS()) { e.state = "expired"; e.reason = "سیگنال قبل از تأیید منقضی شد"; }
          else await queueDirect(e);
        } else if (a === "d-reject") { if (e.state === "awaiting_approval") { e.state = "cancelled"; e.reason = "رد شد توسط شما"; } }
        else if (e.state === "queued") {
          if (await D.exists(M.dirs.inbox, id + ".json")) { await M.dirs.inbox.removeEntry(id + ".json"); e.state = "cancelled"; e.reason = "لغو شد توسط شما"; }
          else toast("متاتریدر این سیگنال را برداشته است؛ نتیجه به‌زودی نمایش داده می‌شود.", "info");
        }
        saveList(); return render();
      }
      if (a === "d-clear") { if (!confirm("فقط فهرست نمایش‌داده‌شده در این مرورگر پاک می‌شود (روی متاتریدر اثری ندارد). ادامه؟")) return; M.list = M.list.filter((x) => ["awaiting_approval", "queued"].includes(x.state)); saveList(); return render(); }

      // ---- server mode
      if (a === "savecfg") {
        const n = normalizeBase($("#mt5Url").value);
        if (n.error) { toast(esc(n.error), "err"); return; }
        M.cfg = { ...M.cfg, url: n.base, key: $("#mt5Key").value.trim() }; save("fa_mt5", M.cfg);
        const me = await api()("GET", "/api/v1/me");
        toast(`اتصال برقرار شد (کاربر: ${esc(me.user.name)}).`, "info"); paintBar(); return refresh();
      }
      if (a === "clearcfg") { M.cfg = { ...M.cfg, url: "", key: "" }; save("fa_mt5", M.cfg); M.accounts = []; M.executions = []; paintBar(); return render(); }
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
        await c("PATCH", `/api/v1/accounts/${id}`, readSettingsForm(el));
        toast("تنظیمات ذخیره شد.", "info");
      }
      await refresh();
    } catch (e) { toast(esc(e.message), "err"); }
  }

  const MODE_WARN = {
    auto: "در حالت «اجرای خودکار» اکسپرت بدون پرسیدن سفارش ثبت می‌کند (روی حساب واقعی فقط اگر معامله‌ی واقعی را جداگانه فعال کرده باشید). ادامه؟",
    confirm: "در این حالت هر سیگنال بعد از تأیید شما در همین صفحه اجرا می‌شود. ادامه؟",
  };
  async function change(el) {
    const a = el.dataset.act, id = el.dataset.id;
    try {
      if (el.id === "mt5Auto") { M.cfg.autoSend = el.checked; save("fa_mt5", M.cfg); paintBar(); return; }
      if (a === "mode" && el.value !== "notify" && !confirm(MODE_WARN[el.value])) { render(); return; }
      if (id === "local" && a === "mode") { M.local.mode = el.value; saveLocal(); await writeConfig(); return render(); }
      if (a === "d-enabled") { M.local.enabled = el.checked; saveLocal(); await writeConfig(); paintBar(); return render(); }
      if (a === "mode") await api()("PATCH", `/api/v1/accounts/${id}`, { mode: el.value });
      else if (a === "enabled") await api()("PATCH", `/api/v1/accounts/${id}`, { enabled: el.checked });
      else return;
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
    setInterval(() => { if (M.cfg.link === "server") { if (!document.hidden) refresh(); } else pollDirect(); }, 3000);
    render();
    restoreDir();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})(typeof window !== "undefined" ? window : globalThis);
