//+------------------------------------------------------------------+
//|                                          FandamentalBridge.mq5   |
//|  Receives signals produced by the Fandamental web app (through   |
//|  the bridge API) and shows / executes them in MetaTrader 5.      |
//|                                                                  |
//|  The analysis is NOT re-implemented here: this EA only moves the |
//|  web app's signals into MT5 and enforces risk/safety checks.     |
//|                                                                  |
//|  Protocol (see docs/MT5.md):                                     |
//|   POST /api/v1/ea/heartbeat          identify account, get config|
//|   GET  /api/v1/ea/pending            work + reconcile + watch    |
//|   POST /api/v1/ea/executions/{id}/report   "sending" BEFORE the  |
//|        order (must get go), then the final result                |
//|   POST /api/v1/ea/executions/{id}/closed   final P/L of position |
//+------------------------------------------------------------------+
#property copyright "Fandamental"
#property version   "1.00"
#property description "Fandamental web app -> MT5 bridge. Default = display only; demo accounts first."

#define EA_VERSION "1.00"

//--- inputs
input string InpServerUrl          = "https://your-server.example.com"; // Bridge API base URL (add it in Tools > Options > Expert Advisors > WebRequest)
input string InpTerminalKey        = "";                 // Terminal key (fa_t_...) from the web app -> MT5 tab
input int    InpPollSeconds        = 3;                  // Poll interval, seconds
input bool   InpExecutionEnabled   = true;               // Local kill-switch: false = never send orders (display only)
input bool   InpAllowRealAccount   = false;              // Allow orders on a REAL account (also needs "live" enabled in the web app)
input long   InpMagic              = 26101701;           // Magic number of orders placed by this EA
input int    InpSlippagePoints     = 20;                 // Max slippage for market orders, points
input string InpSymbolSuffix       = "";                 // Extra broker symbol suffix to try (e.g. .m, -pro). Web-app setting is tried too
input bool   InpShowAlerts         = true;               // Pop-up alert for every received signal
input bool   InpPushNotifications  = false;              // Also send to MT5 mobile app (needs MetaQuotes ID set)
input bool   InpDrawLevels         = true;               // Draw entry/SL/TP lines when the chart symbol matches
input int    InpTimeoutMs          = 7000;               // HTTP timeout, ms
input int    InpMaxQuoteAgeSec     = 300;                // Refuse to trade on a quote older than this (market closed / feed down)

//--- runtime state
bool     g_ready = false;
bool     g_bound = false;
bool     g_cfgEnabled = false;
bool     g_live = false;
string   g_mode = "notify";
double   g_riskPercent = 0.5, g_fixedLot = 0, g_maxLot = 0.10;
int      g_maxSpreadPts = 0, g_maxOpen = 3, g_tpIndex = 1;
double   g_maxSpreadSlRatio = 0.2, g_maxEntryDevSlRatio = 0.25, g_maxDailyLossPct = 3.0;
string   g_srvSuffix = "";
string   g_mapK[], g_mapV[];
datetime g_lastHeartbeat = 0, g_lastOk = 0;
string   g_status = "starting";
string   g_log[];
string   g_qEid[], g_qBody[];          // persistent queue of reports not yet acknowledged
string   QUEUE_FILE = "FandamentalBridge\\queue.txt";

//+------------------------------------------------------------------+
//| JSON writing helpers                                             |
//+------------------------------------------------------------------+
string JEsc(string s)
  {
   string o = "";
   int n = StringLen(s);
   for(int i = 0; i < n; i++)
     {
      ushort c = StringGetCharacter(s, i);
      if(c == '"') o += "\\\"";
      else if(c == '\\') o += "\\\\";
      else if(c == '\n') o += "\\n";
      else if(c == '\r') o += "\\r";
      else if(c == '\t') o += "\\t";
      else if(c < 32) o += StringFormat("\\u%04x", c);
      else o += ShortToString(c);
     }
   return "\"" + o + "\"";
  }

string JNum(double v, int digits = 8)
  {
   if(!MathIsValidNumber(v)) return "null";
   string s = DoubleToString(v, digits);
   if(StringFind(s, ".") >= 0)
     {
      int n = StringLen(s);
      while(n > 0 && StringGetCharacter(s, n - 1) == '0') n--;
      if(n > 0 && StringGetCharacter(s, n - 1) == '.') n--;
      s = StringSubstr(s, 0, n);
     }
   return s;
  }

//+------------------------------------------------------------------+
//| Minimal JSON reader                                              |
//+------------------------------------------------------------------+
#define J_NULL 0
#define J_BOOL 1
#define J_NUM  2
#define J_STR  3
#define J_ARR  4
#define J_OBJ  5

class JNode
  {
public:
   int               type;
   bool              b;
   double            n;
   string            s;
   string            keys[];
   JNode            *kids[];
                     JNode(void) { type = J_NULL; b = false; n = 0; s = ""; }
                    ~JNode(void)
     {
      for(int i = 0; i < ArraySize(kids); i++)
         if(CheckPointer(kids[i]) == POINTER_DYNAMIC)
            delete kids[i];
     }
   int               Size(void) { return ArraySize(kids); }
   JNode            *At(int i) { if(i < 0 || i >= ArraySize(kids)) return NULL; return kids[i]; }
   JNode            *Get(string k)
     {
      for(int i = 0; i < ArraySize(keys); i++)
         if(keys[i] == k)
            return kids[i];
      return NULL;
     }
   void              Add(string k, JNode *c)
     {
      int z = ArraySize(kids);
      ArrayResize(kids, z + 1);
      ArrayResize(keys, z + 1);
      kids[z] = c;
      keys[z] = k;
     }
   bool              Has(string k) { JNode *c = Get(k); return (c != NULL && c.type != J_NULL); }
   string            Str(string k, string d = "")
     {
      JNode *c = Get(k);
      if(c == NULL || c.type == J_NULL) return d;
      if(c.type == J_STR) return c.s;
      if(c.type == J_NUM) return JNum(c.n);
      if(c.type == J_BOOL) return c.b ? "true" : "false";
      return d;
     }
   double            Num(string k, double d = 0)
     {
      JNode *c = Get(k);
      if(c == NULL || c.type == J_NULL) return d;
      if(c.type == J_NUM) return c.n;
      if(c.type == J_STR) return StringToDouble(c.s);
      if(c.type == J_BOOL) return c.b ? 1 : 0;
      return d;
     }
   bool              Bool(string k, bool d = false)
     {
      JNode *c = Get(k);
      if(c == NULL || c.type == J_NULL) return d;
      if(c.type == J_BOOL) return c.b;
      if(c.type == J_NUM) return c.n != 0;
      return d;
     }
  };

