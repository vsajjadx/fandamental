// Round 2: forex / metals / indices candle sources + GDELT + extra RSS
import fs from "node:fs";
const ORIGIN = "https://vsajjadx.github.io";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const out = [];
const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };
const get = async (url, o = {}) => {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: o.method || "GET", headers: Object.assign({ "User-Agent": UA, Origin: ORIGIN, Accept: "*/*" }, o.headers), body: o.body, signal: AbortSignal.timeout(o.timeout || 25000) });
    const text = await r.text();
    return { status: r.status, ms: Date.now() - t0, acao: r.headers.get("access-control-allow-origin"), text };
  } catch (e) { return { status: "ERR", ms: Date.now() - t0, text: String(e && (e.cause && e.cause.code || e.message)) }; }
};
const J = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };
const line = (n, r, extra = "") => log(`${n}\t${r.status}\t${r.ms}ms\tacao=${r.acao || "-"}\t${extra || r.text.replace(/\s+/g, " ").slice(0, 160)}`);

// 1 Kraken full pairs
{ const r = await get("https://api.kraken.com/0/public/AssetPairs"); const j = J(r.text);
  if (j && j.result) { const names = Object.values(j.result).map((p) => p.altname + (p.wsname ? "(" + p.wsname + ")" : "")); const pick = names.filter((n) => /^(EUR|GBP|AUD|CAD|CHF|JPY|NZD|USD|XAU|XAG|PAXG|XAUT|GOLD|SILVER|TON|LINK|TRX|BNB|DOGE|ADA|SOL|XRP|LTC|AVAX|DOT|POL|SHIB|BCH|ATOM|NEAR|UNI|APT|ARB|SUI|PEPE|WLD|DXY|SPX|NAS)[A-Z]*(USD|EUR|JPY|GBP|CHF|CAD|AUD)\b/.test(n) && !/USDC|USDT|EURQ|EURR|EUROP|EURC/.test(n)); line("kraken_pairs_fx", r, `n=${names.length} ${pick.join(",")}`);
    line("kraken_all_usd", r, names.filter((n) => /USD\b/.test(n.split("(")[0]) ).slice(0, 400).join(",")); } else line("kraken_pairs", r); }
// 2 OKX instruments
for (const t of ["SWAP", "SPOT"]) { const r = await get(`https://www.okx.com/api/v5/public/instruments?instType=${t}`); const j = J(r.text);
  if (j && j.data) line("okx_" + t, r, `n=${j.data.length} ` + j.data.map((d) => d.instId).filter((n) => /^(XAU|XAG|EUR|GBP|JPY|AUD|SPX|NAS|NDX|DJI|WTI|OIL|BRENT|DXY|COPPER|PLAT|TSLA|NVDA|US500|USOIL)/i.test(n)).slice(0, 80).join(",")); else line("okx_" + t, r); }
// 3 Gate futures + Bitget + MEXC + Bybit(skip)
{ const r = await get("https://api.gateio.ws/api/v4/futures/usdt/contracts?limit=1000"); const j = J(r.text); if (Array.isArray(j)) line("gate_fut", r, `n=${j.length} ` + j.map((d) => d.name).filter((n) => /^(XAU|XAG|EUR|GBP|JPY|AUD|SPX|NAS|NDX|DJI|WTI|OIL|BRENT|DXY|COPPER|PLAT|US500|USOIL|PAXG)/i.test(n)).join(",")); else line("gate_fut", r); }
{ const r = await get("https://contract.mexc.com/api/v1/contract/detail"); const j = J(r.text); if (j && j.data) line("mexc_fut", r, `n=${j.data.length} ` + j.data.map((d) => d.symbol).filter((n) => /^(XAU|XAG|EUR|GBP|JPY|AUD|SPX|NAS|NDX|DJI|WTI|OIL|BRENT|DXY|COPPER|PLAT|US500|USOIL|GOLD|SILVER|PAXG)/i.test(n)).join(",")); else line("mexc_fut", r); }
{ const r = await get("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES"); const j = J(r.text); if (j && j.data) line("bitget_fut", r, `n=${j.data.length} ` + j.data.map((d) => d.symbol).filter((n) => /^(XAU|XAG|EUR|GBP|JPY|AUD|SPX|NAS|NDX|DJI|WTI|OIL|BRENT|DXY|COPPER|PLAT|US500|USOIL|GOLD|SILVER|PAXG)/i.test(n)).join(",")); else line("bitget_fut", r); }
{ const r = await get("https://api.bitget.com/api/v2/mix/market/candles?symbol=XAUUSDT&productType=USDT-FUTURES&granularity=1H&limit=3"); line("bitget_xau_candles", r); }
{ const r = await get("https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=1h&limit=3"); line("binance_fapi_xau", r); }
{ const r = await get("https://api.bybit.com/v5/market/kline?category=linear&symbol=XAUUSDT&interval=60&limit=3"); line("bybit_xau", r); }
// 4 Hyperliquid
{ const r = await get("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "perpDexs" }) }); const j = J(r.text); line("hl_dexs", r, j ? JSON.stringify(j).slice(0, 600) : ""); 
  const r2 = await get("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allPerpMetas" }) }); const j2 = J(r2.text);
  if (Array.isArray(j2)) line("hl_allmetas", r2, j2.map((m) => (m.universe || []).map((u) => u.name)).flat().filter((n) => /gold|silver|eur|jpy|gbp|oil|sp500|nas|xyz|dxy|brent|copper|plat/i.test(n)).slice(0, 80).join(",")); else line("hl_allmetas", r2); }
