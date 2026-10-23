/* Fandamental service worker — the app keeps working offline / behind slow or filtered networks,
   but ALWAYS shows the newest version when the site is reachable.

   App code (HTML / JS / CSS): NETWORK FIRST. The browser revalidates with the server (cache: "no-cache" →
   a cheap 304 when nothing changed) and the cached copy is used only if the network fails or takes longer
   than 4 s. (The old cache-first strategy kept showing an outdated version after an update.)
   Fonts and the chart library (large, rarely change): cache first.
   API calls (prices, news, AI) are never touched here: they are other origins and always live.
   VERSION changes delete every old cache; the page then reloads itself once (see index.html). */
const VERSION = "fa-v7";
const SHELL = [
  "./", "index.html", "css/style.css", "css/fonts.css",
  "vendor/lightweight-charts.standalone.production.js",
  "js/indicators.js", "js/priceaction.js", "js/signal.js", "js/setups.js", "js/setups-ui.js", "js/tokens.js", "js/data.js", "js/news.js", "js/backtest.js", "js/ai.js", "js/mtf.js", "js/mt5.js", "js/app.js",
  "vendor/fonts/vazirmatn-arabic-400-normal.woff2", "vendor/fonts/vazirmatn-arabic-700-normal.woff2", "vendor/fonts/vazirmatn-latin-400-normal.woff2",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: "reload" }))))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  const done = (async () => {
    const old = (await caches.keys()).filter((k) => k !== VERSION);
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
    return old.length > 0;
  })();
  e.waitUntil(done);
  // An update replaced an older version: reload open tabs once so nobody keeps running outdated code
  // (pages opened under the old worker have no reload logic of their own). This MUST start only after
  // activation has finished: the reload's own request is held by the browser until the worker is active,
  // so awaiting it inside waitUntil() would deadlock and freeze the tab.
  done.then((updated) => {
    if (!updated) return;
    setTimeout(() => self.clients.matchAll({ type: "window" }).then((tabs) => tabs.forEach((c) => { if (c.navigate) c.navigate(c.url).catch(() => {}); })), 0);
  });
});

const isStatic = (url) => /\/vendor\//.test(url.pathname) || /\.(woff2?|ttf|png|jpg|svg|ico)$/.test(url.pathname);

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  // a navigation Request cannot be re-used with new options (TypeError), so rebuild it from its URL
  const fresh = req.mode === "navigate" ? new Request(req.url, { cache: "no-cache", credentials: "same-origin" }) : new Request(req.url, { cache: "no-cache", credentials: req.credentials, headers: req.headers });
  const net = fetch(fresh).then((r) => { if (r && r.ok) cache.put(req, r.clone()); return r; });
  const timeout = new Promise((resolve) => setTimeout(resolve, 4000, null));
  try {
    const r = await Promise.race([net, timeout]);
    if (r) return r;
  } catch (err) { /* offline / blocked → fall back to the cached copy */ }
  const hit = await cache.match(req, { ignoreSearch: true });
  return hit || net;   // nothing cached yet: keep waiting for the network
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION), hit = await cache.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r && r.ok) cache.put(req, r.clone());
  return r;
}

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // third-party/API traffic: untouched
  e.respondWith(isStatic(url) ? cacheFirst(req) : networkFirst(req));
});
