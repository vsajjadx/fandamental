/* Fandamental personal relay — Cloudflare Worker (free plan is enough).
   Lets the web app reach data / news sources that are blocked or slow on your network, and adds the CORS
   headers browsers need. Only the hosts below are allowed, so it cannot be abused as an open proxy.
   Deploy: see docs/RELAY.md. Then put  https://<your-worker>.workers.dev/?url=  in the app's ⚙ settings. */
const ALLOWED = [
  "api.gdeltproject.org", "www.bing.com", "query1.finance.yahoo.com", "query2.finance.yahoo.com",
  "nfs.faireconomy.media", "api.coingecko.com", "api.frankfurter.app", "api.frankfurter.dev",
  "data-api.binance.vision", "api.binance.com", "api.gold-api.com", "api.goldprice.dev",
  "api.twelvedata.com", "cdn.tsetmc.com", "api.nobitex.ir", "api.wallex.ir",
];

export default {
  async fetch(request) {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return new Response("GET only", { status: 405, headers: cors });
    const target = new URL(request.url).searchParams.get("url");
    let u;
    try { u = new URL(target); } catch (e) { return new Response("add ?url=<encoded target url>", { status: 400, headers: cors }); }
    if (u.protocol !== "https:" || !ALLOWED.includes(u.hostname)) return new Response("host not allowed: " + u.hostname, { status: 403, headers: cors });
    const r = await fetch(u.toString(), { headers: { "User-Agent": "Mozilla/5.0 (fandamental relay)", "Accept": "application/json, application/xml, text/plain, */*" }, cf: { cacheTtl: 60 } });
    const h = new Headers(cors);
    h.set("Content-Type", r.headers.get("Content-Type") || "text/plain; charset=utf-8");
    h.set("Cache-Control", "public, max-age=60");
    return new Response(r.body, { status: r.status, headers: h });
  },
};
