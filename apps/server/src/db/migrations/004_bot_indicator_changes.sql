-- IMPL-7: bot indicator agency — the log of who switched what, when, and why.
--
-- Ownership of an indicator's on/off moved from the system (the old
-- mechanical auto-disable) to the bot itself: a weekly portfolio review asks
-- him which indicators to enable/disable, code guards protect the frame, and
-- EVERY outcome lands here — applied changes AND the wishes a guard vetoed.
--
--   action  'on' | 'off'                    — the state that was asked for
--   source  'bot' | 'user' | 'guard_veto'   — who asked / why it did not happen
--
-- `indicator` is a free TEXT name joining 1:1 on INDICATOR_DEFS keys. Nothing
-- here assumes how many indicators are registered — the table grows with the
-- registry (IMPL-7 "LEAVE IT OPEN").
--
-- Additive + idempotent: this migration never touches an existing table.
CREATE TABLE IF NOT EXISTS bot_indicator_changes (
  id        INTEGER PRIMARY KEY,
  bot_id    INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  indicator TEXT    NOT NULL,
  action    TEXT    NOT NULL,
  reasoning TEXT,
  source    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bic_bot_ts ON bot_indicator_changes(bot_id, ts);
CREATE INDEX IF NOT EXISTS idx_bic_indicator ON bot_indicator_changes(indicator, ts);