class JParser
  {
private:
   string            m;
   int               p, len;
   void              Ws(void)
     {
      while(p < len)
        {
         ushort c = StringGetCharacter(m, p);
         if(c == ' ' || c == '\t' || c == '\n' || c == '\r') p++;
         else break;
        }
     }
   bool              Str(string &out)
     {
      if(StringGetCharacter(m, p) != '"') return false;
      p++;
      out = "";
      int run = p;
      while(p < len)
        {
         ushort c = StringGetCharacter(m, p);
         if(c == '"')
           {
            out += StringSubstr(m, run, p - run);
            p++;
            return true;
           }
         if(c == '\\')
           {
            out += StringSubstr(m, run, p - run);
            if(p + 1 >= len) return false;
            ushort e = StringGetCharacter(m, p + 1);
            p += 2;
            if(e == '"') out += "\"";
            else if(e == '\\') out += "\\";
            else if(e == '/') out += "/";
            else if(e == 'b') out += ShortToString(8);
            else if(e == 'f') out += ShortToString(12);
            else if(e == 'n') out += "\n";
            else if(e == 'r') out += "\r";
            else if(e == 't') out += "\t";
            else if(e == 'u')
              {
               if(p + 4 > len) return false;
               ushort code = 0;
               for(int i = 0; i < 4; i++)
                 {
                  ushort h = StringGetCharacter(m, p + i);
                  int v = (h >= '0' && h <= '9') ? h - '0' : (h >= 'a' && h <= 'f') ? h - 'a' + 10 : (h >= 'A' && h <= 'F') ? h - 'A' + 10 : -1;
                  if(v < 0) return false;
                  code = (ushort)(code * 16 + v);
                 }
               out += ShortToString(code);
               p += 4;
              }
            else return false;
            run = p;
            continue;
           }
         p++;
        }
      return false;
     }
   JNode            *Val(void)
     {
      Ws();
      if(p >= len) return NULL;
      ushort c = StringGetCharacter(m, p);
      JNode *node = new JNode();
      if(c == '{')
        {
         node.type = J_OBJ;
         p++;
         Ws();
         if(p < len && StringGetCharacter(m, p) == '}') { p++; return node; }
         while(p < len)
           {
            Ws();
            string k;
            if(!Str(k)) { delete node; return NULL; }
            Ws();
            if(p >= len || StringGetCharacter(m, p) != ':') { delete node; return NULL; }
            p++;
            JNode *v = Val();
            if(v == NULL) { delete node; return NULL; }
            node.Add(k, v);
            Ws();
            if(p < len && StringGetCharacter(m, p) == ',') { p++; continue; }
            if(p < len && StringGetCharacter(m, p) == '}') { p++; return node; }
            delete node;
            return NULL;
           }
         delete node;
         return NULL;
        }
      if(c == '[')
        {
         node.type = J_ARR;
         p++;
         Ws();
         if(p < len && StringGetCharacter(m, p) == ']') { p++; return node; }
         while(p < len)
           {
            JNode *v = Val();
            if(v == NULL) { delete node; return NULL; }
            node.Add("", v);
            Ws();
            if(p < len && StringGetCharacter(m, p) == ',') { p++; continue; }
            if(p < len && StringGetCharacter(m, p) == ']') { p++; return node; }
            delete node;
            return NULL;
           }
         delete node;
         return NULL;
        }
      if(c == '"')
        {
         node.type = J_STR;
         string sv;
         if(!Str(sv)) { delete node; return NULL; }
         node.s = sv;
         return node;
        }
      if(StringSubstr(m, p, 4) == "true")  { node.type = J_BOOL; node.b = true;  p += 4; return node; }
      if(StringSubstr(m, p, 5) == "false") { node.type = J_BOOL; node.b = false; p += 5; return node; }
      if(StringSubstr(m, p, 4) == "null")  { node.type = J_NULL; p += 4; return node; }
      int st = p;
      while(p < len)
        {
         ushort d = StringGetCharacter(m, p);
         if((d >= '0' && d <= '9') || d == '-' || d == '+' || d == '.' || d == 'e' || d == 'E') p++;
         else break;
        }
      if(p == st) { delete node; return NULL; }
      node.type = J_NUM;
      node.n = StringToDouble(StringSubstr(m, st, p - st));
      return node;
     }
public:
   JNode            *Parse(string text)
     {
      m = text;
      p = 0;
      len = StringLen(text);
      return Val();
     }
  };

//+------------------------------------------------------------------+
//| Log + chart panel                                                |
//+------------------------------------------------------------------+
void Log(string msg)
  {
   string line = TimeToString(TimeLocal(), TIME_SECONDS) + "  " + msg;
   Print("[FandamentalBridge] ", msg);
   int n = ArraySize(g_log);
   if(n >= 8)
     {
      for(int i = 1; i < n; i++) g_log[i - 1] = g_log[i];
      g_log[n - 1] = line;
     }
   else
     {
      ArrayResize(g_log, n + 1);
      g_log[n] = line;
     }
  }

string AccountKind(void)
  {
   long m = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(m == ACCOUNT_TRADE_MODE_DEMO) return "demo";
   if(m == ACCOUNT_TRADE_MODE_REAL) return "real";
   if(m == ACCOUNT_TRADE_MODE_CONTEST) return "contest";
   return "unknown";
  }

void Panel(void)
  {
   string ok = g_lastOk > 0 ? TimeToString(g_lastOk, TIME_SECONDS) : "never";
   string t = "Fandamental Bridge v" + EA_VERSION + "\n";
   t += "Server: " + g_status + "   (last OK " + ok + ")\n";
   t += "Account: " + AccountKind() + " #" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) +
        "   Mode: " + g_mode + (g_cfgEnabled ? "" : " (disabled in web app)") +
        "   Live: " + (g_live ? "ON" : "off") + "   EA orders: " + (InpExecutionEnabled ? "allowed" : "OFF") + "\n";
   t += "Pending reports: " + IntegerToString(ArraySize(g_qEid)) + "\n";
   t += "----------------------------------------\n";
   for(int i = ArraySize(g_log) - 1; i >= 0; i--) t += g_log[i] + "\n";
   Comment(t);
  }

//+------------------------------------------------------------------+
//| HTTP                                                             |
//+------------------------------------------------------------------+
string BaseUrl(void)
  {
   string u = InpServerUrl;
   StringTrimRight(u);
   StringTrimLeft(u);
   while(StringLen(u) > 0 && StringGetCharacter(u, StringLen(u) - 1) == '/')
      u = StringSubstr(u, 0, StringLen(u) - 1);
   return u;
  }

int Http(string method, string path, string body, string &resp, string &err)
  {
   string headers = "Content-Type: application/json\r\nAccept: application/json\r\nX-Terminal-Key: " + InpTerminalKey + "\r\n";
   char data[];
   if(body != "")
     {
      int n = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
      ArrayResize(data, n > 0 ? n - 1 : 0);   // drop the trailing \0
     }
   else
      ArrayResize(data, 0);
   char result[];
   string rh;
   ResetLastError();
   int code = WebRequest(method, BaseUrl() + path, headers, InpTimeoutMs, data, result, rh);
   if(code == -1)
     {
      int e = GetLastError();
      if(e == 4014)
         err = "WebRequest not allowed: add " + BaseUrl() + " in Tools > Options > Expert Advisors";
      else
         err = "network error " + IntegerToString(e);
      resp = "";
      return -1;
     }
   resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   err = "";
   return code;
  }

