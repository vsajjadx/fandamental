// Probe free data/news/AI endpoints from a GitHub runner: status, CORS header, size, shape.
import fs from "node:fs";
const ORIGIN = "https://vsajjadx.github.io";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const Y = (s, i, r) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=${i}&range=${r}&includePrePost=false`;
const P = [];
const add = (g, name, url, o = {}) => P.push({ g, name, url, ...o });
// ---- candles
for (const [n, s, i, r] of [["fx", "EURUSD=X", "60m", "5d"], ["xau", "XAUUSD=X", "15m", "5d"], ["xag", "XAGUSD=X", "60m", "5d"], ["gc", "GC=F", "60m", "5d"], ["btc5", "BTC-USD", "5m", "5d"], ["dxy", "DX-Y.NYB", "60m", "5d"], ["spx", "^GSPC", "60m", "10d"], ["ton", "TON11419-USD", "60m", "5d"], ["xpt", "XPTUSD=X", "60m", "5d"], ["wti", "CL=F", "60m", "5d"], ["fx1d", "EURUSD=X", "1d", "1y"], ["fx60_2y", "EURUSD=X", "60m", "2y"]]) add("candles", "yahoo_" + n, Y(s, i, r));
add("candles", "yahoo_query2", "https://query2.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=60m&range=5d");
add("candles", "kraken_btc", "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60");
add("candles", "kraken_eurusd", "https://api.kraken.com/0/public/OHLC?pair=EURUSD&interval=60");
add("candles", "kraken_xauusd", "https://api.kraken.com/0/public/OHLC?pair=XAUUSD&interval=60");
add("candles", "kraken_paxg", "https://api.kraken.com/0/public/OHLC?pair=PAXGUSD&interval=60");
add("candles", "kraken_pairs", "https://api.kraken.com/0/public/AssetPairs", { keysOnly: true });
add("candles", "bitfinex", "https://api-pub.bitfinex.com/v2/candles/trade:1h:tBTCUSD/hist?limit=5");
add("candles", "kucoin", "https://api.kucoin.com/api/v1/market/candles?type=1hour&symbol=BTC-USDT");
add("candles", "okx", "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=5");
add("candles", "gate", "https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1h&limit=5");
add("candles", "mexc", "https://api.mexc.com/api/v3/klines?symbol=BTCUSDT&interval=60m&limit=5");
add("candles", "bybit", "https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=60&limit=5");
add("candles", "bitget", "https://api.bitget.com/api/v2/spot/market/candles?symbol=BTCUSDT&granularity=1h&limit=5");
add("candles", "htx", "https://api.huobi.pro/market/history/kline?period=60min&size=5&symbol=btcusdt");
add("candles", "binance", "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=5");
add("candles", "binance_vision", "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=5");
add("candles", "binance_us", "https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=5");
add("candles", "coinbase", "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600");
add("candles", "bitstamp", "https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=3600&limit=5");
add("candles", "coingecko", "https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=7");
add("candles", "cryptocompare", "https://min-api.cryptocompare.com/data/v2/histohour?fsym=BTC&tsym=USD&limit=5");
add("candles", "cc_eurusd", "https://min-api.cryptocompare.com/data/v2/histohour?fsym=EUR&tsym=USD&limit=5");
add("candles", "cc_xau", "https://min-api.cryptocompare.com/data/v2/histohour?fsym=XAU&tsym=USD&limit=5");
add("candles", "stooq_h", "https://stooq.com/q/d/l/?s=eurusd&i=60");
add("candles", "stooq_d", "https://stooq.com/q/d/l/?s=xauusd&i=d");
add("candles", "stooq_m5", "https://stooq.com/q/d/l/?s=eurusd&i=5");
add("candles", "frankfurter", "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD");
// ---- news
add("news", "gdelt_art", "https://api.gdeltproject.org/api/v2/doc/doc?query=%28gold%20OR%20bullion%29%20sourcelang%3Aenglish&mode=artlist&format=json&maxrecords=5&timespan=1d&sort=datedesc");
add("news", "gdelt_tone", "https://api.gdeltproject.org/api/v2/doc/doc?query=%28gold%29%20sourcelang%3Aenglish&mode=timelinetone&format=json&timespan=3d");
add("news", "gnews", "https://news.google.com/rss/search?q=gold+price+when:1d&hl=en-US&gl=US&ceid=US:en");
add("news", "investing_all", "https://www.investing.com/rss/news.rss");
add("news", "investing_fx", "https://www.investing.com/rss/news_1.rss");
add("news", "fxstreet", "https://www.fxstreet.com/rss/news");
add("news", "forexlive", "https://www.forexlive.com/feed/news");
add("news", "investinglive", "https://investinglive.com/feed");
add("news", "cnbc_fin", "https://www.cnbc.com/id/10000664/device/rss/rss.html");
add("news", "cnbc_top", "https://www.cnbc.com/id/100003114/device/rss/rss.html");
add("news", "cnbc_econ", "https://www.cnbc.com/id/20910258/device/rss/rss.html");
add("news", "mw_top", "https://feeds.content.dowjones.io/public/rss/mw_topstories");
add("news", "wsj_mkts", "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain");
add("news", "wsj_world", "https://feeds.content.dowjones.io/public/rss/RSSWorldNews");
add("news", "bbc_biz", "https://feeds.bbci.co.uk/news/business/rss.xml");
add("news", "bbc_world", "https://feeds.bbci.co.uk/news/world/rss.xml");
add("news", "aljazeera", "https://www.aljazeera.com/xml/rss/all.xml");
add("news", "guardian_biz", "https://www.theguardian.com/business/rss");
add("news", "guardian_world", "https://www.theguardian.com/world/rss");
add("news", "nyt_biz", "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml");
add("news", "nyt_world", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml");
add("news", "npr_biz", "https://feeds.npr.org/1006/rss.xml");
add("news", "fed", "https://www.federalreserve.gov/feeds/press_all.xml");
add("news", "ecb", "https://www.ecb.europa.eu/rss/press.html");
add("news", "boe", "https://www.bankofengland.co.uk/rss/news");
add("news", "boj", "https://www.boj.or.jp/en/rss/whatsnew.xml");
add("news", "rba", "https://www.rba.gov.au/rss/rss-cb-media-releases.xml");
add("news", "cointelegraph", "https://cointelegraph.com/rss");
add("news", "coindesk", "https://www.coindesk.com/arc/outboundfeeds/rss/");
add("news", "decrypt", "https://decrypt.co/feed");
add("news", "theblock", "https://www.theblock.co/rss.xml");
add("news", "btcmag", "https://bitcoinmagazine.com/.rss/full/");
add("news", "oilprice", "https://oilprice.com/rss/main");
add("news", "kitco", "https://www.kitco.com/rss/KitcoNews.xml");
add("news", "mining", "https://www.mining.com/feed/");
add("news", "dailyforex", "https://www.dailyforex.com/rss/forexnews.xml");
add("news", "actionforex", "https://www.actionforex.com/feed/");
add("news", "babypips", "https://www.babypips.com/feed.rss");
add("news", "yahoo_rss_fx", "https://feeds.finance.yahoo.com/rss/2.0/headline?s=EURUSD=X&region=US&lang=en-US");
add("news", "yahoo_rss_idx", "https://finance.yahoo.com/news/rssindex");
add("news", "tv_headlines", "https://news-headlines.tradingview.com/v2/headlines?client=web&lang=en&symbol=OANDA%3AXAUUSD");
add("news", "ff_this", "https://nfs.faireconomy.media/ff_calendar_thisweek.json");
add("news", "ff_next", "https://nfs.faireconomy.media/ff_calendar_nextweek.json");
add("news", "ff_xml", "https://nfs.faireconomy.media/ff_calendar_thisweek.xml");
// ---- AI
add("ai", "pollinations_get", "https://text.pollinations.ai/Say%20hello%20in%20one%20word");
add("ai", "pollinations_post", "https://text.pollinations.ai/openai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai", messages: [{ role: "user", content: "Say hi in one word" }] }) });
add("ai", "pollinations_pre", "https://text.pollinations.ai/openai", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization" } });
add("ai", "openrouter_models", "https://openrouter.ai/api/v1/models", { models: true });
add("ai", "openrouter_pre", "https://openrouter.ai/api/v1/chat/completions", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization,x-title" } });
add("ai", "groq_pre", "https://api.groq.com/openai/v1/chat/completions", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization" } });
add("ai", "gemini_pre", "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-goog-api-key" } });
add("ai", "mistral_pre", "https://api.mistral.ai/v1/chat/completions", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization" } });
add("ai", "cerebras_pre", "https://api.cerebras.ai/v1/chat/completions", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization" } });
add("ai", "github_models_pre", "https://models.github.ai/inference/chat/completions", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization" } });

const shape = (text, ct, p) => {
  const s = text.trim();
  try {
    const j = JSON.parse(s);
    if (p.models && j.data) { const free = j.data.filter((m) => /:free$/.test(m.id) || (m.pricing && +m.pricing.prompt === 0 && +m.pricing.completion === 0)).map((m) => m.id); return `models=${j.data.length} free=${free.length}: ${free.slice(0, 40).join(", ")}`; }
    if (p.keysOnly && j.result) return "pairs=" + Object.keys(j.result).filter((k) => /EUR|GBP|JPY|AUD|CAD|CHF|XAU|XAG|PAXG|XAUT|TON|TRX|LINK|DOGE|ADA|SOL|XRP|BNB|AVAX|DOT|LTC/.test(k) && /USD|XBT/.test(k)).slice(0, 80).join(",");
    const top = Array.isArray(j) ? `array[${j.length}]` : "obj{" + Object.keys(j).slice(0, 8).join(",") + "}";
    if (j.chart && j.chart.result && j.chart.result[0]) { const r = j.chart.result[0], q = r.indicators.quote[0]; const n = (r.timestamp || []).length; return `yahoo bars=${n} last=${q.close ? q.close[q.close.length - 1] : "?"} tz=${r.meta.exchangeTimezoneName} first=${new Date(r.timestamp[0] * 1000).toISOString()} last=${new Date(r.timestamp[n - 1] * 1000).toISOString()}`; }
    if (j.chart && j.chart.error) return "yahoo error " + JSON.stringify(j.chart.error);
    return top + " " + s.replace(/\s+/g, " ").slice(0, 200);
  } catch (e) { /* not json */ }
  const items = (s.match(/<item[\s>]/g) || []).length || (s.match(/<entry[\s>]/g) || []).length;
  if (items) { const t = /<title[^>]*>(?:<!\[CDATA\[)?([^<\]]*)/.exec(s.slice(s.search(/<item|<entry/))); return `rss items=${items} first="${t ? t[1].slice(0, 90) : "?"}"`; }
  return s.replace(/\s+/g, " ").slice(0, 200);
};

async function run(p) {
  const t0 = Date.now();
  const o = { g: p.g, name: p.name, url: p.url.slice(0, 110), method: p.method || "GET" };
  try {
    const r = await fetch(p.url, { method: o.method, headers: Object.assign({ "User-Agent": UA, Origin: ORIGIN, Accept: "*/*" }, p.headers), body: p.body, signal: AbortSignal.timeout(25000), redirect: "follow" });
    const text = await r.text();
    o.status = r.status; o.ms = Date.now() - t0; o.bytes = text.length;
    o.acao = r.headers.get("access-control-allow-origin"); o.acah = r.headers.get("access-control-allow-headers"); o.ct = (r.headers.get("content-type") || "").slice(0, 40);
    o.shape = shape(text, o.ct, p);
  } catch (e) { o.ms = Date.now() - t0; o.error = String(e && (e.cause && e.cause.code || e.message)).slice(0, 120); }
  return o;
}
const conc = 5, res = [];
let idx = 0;
await Promise.all(Array.from({ length: conc }, async () => { while (idx < P.length) { const p = P[idx++]; const o = await run(p); res.push(o); console.log(o.g, o.name, o.status || o.error); await new Promise((r) => setTimeout(r, p.url.includes("gdelt") ? 5200 : 150)); } }));
res.sort((a, b) => (a.g + a.name).localeCompare(b.g + b.name));
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/diag.json", JSON.stringify(res, null, 1));
fs.writeFileSync("out/diag.txt", res.map((o) => `${o.g}/${o.name}\t${o.method}\t${o.status || "ERR"}\t${o.ms}ms\tacao=${o.acao || "-"}\t${o.error || o.shape}`).join("\n"));
