-- 001_wick.sql — fresh Wick schema (PLAN §6).
-- All ts columns are UTC unix milliseconds. All money is USD floats (paper).

-- ── market data ─────────────────────────────────────────────────────────

-- watchlist, UI-editable
CREATE TABLE assets (
  symbol       TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  added_ts     INTEGER NOT NULL
);

-- 1m,15m,1h,4h,1d cache
CREATE TABLE candles (
  symbol TEXT NOT NULL,
  tf     TEXT NOT NULL,
  ts     INTEGER NOT NULL,
  o      REAL NOT NULL,
  h      REAL NOT NULL,
  l      REAL NOT NULL,
  c      REAL NOT NULL,
  v      REAL NOT NULL,
  PRIMARY KEY (symbol, tf, ts)
);

-- vote: 'bull'|'bear'|'neutral' — the directional read used for learning
CREATE TABLE indicator_values (
  symbol TEXT NOT NULL,
  tf     TEXT NOT NULL,
  ts     INTEGER NOT NULL,
  name   TEXT NOT NULL,
  value  REAL,
  vote   TEXT,
  PRIMARY KEY (symbol, tf, ts, name)
);

-- includes encrypted keys (existing vault format, under 'apikey.*' keys)
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── bots & paper trading ────────────────────────────────────────────────

-- status: 'running'|'stopped'|'busted'
CREATE TABLE bots (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'stopped',
  bankroll_start REAL NOT NULL,
  cash           REAL NOT NULL,
  config_json    TEXT NOT NULL,
  created_ts     INTEGER NOT NULL,
  stopped_ts     INTEGER
);

CREATE TABLE positions (
  bot_id     INTEGER NOT NULL,
  symbol     TEXT NOT NULL,
  qty        REAL NOT NULL,
  avg_entry  REAL NOT NULL,
  stop_price REAL,
  tp_price   REAL,
  opened_ts  INTEGER NOT NULL,
  PRIMARY KEY (bot_id, symbol)
);

CREATE TABLE fills (
  id          INTEGER PRIMARY KEY,
  bot_id      INTEGER NOT NULL,
  decision_id INTEGER,
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL,
  qty         REAL NOT NULL,
  price       REAL NOT NULL,
  fee         REAL NOT NULL,
  slip        REAL NOT NULL,
  ts          INTEGER NOT NULL
);

-- hourly, for sparklines/drawdown
CREATE TABLE equity_snapshots (
  bot_id INTEGER NOT NULL,
  ts     INTEGER NOT NULL,
  equity REAL NOT NULL,
  PRIMARY KEY (bot_id, ts)
);

-- ── decisions & learning ────────────────────────────────────────────────

CREATE TABLE decisions (
  id             INTEGER PRIMARY KEY,
  bot_id         INTEGER NOT NULL,
  ts             INTEGER NOT NULL,
  trigger_type   TEXT,
  trigger_detail TEXT,
  snapshot_json  TEXT,               -- full indicator values+votes+weights at decision time
  action         TEXT NOT NULL,      -- 'buy'|'sell'|'wait'
  symbol         TEXT,
  size_pct       REAL,
  confidence     REAL,
  reasoning      TEXT,
  sl_pct         REAL,
  tp_pct         REAL,
  provider       TEXT,
  model          TEXT,
  latency_ms     INTEGER,
  status         TEXT NOT NULL,      -- 'executed'|'vetoed'|'llm_failed'
  veto_reason    TEXT
);

CREATE TABLE outcomes (
  decision_id  INTEGER NOT NULL,
  horizon      TEXT NOT NULL,        -- '1h'|'4h'|'24h'
  fwd_ret_pct  REAL,
  score        REAL,                 -- score in [-1,1], see PLAN §11
  evaluated_ts INTEGER NOT NULL,
  PRIMARY KEY (decision_id, horizon)
);

CREATE TABLE indicator_stats (
  bot_id     INTEGER NOT NULL,
  indicator  TEXT NOT NULL,
  samples    INTEGER NOT NULL DEFAULT 0,
  hits       INTEGER NOT NULL DEFAULT 0,
  weight     REAL NOT NULL DEFAULT 1.0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (bot_id, indicator)
);

-- kind: 'reflection'|'lesson'
CREATE TABLE journal (
  id     INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL,
  ts     INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  text   TEXT NOT NULL
);

-- <=10 bullet lessons, prompt-injected
CREATE TABLE lessons_current (
  bot_id     INTEGER PRIMARY KEY,
  text       TEXT NOT NULL,
  updated_ts INTEGER NOT NULL
);

-- ── llm & triggers ──────────────────────────────────────────────────────

-- daily quota ledger, survives restart
CREATE TABLE llm_usage (
  provider TEXT NOT NULL,
  date     TEXT NOT NULL,
  calls    INTEGER NOT NULL DEFAULT 0,
  errors   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, date)
);

-- fired=0 when gated by cooldown/budget
CREATE TABLE trigger_log (
  id     INTEGER PRIMARY KEY,
  ts     INTEGER NOT NULL,
  bot_id INTEGER,
  type   TEXT NOT NULL,
  detail TEXT,
  fired  INTEGER NOT NULL DEFAULT 0
);

-- ── indexes ─────────────────────────────────────────────────────────────

CREATE INDEX idx_decisions_bot_ts   ON decisions(bot_id, ts);
CREATE INDEX idx_outcomes_decision  ON outcomes(decision_id);
CREATE INDEX idx_fills_bot_ts       ON fills(bot_id, ts);
CREATE INDEX idx_candles_symbol_tf_ts ON candles(symbol, tf, ts);
CREATE INDEX idx_trigger_log_ts     ON trigger_log(ts);
CREATE INDEX idx_journal_bot_ts     ON journal(bot_id, ts);