// Retries only transient failures (network, 429, 5xx). Bodies carry a fixed report_id, so a retry is idempotent on the server.
int HttpRetry(string method, string path, string body, string &resp, string &err, int attempts = 3)
  {
   int code = -1;
   for(int i = 0; i < attempts; i++)
     {
      code = Http(method, path, body, resp, err);
      if(code != -1 && code != 429 && code < 500) return code;
      if(i < attempts - 1) Sleep(400 * (i + 1) * (i + 1));
     }
   return code;
  }

string ErrMsg(string resp)
  {
   JParser P;
   JNode *r = P.Parse(resp);
   string m = "";
   if(r != NULL)
     {
      JNode *e = r.Get("error");
      if(e != NULL) m = e.Str("code") + ": " + e.Str("message");
      delete r;
     }
   return m == "" ? StringSubstr(resp, 0, 120) : m;
  }

string NewReportId(string eid)
  {
   return StringFormat("%I64u-%d-%s", GetMicrosecondCount(), MathRand(), eid);
  }

//+------------------------------------------------------------------+
//| Persistent report queue (survives terminal restarts)             |
//+------------------------------------------------------------------+
void SaveQueue(void)
  {
   int h = FileOpen(QUEUE_FILE, FILE_WRITE | FILE_TXT | FILE_ANSI, 0, CP_UTF8);
   if(h == INVALID_HANDLE) { Log("cannot write queue file, error " + IntegerToString(GetLastError())); return; }
   for(int i = 0; i < ArraySize(g_qEid); i++) FileWriteString(h, g_qEid[i] + "\t" + g_qBody[i] + "\r\n");
   FileClose(h);
  }

void LoadQueue(void)
  {
   ArrayResize(g_qEid, 0);
   ArrayResize(g_qBody, 0);
   if(!FileIsExist(QUEUE_FILE)) return;
   int h = FileOpen(QUEUE_FILE, FILE_READ | FILE_TXT | FILE_ANSI, 0, CP_UTF8);
   if(h == INVALID_HANDLE) return;
   while(!FileIsEnding(h))
     {
      string line = FileReadString(h);
      int tab = StringFind(line, "\t");
      if(tab <= 0) continue;
      int n = ArraySize(g_qEid);
      ArrayResize(g_qEid, n + 1);
      ArrayResize(g_qBody, n + 1);
      g_qEid[n] = StringSubstr(line, 0, tab);
      g_qBody[n] = StringSubstr(line, tab + 1);
     }
   FileClose(h);
  }

bool InQueue(string eid)
  {
   for(int i = 0; i < ArraySize(g_qEid); i++) if(g_qEid[i] == eid) return true;
   return false;
  }

void QueueRemove(int idx)
  {
   int n = ArraySize(g_qEid);
   for(int i = idx + 1; i < n; i++) { g_qEid[i - 1] = g_qEid[i]; g_qBody[i - 1] = g_qBody[i]; }
   ArrayResize(g_qEid, n - 1);
   ArrayResize(g_qBody, n - 1);
  }

// eid "close:<id>" routes to the /closed endpoint
void FlushQueue(void)
  {
   bool changed = false;
   for(int i = ArraySize(g_qEid) - 1; i >= 0; i--)
     {
      string eid = g_qEid[i], path;
      if(StringFind(eid, "close:") == 0) path = "/api/v1/ea/executions/" + StringSubstr(eid, 6) + "/closed";
      else path = "/api/v1/ea/executions/" + eid + "/report";
      string resp, err;
      int code = HttpRetry("POST", path, g_qBody[i], resp, err, 2);
      if(code == 200 || code == 404 || code == 409 || code == 422)
        {
         if(code != 200) Log("report for " + eid + " dropped by server: " + ErrMsg(resp));
         QueueRemove(i);
         changed = true;
        }
      else if(code == -1) { g_status = err; break; }   // offline: keep everything, try next tick
     }
   if(changed) SaveQueue();
  }

void QueueReport(string eid, string body)
  {
   int n = ArraySize(g_qEid);
   ArrayResize(g_qEid, n + 1);
   ArrayResize(g_qBody, n + 1);
   g_qEid[n] = eid;
   g_qBody[n] = body;
   SaveQueue();          // persisted BEFORE the network call
   FlushQueue();
  }

string ReportBody(string state, string reason, string sym = "", double reqPrice = 0, double fill = 0, double vol = 0,
                  double sl = 0, double tp = 0, string ticket = "", int retcode = 0, string eid = "")
  {
   string b = "{\"report_id\":" + JEsc(NewReportId(eid)) + ",\"state\":" + JEsc(state) + ",\"reason\":" + JEsc(StringSubstr(reason, 0, 290));
   if(sym != "") b += ",\"broker_symbol\":" + JEsc(sym);
   if(reqPrice > 0) b += ",\"requested_price\":" + JNum(reqPrice);
   if(fill > 0) b += ",\"fill_price\":" + JNum(fill);
   if(vol > 0) b += ",\"volume\":" + JNum(vol);
   if(sl > 0) b += ",\"sl\":" + JNum(sl);
   if(tp > 0) b += ",\"tp\":" + JNum(tp);
   if(ticket != "") b += ",\"ticket\":" + JEsc(ticket);
   if(retcode != 0) b += ",\"retcode\":" + IntegerToString(retcode);
   return b + "}";
  }

//+------------------------------------------------------------------+
//| Config from server                                               |
//+------------------------------------------------------------------+
void ApplyConfig(JNode *cfg)
  {
   if(cfg == NULL) return;
   g_cfgEnabled = cfg.Bool("enabled", false);
   g_mode = cfg.Str("mode", "notify");
   g_live = cfg.Bool("live_enabled", false);
   JNode *s = cfg.Get("settings");
   if(s == NULL) return;
   g_riskPercent = s.Num("risk_percent", 0.5);
   g_fixedLot = s.Num("fixed_lot", 0);
   g_maxLot = s.Num("max_lot", 0.10);
   g_maxSpreadPts = (int)s.Num("max_spread_points", 0);
   g_maxSpreadSlRatio = s.Num("max_spread_sl_ratio", 0.2);
   g_maxEntryDevSlRatio = s.Num("max_entry_dev_sl_ratio", 0.25);
   g_maxOpen = (int)s.Num("max_open_positions", 3);
   g_maxDailyLossPct = s.Num("max_daily_loss_percent", 3.0);
   g_tpIndex = (int)s.Num("tp_index", 1);
   g_srvSuffix = s.Str("symbol_suffix", "");
   ArrayResize(g_mapK, 0);
   ArrayResize(g_mapV, 0);
   JNode *mp = s.Get("symbol_map");
   if(mp != NULL && mp.type == J_OBJ)
     {
      int n = mp.Size();
      ArrayResize(g_mapK, n);
      ArrayResize(g_mapV, n);
      for(int i = 0; i < n; i++)
        {
         JNode *mv = mp.At(i);
         g_mapK[i] = mp.keys[i];
         g_mapV[i] = (mv != NULL && mv.type == J_STR) ? mv.s : "";
        }
     }
  }

