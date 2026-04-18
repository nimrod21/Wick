-- Phase 4 — whale tracker + snapshot-job additions.
--
-- 1. whale_addresses.last_checked_cursor — for SOL's signature cursor
--    (Helius enhanced-tx API pages via `before=<signature>`). The
--    existing `last_checked_block INTEGER` column is kept for ETH's
--    block number and BTC's last-seen block height.
-- 2. events_price_snapshots.event_price — captured eagerly when a
--    snapshot is scheduled, so the subsequent pct_change computation is
--    independent of how long ago the event happened.
ALTER TABLE whale_addresses ADD COLUMN last_checked_cursor TEXT;
ALTER TABLE events_price_snapshots ADD COLUMN event_price REAL;
