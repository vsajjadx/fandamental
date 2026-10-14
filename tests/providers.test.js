// Run: node tests/providers.test.js   (offline — parsers, relays, failure diagnosis)
require("../js/data.js");
const FA = globalThis.FA, D = FA.data;
let fails = 0;
const check = (n, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + n + (extra ? "  " + extra : "")); if (!c) fails++; };

/* ---------- Twelve Data: status codes are read, not guessed ---------- */
check("TD 401 -> key message (not «404 / use 1D»)",
  /کلید Twelve Data نامعتبر/.test(D.tdMessage(401, "**apikey** parameter is incorrect")));
check("TD 404 -> symbol-not-in-plan message",
  /پلن رایگان Twelve Data پوشش/.test(D.tdMessage(404, "Symbol not exists")));
check("TD 429 -> quota message", /سهمیه/.test(D.tdMessage(429, "API limit reached")));
check("TD error body wins over the bare status code",
  D.tdMessage(404, "Symbol not exists").indexOf("نماد در پلن") >= 0);
const tdErr = (() => { try { D.parseTwelve({ code: 404, status: "error", message: "Symbol not exists" }); } catch (e) { return e; } })();
check("parseTwelve marks a not-covered symbol", tdErr && tdErr.kind === "tdNotCovered");
check("parseTwelve message is the TD one", tdErr && /Symbol not exists|پلن/.test(tdErr.message), tdErr && tdErr.message.slice(0, 60));
check("parseTwelve maps values + orders them", D.parseTwelve({ values: [{ datetime: "2026-10-13", open: "1", high: "2", low: "0.5", close: "1.5" }, { datetime: "2026-10-14", open: "1.5", high: "2", low: "1", close: "1.8" }] }).length === 2);

/* ---------- relay answer shapes ---------- */
check("extractJson: plain JSON", D.extractJson('{"a":1}').a === 1);
check("extractJson: allorigins contents wrapper", D.extractJson('{"contents":"{\\"a\\":1}"}').a === 1);
check("extractJson: r.jina.ai Markdown envelope", D.extractJson('Title: \n\nURL Source: x\n\nMarkdown Content:\n{"chart":{"result":[{"timestamp":[1]}]}}').chart.result[0].timestamp[0] === 1);
check("extractJson: jina envelope + trailing noise", D.extractJson('Markdown Content:\n{"a":1}\n\nSupport us').a === 1);
check("extractJson: rejects non-JSON", (() => { try { D.extractJson("<html>blocked</html>"); return false; } catch (e) { return true; } })());
check("relay chain starts with the direct URL and includes r.jina.ai",
  D.RELAY[0]("https://x") === "https://x" && D.RELAY.some((f) => /r\.jina\.ai/.test(f("https://x"))));

/* ---------- Stooq CSV ---------- */
const st = D.parseStooq("Date,Open,High,Low,Close,Volume\n2026-10-12,100,105,99,104,1000\n2026-10-13,104,110,103,109,2000\n");
check("Stooq CSV parsed", st.length === 2 && st[1].c === 109, JSON.stringify(st[1]));
check("Stooq header row skipped", st.every((x) => isFinite(x.t)));
check("Stooq empty -> []", D.parseStooq("Date,Open,High,Low,Close,Volume").length === 0);

/* ---------- TSETMC: an insCode that answers with a zero/missing opening ---------- */
const zero = D.parseTsetmc({ closingPriceDaily: [{ dEven: 20261014, pOpening: 0, priceFirst: 2900, priceMax: 3150, priceMin: 2890, pClosing: 3100, qTotTran5J: 7 }] });
check("TSETMC opening falls back to priceFirst (used to drop EVERY candle)",
  zero.length === 1 && zero[0].o === 2900 && zero[0].c === 3100, JSON.stringify(zero[0]));
const noOpen = D.parseTsetmc({ closingPriceDaily: [{ dEven: 20261014, pOpening: null, priceYesterday: 3050, pClosing: 3100 }] });
check("TSETMC falls back to priceYesterday", noOpen.length === 1 && noOpen[0].o === 3050);
const lastResort = D.parseTsetmc({ closingPriceDaily: [{ dEven: 20261014, pOpening: 0, pClosing: 3100 }] });
check("TSETMC last resort: open = close (still a usable candle)", lastResort.length === 1 && lastResort[0].o === 3100);
check("TSETMC accepts the alternate list key", D.parseTsetmc({ closingPriceDailyList: [{ dEven: 20261014, pClosing: 3100 }] }).length === 1);
check("TSETMC reads pDrCotVal when pClosing is absent", D.parseTsetmc({ closingPriceDaily: [{ dEven: 20261014, priceFirst: 1, pDrCotVal: 2500 }] })[0].c === 2500);
check("TSETMC still drops a truly empty row", D.parseTsetmc({ closingPriceDaily: [{ dEven: 20261014, pOpening: 0, priceMax: 0, priceMin: 0, pClosing: 0 }] }).length === 0);

/* Persian character normalisation (search is done by ticker) */
check("normalizeFa maps Arabic yeh/kaf to Persian", D.normalizeFa("فولاد ي ك") === "فولاد ی ک", D.normalizeFa("فولاد ي ك"));
check("normalizeFa strips ZWNJ", D.normalizeFa("گل\u200cگهر") === "گلگهر");

/* ---------- per-provider failure hints (the old code printed ONE hint for everything) ---------- */
const S = (id) => D.SYMBOLS.find((x) => x.id === id) || {};
const tseHints = D.diagnose(S("TSE-فولاد"), ["TSETMC"], [{ kind: "tse" }]).join(" ");
check("TSE hint mentions Iran IP / VPN, never Twelve Data", /ایران|VPN/.test(tseHints) && !/Twelve Data/.test(tseHints), tseHints.slice(0, 70));
const idxHints = D.diagnose(S("SPX"), ["Yahoo", "Stooq"], [{ kind: "cors" }, { kind: "tdNotCovered" }]).join(" ");
check("index hint explains TD free plan + CORS/429", /پلن رایگان Twelve Data/.test(idxHints) && /Failed to fetch|۴۲۹|429/.test(idxHints), idxHints.slice(0, 110));
check("auth failure -> new-key hint", /کلید Twelve Data نامعتبر/.test(D.diagnose(S("EURUSD"), ["Twelve Data"], [{ kind: "auth" }]).join(" ")));
check("unknown failure still gives an actionable hint", D.diagnose(S("EURUSD"), ["Frankfurter"], [{ kind: "other" }]).length > 0);

/* ---------- catalog: the new Stooq fallback + TD plan flags ---------- */
check("indices carry a Stooq fallback too", ["DXY", "SPX", "NDX", "DJI"].every((id) => !!S(id).st), ["DXY", "SPX", "NDX", "DJI"].map((id) => S(id).st).join(","));
check("indices are flagged as Twelve-Data paid-only", ["DXY", "SPX", "NDX", "DJI"].every((id) => S(id).tdPaid === true));
check("metals / oil / FX have Stooq fallbacks", !!S("XAUUSD").st && !!S("USOIL").st && !!S("EURUSD").st);
check("fetchCandles exposes hints on failure", typeof D.fetchCandles === "function");
check("getText is exported (relay path is testable)", typeof D.getText === "function" && typeof D.reqText === "function");
check("viaRelay is exported and cools down its relays", typeof D.viaRelay === "function");

console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED");
process.exit(fails ? 1 : 0);