//+------------------------------------------------------------------+
//| Symbol resolution: web-app symbol -> broker symbol                |
//+------------------------------------------------------------------+
bool TrySym(string name)
  {
   if(name == "") return false;
   bool custom = false;
   if(!SymbolExist(name, custom)) return false;
   return SymbolSelect(name, true);
  }

void Aliases(string c, string &out[])
  {
   ArrayResize(out, 0);
   string a = "";
   if(c == "XAUUSD") a = "GOLD";
   else if(c == "XAGUSD") a = "SILVER";
   else if(c == "USOIL") a = "WTI,XTIUSD,USOUSD,CL-OIL,OILUSD";
   else if(c == "SPX") a = "US500,SPX500,US500CASH,SP500";
   else if(c == "NDX") a = "US100,NAS100,USTEC,NDX100";
   else if(c == "DJI") a = "US30,DJ30,WS30,DJI30";
   else if(c == "DXY") a = "USDX,DX";
   if(StringLen(c) > 4 && StringSubstr(c, StringLen(c) - 4) == "USDT")
      a = StringSubstr(c, 0, StringLen(c) - 4) + "USD" + (a == "" ? "" : "," + a);
   if(a != "") StringSplit(a, ',', out);
  }

bool ResolveSymbol(string canon, string &out, string &why)
  {
   out = "";
   if(StringFind(canon, "TSE-") == 0) { why = "Tehran Stock Exchange symbols are not tradable in MT5"; return false; }
   for(int i = 0; i < ArraySize(g_mapK); i++)
      if(g_mapK[i] == canon)
        {
         if(TrySym(g_mapV[i])) { out = g_mapV[i]; return true; }
         why = "mapped symbol " + g_mapV[i] + " not found at this broker";
         return false;
        }
   string bases[];
   Aliases(canon, bases);
   int nb = ArraySize(bases);
   ArrayResize(bases, nb + 1);
   for(int i = nb; i > 0; i--) bases[i] = bases[i - 1];
   bases[0] = canon;
   string sfx[3];
   sfx[0] = g_srvSuffix; sfx[1] = InpSymbolSuffix; sfx[2] = "";
   for(int b = 0; b < ArraySize(bases); b++)
      for(int k = 0; k < 3; k++)
        {
         if(k < 2 && sfx[k] == "") continue;
         if(TrySym(bases[b] + sfx[k])) { out = bases[b] + sfx[k]; return true; }
        }
   // last resort: a broker symbol that starts with the name and only adds a short suffix (EURUSDm, XAUUSD.pro ...)
   int total = SymbolsTotal(false);
   for(int b = 0; b < ArraySize(bases); b++)
     {
      string best = "";
      for(int i = 0; i < total; i++)
        {
         string nm = SymbolName(i, false);
         if(StringFind(nm, bases[b]) == 0 && StringLen(nm) <= StringLen(bases[b]) + 6)
            if(best == "" || StringLen(nm) < StringLen(best)) best = nm;
        }
      if(best != "" && SymbolSelect(best, true)) { out = best; return true; }
     }
   why = "symbol " + canon + " not found at this broker (set a symbol map / suffix in the web app)";
   return false;
  }

//+------------------------------------------------------------------+
//| Broker lookups                                                   |
//+------------------------------------------------------------------+
// 0 = not found, 1 = position/deal exists, 2 = pending order exists, 3 = order existed but was cancelled/expired
int FindByTag(string tag, string &ticket)
  {
   ticket = "";
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t > 0 && PositionGetString(POSITION_COMMENT) == tag) { ticket = IntegerToString((long)PositionGetInteger(POSITION_IDENTIFIER)); return 1; }
     }
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong t = OrderGetTicket(i);
      if(t > 0 && OrderGetString(ORDER_COMMENT) == tag) { ticket = IntegerToString((long)t); return 2; }
     }
   if(HistorySelect(TimeCurrent() - 30 * 86400, TimeCurrent() + 86400))
     {
      for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
        {
         ulong d = HistoryDealGetTicket(i);
         if(d > 0 && HistoryDealGetString(d, DEAL_COMMENT) == tag && HistoryDealGetInteger(d, DEAL_ENTRY) == DEAL_ENTRY_IN)
           { ticket = IntegerToString(HistoryDealGetInteger(d, DEAL_POSITION_ID)); return 1; }
        }
      for(int i = HistoryOrdersTotal() - 1; i >= 0; i--)
        {
         ulong o = HistoryOrderGetTicket(i);
         if(o > 0 && HistoryOrderGetString(o, ORDER_COMMENT) == tag)
           {
            ticket = IntegerToString((long)o);
            long st = HistoryOrderGetInteger(o, ORDER_STATE);
            if(st == ORDER_STATE_FILLED || st == ORDER_STATE_PARTIAL) return 1;
            return 3;
           }
        }
     }
   return 0;
  }

int OpenFaCount(string sym, bool &symBusy)
  {
   int n = 0;
   symBusy = false;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(PositionGetTicket(i) == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      n++;
      if(PositionGetString(POSITION_SYMBOL) == sym) symBusy = true;
     }
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      if(OrderGetTicket(i) == 0) continue;
      if(OrderGetInteger(ORDER_MAGIC) != InpMagic) continue;
      n++;
      if(OrderGetString(ORDER_SYMBOL) == sym) symBusy = true;
     }
   return n;
  }

double TodayPnl(void)
  {
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   dt.hour = 0; dt.min = 0; dt.sec = 0;
   datetime start = StructToTime(dt);
   double pnl = 0;
   if(HistorySelect(start, TimeCurrent() + 60))
      for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
        {
         ulong d = HistoryDealGetTicket(i);
         if(d == 0 || HistoryDealGetInteger(d, DEAL_MAGIC) != InpMagic) continue;
         pnl += HistoryDealGetDouble(d, DEAL_PROFIT) + HistoryDealGetDouble(d, DEAL_SWAP) + HistoryDealGetDouble(d, DEAL_COMMISSION);
        }
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(PositionGetTicket(i) == 0 || PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      pnl += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
     }
   return pnl;
  }

