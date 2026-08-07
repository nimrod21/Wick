# Wick — Status

**Current phase:** 1 — Market data & indicators (done; 12h soak pending)

## Phase checklist

- [x] Phase 0 — Reset & carve-out
- [x] Phase 1 — Market data & indicators (this wave; 12h soak + WS-drop heal not yet exercised)
- [ ] Phase 2 — Paper trading engine
- [x] Phase 3 — LLM provider layer (keys not yet registered — router skips keyless providers; stub + Ollama are the offline paths)
- [ ] Phase 4 — Bots + trigger engine
- [ ] Phase 5 — Learning & memory
- [ ] Phase 6 — UI
- [ ] Phase 7 — Hardening & service

## Environment notes

- Node 22 LTS required (better-sqlite3 breaks on Node 24). Portable install:
  `D:/Claude/Tools/node-v22` — `export PATH="/d/Claude/Tools/node-v22:$PATH"`.
- Server binds `127.0.0.1:3001`; web dev on `127.0.0.1:3000`.
- DB: `apps/server/data/wick.db` (WAL). Fresh schema `001_wick.sql`; migrate seeds
  the 7-symbol watchlist + default settings (guards, trigger thresholds, provider registry).
- Master key env var: `WICK_MASTER_KEY` (auto-generated into `.env` on first boot).

## Phase 0 notes / decisions

- Collectors (Binance WS/REST, fear-greed, funding-oi, scheduler, indicator cron) are
  kept but NOT started from `index.ts` — Phase 1 re-enables them against the new schema.
- `paper-mode.ts` / `order-manager.ts` / `risk-guards.ts` kept as adaptation bases;
  they still reference legacy tables (kv, orders, candles_1m, positions-by-asset_id)
  and are not exercised at runtime — Phase 2 rewires them.
- Vault keys now live in the `settings` table (`apikey.<provider>` rows, same AES-GCM
  format); the old `api_keys` table is gone.
- Web app gutted to a shell: `/` WICK placeholder, `/settings` placeholder, palette
  tokens in `globals.css`. Phase 6 rebuilds all pages.

## Phase 1 notes / decisions

- **15m/4h/1d update strategy: periodic REST refresh** (not aggregation). A 5-min cron
  re-fetches the last 2 klines per (symbol × 15m/4h/1d) and upserts the closed ones —
  exact Binance values, no aggregation drift, ~21 requests/5 min. WS streams cover 1m/1h.
- Only CLOSED klines are ever persisted to `candles`; forming candles reach the UI as
  `candle` events with `closed:false`.
- Boot sequence: scheduler (funding+F&G polls kick immediately) → WS connect (closed
  klines buffered) → REST backfill 500/(symbol×tf) (~15 s for 35 requests) → buffer
  flush → `marketWarm` flag+event → indicator engine subscribe + one full compute pass.
  The boot pass is standard behaviour, so indicators are queryable right after any boot.
- Indicator names (Phase 5 joins on these 1:1): `rsi14, ema_trend, macd, bollinger,
  atr14, volume_ratio, funding, fear_greed` — vote rules live in `INDICATOR_DEFS`
  (apps/server/src/market/indicator-engine.ts), computed on 1h close only.
- API: `/api/market/candles`, `/api/market/indicators`, `/api/market/summary`;
  SSE moved to `/api/sse` (ticks throttled ≤2/s per symbol per connection).
- Funding polled 15-min for all 7 symbols (fapi premiumIndex); F&G daily; both cached
  in memory only (latest value queryable, staleness tolerated silently). OI polling
  from the old collector was dropped — nothing in the plan consumes it.
- Hourly self-heal at :07 counts missing recent buckets per (symbol × tf) and
  REST-backfills the window when any are missing.

## Blockers

- None.

## Phase 3 notes / decisions (LLM provider layer)

- **No new dependencies.** `zod` was added to `packages/shared/package.json`
  (required for the Decision contract living in shared per PLAN §7) — same
  version already in the workspace lockfile via the server, only a link, not
  a new install.
- Decision contract: `packages/shared/src/decision.ts` (`DecisionSchema`,
  `Decision`, `parseDecision`). Coerces "82%"→82, "BUY"→"buy", string
  numbers, missing optionals→null; buy/sell require symbol+size_pct.
- Router: `llm/router.ts` `decide(botCtx, snapshot, opts?)` → `{decision,
  provider, model, latencyMs} | {failed, reason}`; never throws. Providers
  with no vault key are SKIPPED silently (no error rows) until Luka
  registers keys — Ollama (authStyle 'none') and the stub need none.
  Malformed-after-repair marks an `llm_usage` error (PLAN §7 rule 2).
- Gemini adapter always folds system into the first user turn (some free
  models reject system role — deterministic beats conditional).
- Quota: `llm/quota.ts` — llm_usage-backed UTC daily counters + in-memory
  rpm token bucket; `poolRemaining()` ready for the Phase-4 budget gate.
- Snapshot builder `llm/snapshot.ts`: `buildSnapshot(symbol, botState?)`;
  bot-less callers get placeholder account/lessons, weights 1.0 / hit-rate
  n/a until Phase 5.
- CLI: `pnpm ask --symbol BTCUSDT [--provider groq|stub] [--dry]`,
  `pnpm keys set llm.<provider>.key <value>` / `pnpm keys list` (writes the
  same `apikey.<provider>` vault rows `config.getApiKey()` reads).
- Tests: `pnpm tsx scripts/test-llm.ts` — 20 asserts (rotation, quota
  rollover, parse/repair/fail-over, coercion, golden prompt). Golden file:
  `apps/server/src/llm/golden/prompt.golden.txt` (regen `UPDATE_GOLDEN=1`).
- Provider signup/setup doc: `apps/server/src/llm/README-setup.md`.
- Ollama was NOT running during this phase's verification — end-to-end ran
  via the stub adapter; `ask` probes :11434 each run and auto-enables it.
