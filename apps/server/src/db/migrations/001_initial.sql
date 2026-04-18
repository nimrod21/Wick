PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ─── assets & watchlists ────────────────────────────────────────────
CREATE TABLE assets (
  id           INTEGER PRIMARY KEY,
  symbol       TEXT NOT NULL,
  display_name TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN (
                 'crypto','stock','etf','forex','commodity','index'
               )),
  exchange     TEXT,
  tradeable_via TEXT,                  -- 'ccxt'|'alpaca'|null
  tradeable_symbol TEXT,               -- e.g. GLD for XAU/USD display
  metadata_json TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  UNIQUE(symbol, exchange)
);
CREATE INDEX idx_assets_type ON assets(type);
CREATE INDEX idx_assets_enabled ON assets(enabled);

-- ─── candles (one table per timeframe) ──────────────────────────────
CREATE TABLE candles_1m (
  asset_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  o REAL, h REAL, l REAL, c REAL, v REAL,
  PRIMARY KEY (asset_id, ts)
) WITHOUT ROWID;
CREATE TABLE candles_3m  (asset_id INTEGER, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
                          PRIMARY KEY(asset_id, ts)) WITHOUT ROWID;
CREATE TABLE candles_15m (asset_id INTEGER, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
                          PRIMARY KEY(asset_id, ts)) WITHOUT ROWID;
CREATE TABLE candles_1h  (asset_id INTEGER, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
                          PRIMARY KEY(asset_id, ts)) WITHOUT ROWID;
CREATE TABLE candles_4h  (asset_id INTEGER, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
                          PRIMARY KEY(asset_id, ts)) WITHOUT ROWID;
CREATE TABLE candles_1d  (asset_id INTEGER, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
                          PRIMARY KEY(asset_id, ts)) WITHOUT ROWID;
CREATE TABLE candles_1w  (asset_id INTEGER, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
                          PRIMARY KEY(asset_id, ts)) WITHOUT ROWID;

-- ─── events (unified firehose) ──────────────────────────────────────
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                -- 'whale_tx'|'news'|'indicator'|'alert'|'macro_snapshot'
  source TEXT NOT NULL,
  ts INTEGER NOT NULL,
  asset_id INTEGER,
  severity INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  dedup_key TEXT UNIQUE,
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);
CREATE INDEX idx_events_ts ON events(ts DESC);
CREATE INDEX idx_events_kind_ts ON events(kind, ts DESC);
CREATE INDEX idx_events_asset_ts ON events(asset_id, ts DESC);

-- ─── brain: per-event forward-price snapshots ───────────────────────
CREATE TABLE events_price_snapshots (
  event_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  horizon TEXT NOT NULL CHECK (horizon IN ('5m','30m','1h','4h','1d','3d','1w','3w')),
  captured_ts INTEGER,
  price REAL,
  pct_change REAL,
  PRIMARY KEY (event_id, asset_id, horizon),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id)
) WITHOUT ROWID;
CREATE INDEX idx_snapshots_pending ON events_price_snapshots(captured_ts)
  WHERE captured_ts IS NULL;

-- ─── whales ────────────────────────────────────────────────────────
CREATE TABLE whale_addresses (
  id INTEGER PRIMARY KEY,
  chain TEXT NOT NULL CHECK (chain IN ('eth','sol','btc')),
  address TEXT NOT NULL,
  label TEXT,
  tags_json TEXT,
  added_at INTEGER NOT NULL,
  last_checked_block INTEGER,
  last_checked_ts INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(chain, address)
);
CREATE INDEX idx_whales_chain_enabled ON whale_addresses(chain, enabled);

CREATE TABLE ignore_addresses (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  label TEXT,
  PRIMARY KEY (chain, address)
) WITHOUT ROWID;

-- ─── indicator readings (time series) ───────────────────────────────
CREATE TABLE indicator_readings (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  ts INTEGER NOT NULL,
  value REAL NOT NULL,
  meta_json TEXT,
  UNIQUE(name, ts)
);
CREATE INDEX idx_indicator_name_ts ON indicator_readings(name, ts DESC);

-- ─── probability engine ────────────────────────────────────────────
CREATE TABLE signal_readings (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  asset_id INTEGER,
  signal TEXT NOT NULL,
  value_normalized REAL NOT NULL,
  weight REAL NOT NULL,
  raw_value_json TEXT
);
CREATE INDEX idx_signals_asset_ts ON signal_readings(asset_id, ts DESC);

CREATE TABLE probability_history (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  horizon TEXT NOT NULL CHECK (horizon IN ('1h','4h','24h')),
  bullish_prob REAL NOT NULL,
  confidence REAL NOT NULL,
  contributing_json TEXT NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);
CREATE INDEX idx_prob_asset_ts ON probability_history(asset_id, horizon, ts DESC);

-- ─── alerts ────────────────────────────────────────────────────────
CREATE TABLE alert_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  condition_json TEXT NOT NULL,
  channels_json TEXT NOT NULL,
  cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  last_fired_ts INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_alerts_enabled ON alert_rules(enabled);

CREATE TABLE alert_firings (
  id INTEGER PRIMARY KEY,
  rule_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  delivered_json TEXT,
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
);
CREATE INDEX idx_firings_ts ON alert_firings(ts DESC);

-- ─── execution: orders & positions ─────────────────────────────────
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  client_order_id TEXT NOT NULL UNIQUE,
  broker TEXT NOT NULL CHECK (broker IN ('paper','ccxt','alpaca')),
  asset_id INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  type TEXT NOT NULL CHECK (type IN ('market','limit','stop')),
  qty REAL NOT NULL,
  limit_price REAL,
  stop_price REAL,
  status TEXT NOT NULL CHECK (status IN (
    'pending','submitted','partial','filled','cancelled','rejected','expired'
  )),
  avg_fill_price REAL,
  filled_qty REAL NOT NULL DEFAULT 0,
  submitted_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  broker_order_id TEXT,
  raw_response_json TEXT,
  error TEXT,
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);
CREATE INDEX idx_orders_status_ts ON orders(status, created_at DESC);
CREATE INDEX idx_orders_asset ON orders(asset_id, created_at DESC);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY,
  broker TEXT NOT NULL,
  asset_id INTEGER NOT NULL,
  qty REAL NOT NULL,
  avg_entry_price REAL NOT NULL,
  realized_pnl REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES assets(id),
  UNIQUE(broker, asset_id)
);

-- ─── api keys (encrypted) ───────────────────────────────────────────
CREATE TABLE api_keys (
  service TEXT PRIMARY KEY,
  key_ciphertext BLOB NOT NULL,
  secret_ciphertext BLOB,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  permissions_json TEXT,
  added_at INTEGER NOT NULL,
  last_verified_ts INTEGER,
  last_verified_ok INTEGER
);

-- ─── system / kv ────────────────────────────────────────────────────
CREATE TABLE kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Used for: kill_switch, trading_mode, last_startup, backfill_status, etc.