//+------------------------------------------------------------------+
//| Display                                                          |
//+------------------------------------------------------------------+
void DrawLevels(string eid, string sym, double entry, double sl, double tp)
  {
   if(!InpDrawLevels || sym != _Symbol) return;
   string base = "FA_" + eid + "_";
   double v[3]; v[0] = entry; v[1] = sl; v[2] = tp;
   color  c[3]; c[0] = clrDodgerBlue; c[1] = clrTomato; c[2] = clrMediumSeaGreen;
   string t[3]; t[0] = "FA entry"; t[1] = "FA SL"; t[2] = "FA TP";
   for(int i = 0; i < 3; i++)
     {
      string nm = base + IntegerToString(i);
      ObjectDelete(0, nm);
      if(ObjectCreate(0, nm, OBJ_HLINE, 0, 0, v[i]))
        {
         ObjectSetInteger(0, nm, OBJPROP_COLOR, c[i]);
         ObjectSetInteger(0, nm, OBJPROP_STYLE, STYLE_DASH);
         ObjectSetString(0, nm, OBJPROP_TEXT, t[i]);
         ObjectSetInteger(0, nm, OBJPROP_BACK, true);
        }
     }
   ChartRedraw(0);
  }

void Announce(string text)
  {
   Log(text);
   if(InpShowAlerts) Alert("Fandamental: ", text);
   if(InpPushNotifications) SendNotification("Fandamental: " + text);
  }

//+------------------------------------------------------------------+
//| Order helpers                                                    |
//+------------------------------------------------------------------+
double RoundToTick(string sym, double price)
  {
   double ts = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   if(ts > 0) price = MathRound(price / ts) * ts;
   return NormalizeDouble(price, dg);
  }

double NormalizeVolume(string sym, double v)
  {
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double vmax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double lim = SymbolInfoDouble(sym, SYMBOL_VOLUME_LIMIT);
   if(step <= 0) step = 0.01;
   v = MathFloor(v / step + 1e-9) * step;
   if(vmax > 0 && v > vmax) v = vmax;
   if(lim > 0 && v > lim) v = lim;
   int vd = (int)MathMax(0, MathCeil(-MathLog10(step) - 1e-9));
   return NormalizeDouble(v, vd);
  }

bool FillAndCheck(MqlTradeRequest &req, string &why)
  {
   ENUM_ORDER_TYPE_FILLING modes[3];
   modes[0] = ORDER_FILLING_FOK; modes[1] = ORDER_FILLING_IOC; modes[2] = ORDER_FILLING_RETURN;
   long fm = SymbolInfoInteger(req.symbol, SYMBOL_FILLING_MODE);
   string last = "";
   for(int i = 0; i < 3; i++)
     {
      if(i == 0 && (fm & SYMBOL_FILLING_FOK) == 0 && req.action == TRADE_ACTION_DEAL) continue;
      if(i == 1 && (fm & SYMBOL_FILLING_IOC) == 0 && req.action == TRADE_ACTION_DEAL) continue;
      req.type_filling = modes[i];
      MqlTradeCheckResult chk;
      ZeroMemory(chk);
      bool ok = OrderCheck(req, chk);
      if(ok && (chk.retcode == 0 || chk.retcode == TRADE_RETCODE_DONE)) return true;
      last = IntegerToString(chk.retcode) + " " + chk.comment;
      if(chk.retcode != TRADE_RETCODE_INVALID_FILL) break;   // other errors will not be fixed by another filling mode
     }
   why = "OrderCheck failed: " + last;
   return false;
  }

