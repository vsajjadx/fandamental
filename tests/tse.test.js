// Run: node tests/tse.test.js — Tehran exchange layer on REAL recorded TSETMC responses (tests/fixtures/tsetmc)
require("../js/indicators.js"); require("../js/priceaction.js"); require("../js/signal.js"); require("../js/data.js"); require("../js/tse.js");
const FA = globalThis.FA, T = FA.tse, D = FA.data, fx = (f) => require("./fixtures/tsetmc/" + f);
let fails = 0;
const check = (n, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); if (!c) fails++; };

// ---- symbol list: names and codes
const mw = T.parseMarketWatch(fx("GetMarketWatch.json"));
const by = new Map(mw.map((r) => [r.sym, r]));
const tse = D.SYMBOLS.filter((s) => s.tse);
const inWatch = tse.filter((s) => by.has(s.id.replace("TSE-", "")));
check("built-in Tehran symbols: every code present in the real market watch matches", inWatch.every((s) => by.get(s.id.replace("TSE-", "")).ins === s.tse), `${inWatch.length}/${tse.length} found in the snapshot`);
const flat = (x) => T.norm(x).replace(/[أإ]/g, "ا").replace(/\(.*\)/, "").replace(/[\s\u200c]/g, "").replace(/سرمایهگذاری/g, "");
const nameOk = (s) => { const real = by.get(s.id.replace("TSE-", "")); return !real || flat(real.name).includes(flat(s.name).slice(0, 5)); };
check("built-in names now match the real company names (شستا, غگل, بپاس, شتران, …)", inWatch.filter((s) => !nameOk(s)).length === 0, inWatch.filter((s) => !nameOk(s)).map((s) => s.id + "=" + s.name).join(", "));
check("Arabic letters normalised (ي→ی, ك→ک)", T.norm("فولاد مباركه اصفهان") === "فولاد مبارکه اصفهان" && T.norm("ملي‌ صنايع‌ مس‌") === "ملی‌ صنایع‌ مس‌".replace(/‌\s/g, " ").trim());

// ---- market watch
const fold = by.get("فولاد");
check("market watch parsed (equities + others)", mw.length > 500 && mw.some((r) => r.kind === "stock") && mw.some((r) => r.kind !== "stock"), `${mw.length} rows`);
check("فولاد row: last/close/yesterday, P/E, EPS, base volume, price limits, market cap", fold && fold.last === 4100 && fold.close === 4086 && fold.yday === 3981 && fold.pe === 6.4 && fold.eps === 636
  && fold.baseVol === 29368576 && fold.limitMax === 4100 && fold.limitMin === 3862 && fold.mcap === 1.5e12 * 4086 && fold.isin === "IRO1FOLD0001", JSON.stringify(fold).slice(0, 160));
check("percent change computed from yesterday's price", Math.abs(fold.closePct - (100 * (4086 - 3981)) / 3981) < 1e-9);
check("instrument kinds from ISIN", T.kindOf("IRO1FOLD0001") === "stock" && T.kindOf("IRT1AHRM0001") === "fund" && T.kindOf("IRB3STA007A1") === "bond" && T.kindOf("IRO9AHRM2341") === "option");

// ---- retail / institutional
const ct = T.parseClientTypeAll(fx("GetClientTypeAll.json"));
const one = [...ct.values()][0], m = T.flowMetrics(one, 1000);
check("client type (حقیقی/حقوقی) for every symbol parsed", ct.size > 300, ct.size + " symbols");
check("buyer power = avg retail buy ÷ avg retail sell; net retail = buy − sell", Math.abs(m.buyPower - (one.buyI / one.buyCountI) / (one.sellI / one.sellCountI)) < 1e-12 && m.netRetailValue === (one.buyI - one.sellI) * 1000);
const hist = T.parseClientHistory(fx("GetClientTypeHistory.json"));
check("client-type history parsed, sorted by day, with values", hist.length >= 5 && hist.every((h, k) => !k || h.t > hist[k - 1].t) && hist[0].buyIValue > 0);
const cand = hist.map((h) => ({ t: h.t, o: 1, h: 1, l: 1, c: 1, v: 1 }));
const att = T.attachFlow(cand.concat([{ t: hist[hist.length - 1].t + 86400, o: 1, h: 1, l: 1, c: 1, v: 1 }]), hist);
check("flow attached to the SAME day's candle only (no look-ahead)", att.matched === hist.length && !("rn" in att.candles[att.candles.length - 1]) && att.candles[0].rn === hist[0].buyIValue - hist[0].sellIValue);

