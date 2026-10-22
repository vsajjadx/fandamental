/* Fandamental service worker — makes the app shell load instantly and work offline after the first visit.
   Only same-origin static files are cached (JS/CSS/fonts/chart lib). API calls (prices, news, AI) are NEVER
   cached or touched here, so data is always live. Bump VERSION to force-refresh the cache. */
const VERSION = "fa-v5";
const SHELL = [
  "./", "index.html", "css/style.css", "css/fonts.css",
  "vendor/lightweight-charts.standalone.production.js",
  "js/indicators.js", "js/priceaction.js", "js/signal.js", "js/setups.js", "js/setups-ui.js", "js/data.js", "js/news.js", "js/backtest.js", "js/ai.js", "js/mtf.js", "js/mt5.js", "js/app.js",
  "vendor/fonts/vazirmatn-arabic-400-normal.woff2", "vendor/fonts/vazirmatn-arabic-700-normal.woff2", "vendor/fonts/vazirmatn-latin-400-normal.woff2",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // third-party/API traffic: untouched
  // stale-while-revalidate: instant from cache, refreshed in the background for next time
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(req);
    const net = fetch(req).then((r) => { if (r && r.ok) cache.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