//+------------------------------------------------------------------+
//| Execute one signal (all checks, then sending->go, then OrderSend) |
//+------------------------------------------------------------------+
void Execute(string eid, string tag, JNode *sig, double expiresIn)
  {
   string canon = sig.Str("symbol"), dir = sig.Str("direction"), otype = sig.Str("order_type", "market");
   double entry = sig.Num("entry"), sl = sig.Num("sl"), tp = sig.Num("tp");
   if(g_tpIndex == 2 && sig.Has("tp2")) tp = sig.Num("tp2");
   if(g_tpIndex == 3 && sig.Has("tp3")) tp = sig.Num("tp3");
   bool buy = (dir == "buy");
   string why = "", sym = "";

   // --- local gates
   if(!InpExecutionEnabled) { QueueReport(eid, ReportBody("rejected", "order execution disabled in EA inputs", "", 0, 0, 0, 0, 0, "", 0, eid)); return; }
   if(expiresIn <= 0) { QueueReport(eid, ReportBody("rejected", "signal expired", "", 0, 0, 0, 0, 0, "", 0, eid)); return; }
   string kind = AccountKind();
   if(kind != "demo" && !InpAllowRealAccount) { QueueReport(eid, ReportBody("rejected", "real account and AllowRealAccount=false", "", 0, 0, 0, 0, 0, "", 0, eid)); return; }
   if(kind != "demo" && !g_live) { QueueReport(eid, ReportBody("rejected", "real account: live trading not enabled in the web app", "", 0, 0, 0, 0, 0, "", 0, eid)); return; }
   if(!TerminalInfoInteger(TERMINAL_CONNECTED)) why = "terminal not connected to the broker";
   else if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) why = "Algo Trading button is off in the terminal";
   else if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) why = "'Allow Algo Trading' is off in this EA's properties";
   else if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)) why = "trading is not allowed on this account (investor password?)";
   else if(!AccountInfoInteger(ACCOUNT_TRADE_EXPERT)) why = "broker does not allow expert advisors on this account";
   if(why != "") { QueueReport(eid, ReportBody("rejected", why, "", 0, 0, 0, 0, 0, "", 0, eid)); return; }

   // --- never execute the same execution twice
   string tk;
   int found = FindByTag(tag, tk);
   if(found == 1 || found == 2)
     {
      Log("already executed at broker (" + tag + "), reporting instead of sending again");
      QueueReport(eid, ReportBody(found == 1 ? "filled" : "placed", "found existing order with this tag; not sent again", "", 0, 0, 0, 0, 0, tk, 0, eid));
      return;
     }

   // --- symbol
   if(!ResolveSymbol(canon, sym, why)) { QueueReport(eid, ReportBody("rejected", why, "", 0, 0, 0, 0, 0, "", 0, eid)); return; }
   long tmode = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
   if(tmode == SYMBOL_TRADE_MODE_DISABLED || tmode == SYMBOL_TRADE_MODE_CLOSEONLY ||
      (buy && tmode == SYMBOL_TRADE_MODE_SHORTONLY) || (!buy && tmode == SYMBOL_TRADE_MODE_LONGONLY))
     { QueueReport(eid, ReportBody("rejected", "broker does not allow this direction on " + sym, sym, 0, 0, 0, 0, 0, "", 0, eid)); return; }

   // --- exposure limits
   bool symBusy;
   int open = OpenFaCount(sym, symBusy);
   if(symBusy) { QueueReport(eid, ReportBody("rejected", "a Fandamental position/order is already open on " + sym, sym, 0, 0, 0, 0, 0, "", 0, eid)); return; }
   if(open >= g_maxOpen) { QueueReport(eid, ReportBody("rejected", StringFormat("max open positions reached (%d)", g_maxOpen), sym, 0, 0, 0, 0, 0, "", 0, eid)); return; }
   if(AccountInfoInteger(ACCOUNT_MARGIN_MODE) == ACCOUNT_MARGIN_MODE_RETAIL_NETTING && PositionSelect(sym))
     { QueueReport(eid, ReportBody("rejected", "netting account already has a position on " + sym, sym, 0, 0, 0, 0, 0, "", 0, eid)); return; }
   double bal = AccountInfoDouble(ACCOUNT_BALANCE);
   if(g_maxDailyLossPct > 0)
     {
      double pnl = TodayPnl();
      if(pnl <= -bal * g_maxDailyLossPct / 100.0)
        { QueueReport(eid, ReportBody("rejected", StringFormat("daily loss limit hit (%.2f, limit %.1f%%)", pnl, g_maxDailyLossPct), sym, 0, 0, 0, 0, 0, "", 0, eid)); return; }
     }

   // --- prices
   MqlTick q;
   if(!SymbolInfoTick(sym, q) || q.ask <= 0 || q.bid <= 0) { QueueReport(eid, ReportBody("rejected", "no quote for " + sym, sym, 0, 0, 0, 0, 0, "", 0, eid)); return; }
   if(TimeTradeServer() - q.time > InpMaxQuoteAgeSec) { QueueReport(eid, ReportBody("rejected", "quote is stale (market closed?)", sym, 0, 0, 0, 0, 0, "", 0, eid)); return; }
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double risk = MathAbs(entry - sl);
   if(risk <= 0) { QueueReport(eid, ReportBody("rejected", "invalid stop loss", sym, 0, 0, 0, 0, 0, "", 0, eid)); return; }
   double spread = q.ask - q.bid;
   if(g_maxSpreadPts > 0 && spread / point > g_maxSpreadPts)
     { QueueReport(eid, ReportBody("rejected", StringFormat("spread %.0f pts > max %d", spread / point, g_maxSpreadPts), sym, 0, 0, 0, 0, 0, "", 0, eid)); return; }
   if(g_maxSpreadSlRatio > 0 && spread > g_maxSpreadSlRatio * risk)
     { QueueReport(eid, ReportBody("rejected", StringFormat("spread is %.0f%% of the stop distance (max %.0f%%)", 100 * spread / risk, 100 * g_maxSpreadSlRatio), sym, 0, 0, 0, 0, 0, "", 0, eid)); return; }

   double px = buy ? q.ask : q.bid;
   bool pending = false;
   if(otype == "limit")
      pending = buy ? (entry < q.ask) : (entry > q.bid);  // otherwise price already reached the entry -> market
   double ref = pending ? entry : px;
   if(buy ? (px <= sl || px >= tp) : (px >= sl || px <= tp))
     { QueueReport(eid, ReportBody("rejected", "price already beyond SL or TP", sym, px, 0, 0, 0, 0, "", 0, eid)); return; }
   if(!pending)
     {
      double dev = buy ? (px - entry) : (entry - px);   // >0 = worse than the signal's entry
      if(g_maxEntryDevSlRatio > 0 && dev > g_maxEntryDevSlRatio * risk)
        { QueueReport(eid, ReportBody("rejected", StringFormat("price moved %.0f%% of the stop distance past the entry (max %.0f%%)", 100 * dev / risk, 100 * g_maxEntryDevSlRatio), sym, px, 0, 0, 0, 0, "", 0, eid)); return; }
     }
   double stops = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * point;
   double slRef = pending ? entry : (buy ? q.bid : q.ask);
   if(MathAbs(slRef - sl) < stops || MathAbs(tp - slRef) < stops || (pending && MathAbs(px - entry) < stops))
     { QueueReport(eid, ReportBody("rejected", "SL/TP/entry closer than the broker's stops level", sym, px, 0, 0, 0, 0, "", 0, eid)); return; }
   if(pending && !((SymbolInfoInteger(sym, SYMBOL_EXPIRATION_MODE) & SYMBOL_EXPIRATION_SPECIFIED) == SYMBOL_EXPIRATION_SPECIFIED))
     { QueueReport(eid, ReportBody("rejected", "broker does not support order expiry; a limit order could outlive the signal", sym, 0, 0, 0, 0, 0, "", 0, eid)); return; }

   // --- volume from risk
   double vol = 0;
   if(g_fixedLot > 0) vol = g_fixedLot;
   else
     {
      double loss1 = 0;
      if(!OrderCalcProfit(buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, sym, 1.0, ref, sl, loss1) || loss1 >= 0)
        { QueueReport(eid, ReportBody("rejected", "cannot compute the loss per lot for " + sym, sym, 0, 0, 0, 0, 0, "", 0, eid)); return; }
      double equity = AccountInfoDouble(ACCOUNT_EQUITY);
      vol = (MathMin(bal, equity) * g_riskPercent / 100.0) / (-loss1);
     }
   if(g_maxLot > 0 && vol > g_maxLot) vol = g_maxLot;
   vol = NormalizeVolume(sym, vol);
   double vmin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   if(vol < vmin || vol <= 0)
     { QueueReport(eid, ReportBody("rejected", StringFormat("risk budget allows %.4f lots, below the broker minimum %.2f", vol, vmin), sym, 0, 0, 0, 0, 0, "", 0, eid)); return; }

   // --- build + pre-check request
   MqlTradeRequest req;
   ZeroMemory(req);
   req.symbol = sym;
   req.volume = vol;
   req.magic = InpMagic;
   req.comment = tag;
   req.deviation = (ulong)InpSlippagePoints;
   req.sl = RoundToTick(sym, sl);
   req.tp = RoundToTick(sym, tp);
   if(pending)
     {
      req.action = TRADE_ACTION_PENDING;
      req.type = buy ? ORDER_TYPE_BUY_LIMIT : ORDER_TYPE_SELL_LIMIT;
      req.price = RoundToTick(sym, entry);
      req.type_time = ORDER_TIME_SPECIFIED;
      req.expiration = TimeTradeServer() + (int)MathMax(60, expiresIn);
     }
   else
     {
      req.action = TRADE_ACTION_DEAL;
      req.type = buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
      req.price = RoundToTick(sym, px);
     }
   if(!FillAndCheck(req, why)) { QueueReport(eid, ReportBody("rejected", why, sym, req.price, 0, vol, req.sl, req.tp, "", 0, eid)); return; }

   // --- ask the server for the go (re-checks expiry / mode / live permission). No go -> no order.
   string rid = NewReportId(eid);
   string body = "{\"report_id\":" + JEsc(rid) + ",\"state\":\"sending\",\"broker_symbol\":" + JEsc(sym) + ",\"requested_price\":" + JNum(req.price) +
                 ",\"volume\":" + JNum(vol) + ",\"sl\":" + JNum(req.sl) + ",\"tp\":" + JNum(req.tp) + "}";
   string resp, err;
   int code = HttpRetry("POST", "/api/v1/ea/executions/" + eid + "/report", body, resp, err, 3);
   bool go = false;
   if(code == 200)
     {
      JParser P;
      JNode *r = P.Parse(resp);
      if(r != NULL) { go = r.Bool("go", false); delete r; }
     }
   if(!go)
     {
      Log("no go for " + canon + " (" + (code == -1 ? err : ErrMsg(resp)) + ") - order NOT sent");
      return;
     }

   // --- send (requote / price-change retries are safe: the previous attempt was not executed)
   MqlTradeResult res;
   ZeroMemory(res);
   for(int attempt = 0; attempt < 3; attempt++)
     {
      if(!pending && attempt > 0)
        {
         if(!SymbolInfoTick(sym, q)) break;
         px = buy ? q.ask : q.bid;
         double dev2 = buy ? (px - entry) : (entry - px);
         if(g_maxEntryDevSlRatio > 0 && dev2 > g_maxEntryDevSlRatio * risk)
           { QueueReport(eid, ReportBody("rejected", "price ran away during requote", sym, px, 0, vol, req.sl, req.tp, "", 0, eid)); return; }
         req.price = RoundToTick(sym, px);
        }
      ZeroMemory(res);
      ResetLastError();
      if(!OrderSend(req, res)) Log(StringFormat("OrderSend returned false: retcode %u, error %d", res.retcode, GetLastError()));
      uint rc0 = res.retcode;
      if(rc0 == TRADE_RETCODE_REQUOTE || rc0 == TRADE_RETCODE_PRICE_CHANGED || rc0 == TRADE_RETCODE_PRICE_OFF) { Sleep(300); continue; }
      break;
     }

   uint rc = res.retcode;
   double fill = res.price;
   string ticket = res.order > 0 ? IntegerToString((long)res.order) : "";
   if(res.deal > 0 && HistoryDealSelect(res.deal))
     {
      if(fill <= 0) fill = HistoryDealGetDouble(res.deal, DEAL_PRICE);
      ticket = IntegerToString(HistoryDealGetInteger(res.deal, DEAL_POSITION_ID));
     }
   if(rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_DONE_PARTIAL)
     {
      string note = rc == TRADE_RETCODE_DONE_PARTIAL ? "partial fill" : "";
      if(fill > 0 && point > 0) note += (note == "" ? "" : "; ") + StringFormat("slippage %.0f pts", (buy ? fill - req.price : req.price - fill) / point);
      QueueReport(eid, ReportBody("filled", note, sym, req.price, fill, res.volume > 0 ? res.volume : vol, req.sl, req.tp, ticket, (int)rc, eid));
      Announce(StringFormat("%s %s %.2f lots filled @ %s (SL %s TP %s)", buy ? "BUY" : "SELL", sym, vol,
                            DoubleToString(fill, (int)SymbolInfoInteger(sym, SYMBOL_DIGITS)), DoubleToString(req.sl, (int)SymbolInfoInteger(sym, SYMBOL_DIGITS)),
                            DoubleToString(req.tp, (int)SymbolInfoInteger(sym, SYMBOL_DIGITS))));
     }
   else if(rc == TRADE_RETCODE_PLACED)
     {
      QueueReport(eid, ReportBody("placed", "limit order placed", sym, req.price, 0, vol, req.sl, req.tp, ticket, (int)rc, eid));
      Announce(StringFormat("%s LIMIT %s %.2f lots @ %s placed", buy ? "BUY" : "SELL", sym, vol, DoubleToString(req.price, (int)SymbolInfoInteger(sym, SYMBOL_DIGITS))));
     }
   else if(rc == TRADE_RETCODE_TIMEOUT || rc == TRADE_RETCODE_CONNECTION || rc == 0)
     {
      // outcome not known: report "unknown" - the server will NOT re-send; the EA reconciles by tag on the next polls
      QueueReport(eid, ReportBody("unknown", StringFormat("send outcome unknown (retcode %u, err %d)", rc, GetLastError()), sym, req.price, 0, vol, req.sl, req.tp, "", (int)rc, eid));
      Log("order outcome unknown for " + sym + "; will reconcile");
     }
   else
     {
      QueueReport(eid, ReportBody("failed", StringFormat("broker rejected: %u %s", rc, res.comment), sym, req.price, 0, vol, req.sl, req.tp, "", (int)rc, eid));
      Log(StringFormat("order rejected by broker: %u %s", rc, res.comment));
     }
  }

