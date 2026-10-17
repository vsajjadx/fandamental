-- 0001: initial schema for the MT5 bridge.
-- Additive only. Never edit an applied migration; add a new numbered file instead.

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  disabled    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- API keys used by the web app (one user can hold several; only a SHA-256 hash is stored)
CREATE TABLE IF NOT EXISTS api_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  key_hash    TEXT    NOT NULL UNIQUE,
  prefix      TEXT    NOT NULL,
  label       TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

-- One row per MetaTrader 5 terminal/account the user connects.
CREATE TABLE IF NOT EXISTS accounts (
  id                      TEXT    PRIMARY KEY,
  user_id                 INTEGER NOT NULL REFERENCES users(id),
  name                    TEXT    NOT NULL,
  enabled                 INTEGER NOT NULL DEFAULT 1,
  mode                    TEXT    NOT NULL DEFAULT 'notify' CHECK (mode IN ('notify','confirm','auto')),
  live_enabled            INTEGER NOT NULL DEFAULT 0,
  live_enabled_at         INTEGER,
  terminal_key_hash       TEXT    NOT NULL UNIQUE,
  terminal_key_prefix     TEXT    NOT NULL,
  -- risk settings (enforced by the EA, echoed on every heartbeat/poll)
  risk_percent            REAL    NOT NULL DEFAULT 0.5,
  fixed_lot               REAL,
  max_lot                 REAL    NOT NULL DEFAULT 0.10,
  max_spread_points       INTEGER NOT NULL DEFAULT 0,
  max_spread_sl_ratio     REAL    NOT NULL DEFAULT 0.20,
  max_entry_dev_sl_ratio  REAL    NOT NULL DEFAULT 0.25,
  max_open_positions      INTEGER NOT NULL DEFAULT 3,
  max_daily_loss_percent  REAL    NOT NULL DEFAULT 3.0,
  tp_index                INTEGER NOT NULL DEFAULT 1 CHECK (tp_index IN (1,2,3)),
  symbol_suffix           TEXT    NOT NULL DEFAULT '',
  symbol_map              TEXT    NOT NULL DEFAULT '{}',
  allowed_symbols         TEXT    NOT NULL DEFAULT '[]',
  -- reported by the EA
  mt5_login               TEXT,
  mt5_server              TEXT,
  mt5_company             TEXT,
  mt5_trade_mode          TEXT,
  mt5_currency            TEXT,
  balance                 REAL,
  equity                  REAL,
  trade_allowed           INTEGER,
  ea_version              TEXT,
  ea_allow_real           INTEGER,
  last_seen_at            INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_accounts_user ON accounts(user_id);

-- Signals produced by the web app (the analysis engine stays in the browser).
CREATE TABLE IF NOT EXISTS signals (
  id                TEXT    PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  client_signal_id  TEXT    NOT NULL,
  symbol            TEXT    NOT NULL,
  direction         TEXT    NOT NULL CHECK (direction IN ('buy','sell')),
  order_type        TEXT    NOT NULL DEFAULT 'market' CHECK (order_type IN ('market','limit')),
  entry             REAL    NOT NULL,
  sl                REAL    NOT NULL,
  tp                REAL    NOT NULL,
  tp2               REAL,
  tp3               REAL,
  timeframe         TEXT    NOT NULL,
  confluence        INTEGER,
  signal_type       TEXT,
  source            TEXT    NOT NULL DEFAULT 'web',
  note              TEXT    NOT NULL DEFAULT '',
  generated_at      INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at        INTEGER NOT NULL,
  UNIQUE (user_id, client_signal_id)
);
CREATE INDEX IF NOT EXISTS ix_signals_user_created ON signals(user_id, created_at);

-- One row per (signal, account): the delivery/execution state machine.
CREATE TABLE IF NOT EXISTS executions (
  id               TEXT    PRIMARY KEY,
  signal_id        TEXT    NOT NULL REFERENCES signals(id),
  account_id       TEXT    NOT NULL REFERENCES accounts(id),
  user_id          INTEGER NOT NULL REFERENCES users(id),
  action           TEXT    NOT NULL CHECK (action IN ('notify','execute')),
  state            TEXT    NOT NULL,
  reason           TEXT    NOT NULL DEFAULT '',
  delivery_count   INTEGER NOT NULL DEFAULT 0,
  broker_symbol    TEXT,
  requested_price  REAL,
  fill_price       REAL,
  volume           REAL,
  sl               REAL,
  tp               REAL,
  ticket           TEXT,
  retcode          INTEGER,
  last_report_id   TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  delivered_at     INTEGER,
  approved_at      INTEGER,
  sending_at       INTEGER,
  finished_at      INTEGER,
  UNIQUE (signal_id, account_id)
);
CREATE INDEX IF NOT EXISTS ix_exec_account_state ON executions(account_id, state);
CREATE INDEX IF NOT EXISTS ix_exec_user_created ON executions(user_id, created_at);

-- Audit trail. Never contains keys, passwords or raw auth headers.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  user_id     INTEGER,
  account_id  TEXT,
  actor       TEXT    NOT NULL,
  event       TEXT    NOT NULL,
  ref_id      TEXT,
  detail      TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_audit_user_ts ON audit_log(user_id, ts);
