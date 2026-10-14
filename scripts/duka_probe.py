import lzma, struct, urllib.request, datetime, sys
UA = {"User-Agent": "Mozilla/5.0", "Origin": "https://vsajjadx.github.io"}
out = []
def log(*a):
    s = " ".join(str(x) for x in a); out.append(s); print(s)
def get(url):
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read()
    except Exception as e:
        return getattr(e, "code", "ERR"), {}, str(e).encode()
def dec(b):
    try:
        return lzma.decompress(b, format=lzma.FORMAT_ALONE)
    except Exception:
        d = lzma.LZMADecompressor(format=lzma.FORMAT_AUTO)
        try: return d.decompress(b)
        except Exception as e: return b""
now = datetime.datetime.now(datetime.timezone.utc)
log("now", now.isoformat())
BASE = "https://datafeed.dukascopy.com/datafeed"
def candles(path, base_ts, factor):
    st, h, b = get(f"{BASE}/{path}")
    if st != 200: return log(path, "->", st, len(b), (h.get("Last-Modified") or "")); 
    raw = dec(b); n = len(raw) // 24
    rows = [struct.unpack(">IIIIIf", raw[i*24:(i+1)*24]) for i in range(n)]
    def fmt(r): return f"{datetime.datetime.fromtimestamp(base_ts + r[0], datetime.timezone.utc):%Y-%m-%d %H:%M} o={r[1]/factor} c={r[2]/factor} l={r[3]/factor} h={r[4]/factor} v={r[5]:.1f}"
    log(path, "->", st, f"bytes={len(b)} lm={h.get('Last-Modified')} recs={n}")
    if rows: log("   first:", fmt(rows[0])); log("   last :", fmt(rows[-1]))
def ticks(path, base_ts, factor):
    st, h, b = get(f"{BASE}/{path}")
    if st != 200: return log(path, "->", st, len(b))
    raw = dec(b); n = len(raw) // 20
    rows = [struct.unpack(">IIIff", raw[i*20:(i+1)*20]) for i in range(n)]
    log(path, "->", st, f"bytes={len(b)} lm={h.get('Last-Modified')} ticks={n}")
    if rows: r = rows[-1]; log("   last tick:", datetime.datetime.fromtimestamp(base_ts + r[0]/1000, datetime.timezone.utc).isoformat(), "ask", r[1]/factor, "bid", r[2]/factor)
y, m, d = now.year, now.month - 1, now.day  # month is zero-based in URLs
for inst, f in [("EURUSD", 1e5), ("XAUUSD", 1e3), ("USDJPY", 1e3), ("XAGUSD", 1e3), ("USA500IDXUSD", 1e3), ("LIGHTCMDUSD", 1e3), ("BRENTCMDUSD", 1e3), ("USATECHIDXUSD", 1e3), ("DEUIDXEUR", 1e3), ("USDIDXUSD", 1e3), ("DOLLARIDXUSD", 1e3), ("GBPUSD", 1e5), ("BTCUSD", 1e1)]:
    log("==", inst)
    month_start = int(datetime.datetime(y, now.month, 1, tzinfo=datetime.timezone.utc).timestamp())
    candles(f"{inst}/{y}/{m:02d}/BID_candles_hour_1.bi5", month_start, f)
    if inst in ("EURUSD", "XAUUSD", "USA500IDXUSD"):
        year_start = int(datetime.datetime(y, 1, 1, tzinfo=datetime.timezone.utc).timestamp())
        candles(f"{inst}/{y}/BID_candles_day_1.bi5", year_start, f)
        day0 = int(datetime.datetime(y, now.month, now.day, tzinfo=datetime.timezone.utc).timestamp())
        candles(f"{inst}/{y}/{m:02d}/{d:02d}/BID_candles_min_1.bi5", day0, f)
        yd = now - datetime.timedelta(days=1); yd0 = int(datetime.datetime(yd.year, yd.month, yd.day, tzinfo=datetime.timezone.utc).timestamp())
        candles(f"{inst}/{yd.year}/{yd.month-1:02d}/{yd.day:02d}/BID_candles_min_1.bi5", yd0, f)
        for hh in (now.hour, max(0, now.hour - 1), max(0, now.hour - 3)):
            h0 = day0 + hh * 3600
            ticks(f"{inst}/{y}/{m:02d}/{d:02d}/{hh:02d}h_ticks.bi5", h0, f)
open("out/duka.txt", "w").write("\n".join(out))