//+------------------------------------------------------------------+
//| Reconcile "unknown" executions & report closed positions         |
//+------------------------------------------------------------------+
void Reconcile(string eid, string tag)
  {
   if(InQueue(eid)) return;
   string tk;
   int f = FindByTag(tag, tk);
   string state = f == 1 ? "filled" : f == 2 ? "placed" : f == 3 ? "failed" : "not_found";
   string why = f == 3 ? "order found but it was cancelled/expired" : f == 0 ? "no order with this tag at the broker" : "found at broker during reconciliation";
   Log("reconcile " + tag + " -> " + state);
   QueueReport(eid, ReportBody(state, why, "", 0, 0, 0, 0, 0, tk, 0, eid));
  }

string DealReasonName(long r)
  {
   if(r == DEAL_REASON_SL) return "sl";
   if(r == DEAL_REASON_TP) return "tp";
   if(r == DEAL_REASON_SO) return "stop_out";
   if(r == DEAL_REASON_EXPERT) return "expert";
   if(r == DEAL_REASON_CLIENT || r == DEAL_REASON_MOBILE || r == DEAL_REASON_WEB) return "manual";
   return "other";
  }

void WatchClose(string eid, string ticket)
  {
   if(InQueue("close:" + eid)) return;
   long pid = StringToInteger(ticket);
   if(pid <= 0) return;
   if(PositionSelectByTicket((ulong)pid)) return;           // still open
   if(!HistorySelectByPosition(pid)) return;
   double profit = 0, closePx = 0;
   datetime closedAt = 0;
   long reason = -1;
   bool anyOut = false;
   for(int i = 0; i < HistoryDealsTotal(); i++)
     {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0) continue;
      profit += HistoryDealGetDouble(d, DEAL_PROFIT) + HistoryDealGetDouble(d, DEAL_SWAP) + HistoryDealGetDouble(d, DEAL_COMMISSION);
      long en = HistoryDealGetInteger(d, DEAL_ENTRY);
      if(en == DEAL_ENTRY_OUT || en == DEAL_ENTRY_OUT_BY || en == DEAL_ENTRY_INOUT)
        {
         anyOut = true;
         datetime t = (datetime)HistoryDealGetInteger(d, DEAL_TIME);
         if(t >= closedAt) { closedAt = t; closePx = HistoryDealGetDouble(d, DEAL_PRICE); reason = HistoryDealGetInteger(d, DEAL_REASON); }
        }
     }
   if(!anyOut) return;   // history not loaded yet / position not found; try again later
   string body = "{\"report_id\":" + JEsc(NewReportId(eid)) + ",\"close_price\":" + JNum(closePx) + ",\"profit\":" + JNum(profit, 2) +
                 ",\"closed_at\":" + IntegerToString((long)closedAt) + ",\"close_reason\":" + JEsc(DealReasonName(reason)) + "}";
   Log(StringFormat("position %s closed (%s), P/L %.2f", ticket, DealReasonName(reason), profit));
   QueueReport("close:" + eid, body);
  }

