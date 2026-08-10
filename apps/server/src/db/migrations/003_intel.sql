-- IMPL-3a: intel sources — news, whale moves, macro quotes.
--
-- Three append-only source tables feeding the new indicators
-- (news_sentiment, news_burst, whale_flow, gold/oil/dxy/vix). Nothing here
-- touches an existing table: additive + idempotent, safe on a live DB.

-- ── news ────────────────────────────────────────────────────────────────
-- One row per de-duplicated headline. `url` is the CANONICAL url (tracking
-- params stripped) and carries the UNIQUE constraint, so re-polling a feed
-- or two outlets syndicating the same story insert once.
-- `assets_json` is a JSON array of base tickers ("BTC","ETH") from the
-- ticker tagger; `sentiment` is -1..+1 from the lexicon, NULL when the
-- headline contains no lexicon word at all (an honest "no read").
CREATE TABLE IF NOT EXISTS news_items (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  url         TEXT    NOT NULL UNIQUE,
  assets_json TEXT    NOT NULL DEFAULT '[]',
  sentiment   REAL
);

CREATE INDEX IF NOT EXISTS idx_news_items_ts ON news_items(ts);

-- ── whales ──────────────────────────────────────────────────────────────
-- One row per (chain, tx, watched address) above the BTC threshold.
-- direction: 'inflow' (coins INTO an exchange wallet — bearish),
--            'outflow' (coins OUT of one — bullish),
--            'internal' (exchange↔exchange shuffle, or a non-exchange
--                        whale wallet: logged, but casts no flow vote).
-- `tx` + `address_tag` are UNIQUE together so a re-scan of the same
-- address history is a no-op (the collector re-reads the last 50 txs
-- every cycle and relies on this).
CREATE TABLE IF NOT EXISTS whale_moves (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  chain       TEXT    NOT NULL,
  amount      REAL    NOT NULL,
  usd         REAL,
  direction   TEXT    NOT NULL,
  tx          TEXT    NOT NULL,
  address_tag TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whale_moves_tx
  ON whale_moves(chain, tx, address_tag);
CREATE INDEX IF NOT EXISTS idx_whale_moves_ts ON whale_moves(ts);

-- ── macro ───────────────────────────────────────────────────────────────
-- Yahoo chart quotes (GC=F, CL=F, SI=F, DX-Y.NYB, ^VIX). Kept in its own
-- small table rather than `candles` with tf='macro': these are point
-- quotes, not OHLCV, and must never be mistaken for tradable candles.
CREATE TABLE IF NOT EXISTS macro_quotes (
  symbol TEXT    NOT NULL,
  ts     INTEGER NOT NULL,
  price  REAL    NOT NULL,
  PRIMARY KEY (symbol, ts)
);

CREATE INDEX IF NOT EXISTS idx_macro_quotes_ts ON macro_quotes(ts);
