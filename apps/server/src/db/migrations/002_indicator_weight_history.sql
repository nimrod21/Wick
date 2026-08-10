-- IMPL-2: weight evolution over time.
--
-- `indicator_stats` only ever holds the CURRENT weight, so the Track-record
-- page had nothing to draw a trend from. The daily recompute appends one row
-- per (bot, indicator) here, timestamped at the UTC day boundary — so a day
-- that recomputes twice replaces its own row instead of doubling up.
--
-- Additive + idempotent: this migration never touches existing tables.
CREATE TABLE IF NOT EXISTS indicator_weight_history (
  bot_id    INTEGER NOT NULL,
  indicator TEXT    NOT NULL,
  ts        INTEGER NOT NULL,
  weight    REAL    NOT NULL,
  PRIMARY KEY (bot_id, indicator, ts)
);

CREATE INDEX IF NOT EXISTS idx_iwh_indicator_ts
  ON indicator_weight_history(indicator, ts);