//+------------------------------------------------------------------+
//| Main cycle                                                       |
//+------------------------------------------------------------------+
bool Heartbeat(void)
  {
   string body = "{\"login\":" + JEsc(IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))) +
                 ",\"server\":" + JEsc(AccountInfoString(ACCOUNT_SERVER)) +
                 ",\"company\":" + JEsc(AccountInfoString(ACCOUNT_COMPANY)) +
                 ",\"trade_mode\":" + JEsc(AccountKind()) +
                 ",\"currency\":" + JEsc(AccountInfoString(ACCOUNT_CURRENCY)) +
                 ",\"balance\":" + JNum(AccountInfoDouble(ACCOUNT_BALANCE), 2) +
                 ",\"equity\":" + JNum(AccountInfoDouble(ACCOUNT_EQUITY), 2) +
                 ",\"trade_allowed\":" + ((TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED)) ? "true" : "false") +
                 ",\"ea_allow_real\":" + (InpAllowRealAccount ? "true" : "false") +
                 ",\"ea_version\":" + JEsc(EA_VERSION) + "}";
   string resp, err;
   int code = HttpRetry("POST", "/api/v1/ea/heartbeat", body, resp, err, 2);
   g_lastHeartbeat = TimeLocal();
   if(code == 200)
     {
      JParser P;
      JNode *r = P.Parse(resp);
      if(r != NULL) { ApplyConfig(r); delete r; }
      g_bound = true;
      g_status = "connected";
      g_lastOk = TimeLocal();
      return true;
     }
   g_bound = false;
   if(code == -1) g_status = err;
   else if(code == 401) g_status = "invalid terminal key";
   else g_status = "heartbeat failed: " + ErrMsg(resp);
   return false;
  }

void Poll(void)
  {
   string resp, err;
   int code = HttpRetry("GET", "/api/v1/ea/pending", "", resp, err, 2);
   if(code != 200)
     {
      g_status = code == -1 ? err : (code == 401 ? "invalid terminal key" : "poll failed: " + ErrMsg(resp));
      return;
     }
   JParser P;
   JNode *r = P.Parse(resp);
   if(r == NULL) { g_status = "bad JSON from server"; return; }
   g_status = "connected";
   g_lastOk = TimeLocal();
   ApplyConfig(r.Get("config"));
   if(!r.Bool("bound", false)) g_bound = false;

   JNode *rec = r.Get("reconcile");
   if(rec != NULL)
      for(int i = 0; i < rec.Size(); i++)
        {
         JNode *rc = rec.At(i);
         if(rc != NULL) Reconcile(rc.Str("execution_id"), rc.Str("tag"));
        }

   JNode *items = r.Get("items");
   if(items != NULL)
      for(int i = 0; i < items.Size(); i++)
        {
         JNode *it = items.At(i);
         if(it == NULL) continue;
         string eid = it.Str("execution_id"), action = it.Str("action"), tag = it.Str("tag");
         JNode *sig = it.Get("signal");
         if(sig == NULL || eid == "" || InQueue(eid)) continue;
         string text = StringFormat("%s %s @ %s  SL %s  TP %s  [%s, confluence %s]", sig.Str("direction") == "buy" ? "BUY" : "SELL",
                                    sig.Str("symbol"), sig.Str("entry"), sig.Str("sl"), sig.Str("tp"), sig.Str("timeframe"), sig.Str("confluence", "-"));
         string sym, why;
         if(action == "notify")
           {
            bool okSym = ResolveSymbol(sig.Str("symbol"), sym, why);
            Announce("signal: " + text + (okSym ? "" : "  (" + why + ")"));
            if(okSym) DrawLevels(eid, sym, sig.Num("entry"), sig.Num("sl"), sig.Num("tp"));
            QueueReport(eid, ReportBody("displayed", okSym ? "" : why, sym, 0, 0, 0, 0, 0, "", 0, eid));
           }
         else
           {
            Log("execute: " + text);
            if(ResolveSymbol(sig.Str("symbol"), sym, why)) DrawLevels(eid, sym, sig.Num("entry"), sig.Num("sl"), sig.Num("tp"));
            Execute(eid, tag, sig, it.Num("expires_in_sec", 0));
           }
        }

   JNode *watch = r.Get("watch");
   if(watch != NULL)
      for(int i = 0; i < watch.Size(); i++)
        {
         JNode *w = watch.At(i);
         if(w != NULL) WatchClose(w.Str("execution_id"), w.Str("ticket"));
        }
   delete r;
  }

//+------------------------------------------------------------------+
int OnInit(void)
  {
   if(MQLInfoInteger(MQL_TESTER)) { Print("FandamentalBridge: WebRequest does not work in the Strategy Tester. Run it on a demo chart."); return INIT_FAILED; }
   if(StringFind(InpTerminalKey, "fa_t_") != 0) { Alert("FandamentalBridge: set the terminal key (fa_t_...) from the web app's MT5 tab."); return INIT_PARAMETERS_INCORRECT; }
   string u = BaseUrl();
   bool local = StringFind(u, "http://127.0.0.1") == 0 || StringFind(u, "http://localhost") == 0;
   if(StringFind(u, "https://") != 0 && !local) { Alert("FandamentalBridge: the server URL must start with https://"); return INIT_PARAMETERS_INCORRECT; }
   if(InpPollSeconds < 1) return INIT_PARAMETERS_INCORRECT;
   MathSrand((uint)GetTickCount());
   FolderCreate("FandamentalBridge");
   LoadQueue();
   if(ArraySize(g_qEid) > 0) Log(IntegerToString(ArraySize(g_qEid)) + " unsent report(s) restored from disk");
   Log("started on " + AccountKind() + " account #" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)));
   if(AccountKind() != "demo") Log("REAL account: orders need AllowRealAccount=true here AND live trading enabled in the web app");
   g_ready = true;
   EventSetTimer(InpPollSeconds);
   OnTimer();
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   SaveQueue();
   Comment("");
  }

void OnTimer(void)
  {
   if(!g_ready) return;
   if(!g_bound || TimeLocal() - g_lastHeartbeat >= 15) Heartbeat();
   if(g_bound)
     {
      FlushQueue();
      Poll();
     }
   Panel();
  }

void OnTick(void) { }
//+------------------------------------------------------------------+