// 5 Swissquote + TradingView scanner (just reachability)
{ const r = await get("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/EUR/USD"); line("swissquote", r); }
// 6 Yahoo: spark + crumb flow + proxies
{ const r = await get("https://query1.finance.yahoo.com/v7/finance/spark?symbols=EURUSD%3DX&range=1d&interval=5m"); line("yahoo_spark", r); }
{ const r = await get("https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1h&range=5d", { headers: { "User-Agent": "curl/8.5.0" } }); line("yahoo_curlUA", r); }
{ const u = encodeURIComponent("https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1h&range=5d");
  line("yahoo_via_allorigins", await get("https://api.allorigins.win/raw?url=" + u));
  line("yahoo_via_corsproxyio", await get("https://corsproxy.io/?url=" + u));
  line("yahoo_via_codetabs", await get("https://api.codetabs.com/v1/proxy?quest=" + u));
  line("yahoo_via_jina", await get("https://r.jina.ai/https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=1h&range=5d")); }
// 7 GDELT with spacing
for (const [n, q, mode] of [["gdelt_art", "(gold OR bullion) sourcelang:english", "artlist"], ["gdelt_art2", "(euro OR ECB) sourcelang:english", "artlist"], ["gdelt_tone", "(gold) sourcelang:english", "timelinetone"]]) {
  await new Promise((r) => setTimeout(r, 6000));
  const r = await get(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=${mode}&format=json&maxrecords=5&timespan=1d&sort=datedesc`, { timeout: 30000 }); line(n, r, r.text.slice(0, 220).replace(/\s+/g, " ")); }
// 8 more RSS
for (const [n, u] of [["inv_1", "https://www.investing.com/rss/news_1.rss"], ["inv_11", "https://www.investing.com/rss/news_11.rss"], ["inv_14", "https://www.investing.com/rss/news_14.rss"], ["inv_25", "https://www.investing.com/rss/news_25.rss"], ["inv_95", "https://www.investing.com/rss/news_95.rss"], ["inv_301", "https://www.investing.com/rss/news_301.rss"], ["inv_285", "https://www.investing.com/rss/news_285.rss"], ["inv_287", "https://www.investing.com/rss/market_overview.rss"], ["bing_news", "https://www.bing.com/news/search?q=gold+price&format=rss"], ["economist", "https://www.economist.com/finance-and-economics/rss.xml"], ["ft_home", "https://www.ft.com/rss/home"], ["gn_eurusd", "https://news.google.com/rss/search?q=EUR%2FUSD+OR+euro+dollar+when%3A2d&hl=en-US&gl=US&ceid=US%3Aen"], ["reuters_gn", "https://news.google.com/rss/search?q=site%3Areuters.com+markets+when%3A1d&hl=en-US&gl=US&ceid=US%3Aen"]]) {
  const r = await get(u); const t = r.text; const items = (t.match(/<item[\s>]/g) || []).length; const ft = /<item[\s\S]*?<title[^>]*>(?:<!\[CDATA\[)?([^<\]]*)/.exec(t); line(n, r, `items=${items} first=${ft ? ft[1].trim().slice(0, 100) : t.slice(0, 80).replace(/\s+/g, " ")}`); }
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/diag2.txt", out.join("\n"));