// ---- engine uses the flow only when present
let seed = 3; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const base = []; let p = 4000; for (let k = 0; k < 300; k++) { const o = p, c = o + (rnd() - 0.48) * 40; base.push({ t: 1700000000 + k * 86400, o, c, h: Math.max(o, c) + 10, l: Math.min(o, c) - 10, v: 1e6 }); p = c; }
const plain = FA.signal.analyze(base);
const inflow = FA.signal.analyze(base.map((c, k) => (k > 290 ? { ...c, rn: 3e11, rv: 1e12, bp: 2.2 } : c)));
const outflow = FA.signal.analyze(base.map((c, k) => (k > 290 ? { ...c, rn: -3e11, rv: 1e12, bp: 0.4 } : c)));
const it = (r, k) => r.items.find((x) => x.key === k);
check("no flow data → no flow items (other markets unchanged)", !it(plain, "flow_net") && !it(plain, "flow_bp"));
check("retail inflow + strong buyers → positive flow items", it(inflow, "flow_net").score > 0.9 && it(inflow, "flow_bp").score > 0.9, it(inflow, "flow_net").value);
check("retail outflow + strong sellers → negative flow items", it(outflow, "flow_net").score < -0.9 && it(outflow, "flow_bp").score < -0.9);
check("flow moves the overall score in its direction", inflow.score > plain.score && outflow.score < plain.score, `${outflow.score.toFixed(3)} < ${plain.score.toFixed(3)} < ${inflow.score.toFixed(3)}`);

// ---- price adjustment
const adj = fx("GetPriceAdjustList_fmelli.json").priceAdjust;
const e0 = adj[0], t0 = Math.floor(Date.parse(String(e0.dEven).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") + "T00:00:00Z") / 1000);
const series = [{ t: t0 - 2 * 86400, o: 6000, h: 6100, l: 5900, c: 6050, v: 1000 }, { t: t0, o: 5350, h: 5400, l: 5300, c: 5350, v: 1000 }];
const a = T.applyAdjustments(series, [e0]);
const r = e0.pClosing / e0.pClosingNotAdjusted;
check("prices before a capital increase are scaled by adjusted/unadjusted close", Math.abs(a.candles[0].c - 6050 * r) < 1e-9 && a.candles[1].c === 5350 && a.count === 1, `ratio ${r.toFixed(4)}: 6050 → ${a.candles[0].c.toFixed(0)}`);
check("no artificial crash left at the adjustment date", Math.abs(a.candles[1].c / a.candles[0].c - 1) < 0.01);
const all = T.applyAdjustments(series, adj);
check("multiple events compound; volume scaled inversely", all.candles[0].v > 1000 && all.candles[1].v === 1000);

// ---- indices
const ih = T.parseIndexHistory(fx("GetIndexB2History_tedpix.json"));
check("TEDPIX history → daily candles (open = previous close)", ih.length >= 600 && ih.every((x, k) => !k || x.o === ih[k - 1].c) && ih.every((x) => x.h >= Math.max(x.o, x.c) && x.l <= Math.min(x.o, x.c)));
const ia = T.parseIndexAll(fx("GetIndexB1LastAll.json"));
check("all indices (selected + sector) parsed with values and change %", ia.length > 40 && ia.every((x) => x.value > 0 && Number.isFinite(x.pct)) && ia.some((x) => /زراعت/.test(x.name)), ia.length + " indices");
const r2 = FA.signal.analyze(ih);
check("engine analyses the TEDPIX index (no volume → volume items skipped)", !r2.error && r2.series.hasVol === false);

// ---- fundamentals
const info = T.parseInstrumentInfo(fx("GetInstrumentInfo_fmelli.json"));
check("instrument info: EPS (estimated), sector P/E, shares, base volume, free float, price limits, 52-week range", info.eps === 799 && info.epsEstimated && info.sectorPE === 8.95 && info.shares === 1.05e12 && info.baseVol === 14268728
  && info.freeFloat === 34 && info.limitMax === 8660 && info.limitMin === 8160 && info.minYear === 5140 && info.maxYear === 10290 && info.sector === "فلزات اساسی", JSON.stringify(info).slice(0, 200));
const v = T.valuation(info, 8410);
check("valuation: P/E = price ÷ EPS, market cap = shares × price, vs sector P/E", Math.abs(v.pe - 8410 / 799) < 1e-9 && v.mcap === 1.05e12 * 8410 && Math.abs(v.peVsSector - 8410 / 799 / 8.95) < 1e-9 && !v.atUpperLimit);
check("index info is not mistaken for a share (no EPS)", !(T.parseInstrumentInfo(fx("GetInstrumentInfo_index.json")).eps > 0));
const sec = T.parseSectors(fx("GetSectorsSummary.json"));
check("sector names by code", sec.get("27") === "فلزات اساسی" && sec.size > 30);

// ---- exact ticker search
const s = T.pickExact(fx("GetInstrumentSearch_firuze.json"), "فیروزه");
check("search: exact ticker match picked among fuzzy results", !s || T.norm(s.ticker) === "فیروزه", s ? s.ticker + " " + s.ins : "no exact match in sample");
check("timeframe: Tehran symbols forced to daily (no fake intraday)", D.resolveTimeframe(D.SYMBOLS.find((x) => x.tse), D.TIMEFRAMES[0], { twelve: "k" }).tf.id === "1d");
// ---- regression: the real daily-price fields (priceFirst / qTotTran5J) — the old parser read pOpening/qTotTran and dropped every row
const daily = D.parseTsetmc(fx("GetClosingPriceDailyList_karis.json"));
check("daily prices: real TSETMC fields parsed (open=priceFirst, volume=qTotTran5J)", daily.length === 3 && daily.every((c) => c.o > 0 && c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c)) && daily.some((c) => c.v > 0), daily.length + " candles, last " + JSON.stringify(daily[daily.length - 1]));
console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED"); process.exit(fails ? 1 : 0);
