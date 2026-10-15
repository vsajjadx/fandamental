// Run: node tests/site.test.js — guards the "works behind filtering / offline" promise:
//  1) index.html loads NOTHING from a third-party host at startup (CDN scripts/styles/fonts)
//  2) every local file index.html / fonts.css / sw.js refers to exists
//  3) the Pages workflow actually publishes every top-level path the page needs
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const rd = (f) => fs.readFileSync(path.join(root, f), "utf8");
let fails = 0;
const check = (n, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + n + (extra ? "  " + extra : "")); if (!c) fails++; };

const html = rd("index.html"), css = rd("css/fonts.css") + rd("css/style.css"), sw = rd("sw.js"), wf = rd(".github/workflows/pages.yml");
const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
const ext = refs.filter((u) => /^(https?:)?\/\//i.test(u) && !/rel=["']?(noopener|external)/.test(u));
const startupExt = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
check("index.html has no third-party <script>/<link> at startup", startupExt.length === 0, startupExt.join(", "));
check("CSS has no remote @import / url(http…)", !/@import|url\(\s*['"]?https?:/i.test(css));

const local = refs.filter((u) => !/^(https?:)?\/\//i.test(u) && !/^(mailto|data|javascript):/i.test(u));
const missing = local.filter((u) => !fs.existsSync(path.join(root, u.split("?")[0])));
check("every local file referenced by index.html exists", missing.length === 0, missing.join(", "));

const fontUrls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/['"]/g, "")).filter((u) => !/^data:/.test(u));
const missingFonts = fontUrls.filter((u) => !fs.existsSync(path.join(root, "css", u)));
check("every font file in fonts.css exists (" + fontUrls.length + ")", fontUrls.length > 0 && missingFonts.length === 0, missingFonts.join(", "));

const shell = [...sw.matchAll(/"([^"]+\.(?:js|css|html|woff2))"/g)].map((m) => m[1]);
const missingShell = shell.filter((u) => !fs.existsSync(path.join(root, u)));
check("every service-worker shell file exists", shell.length > 5 && missingShell.length === 0, missingShell.join(", "));

const copyLine = (wf.match(/cp -r ([^\n]+) _site\//) || [])[1] || "";
const published = copyLine.split(/\s+/);
const needTop = new Set([...local, ...shell, "sw.js"].map((u) => u.replace(/^\.\//, "").split("/")[0]).filter((u) => u && u !== "."));
const notPublished = [...needTop].filter((t) => !published.includes(t));
check("Pages workflow publishes every top-level path the site needs", notPublished.length === 0, "missing: " + notPublished.join(", ") + " | copies: " + copyLine);

console.log(fails ? "\n" + fails + " FAILED" : "\nALL PASSED");
process.exit(fails ? 1 : 0);
