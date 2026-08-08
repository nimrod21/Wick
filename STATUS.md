# Wick — Status

**Current phase:** 4 — Bots + trigger engine (done; 24h soak deferred)

## Phase checklist

- [x] Phase 0 — Reset & carve-out
- [x] Phase 1 — Market data & indicators (this wave; 12h soak + WS-drop heal not yet exercised)
- [x] Phase 2 — Paper trading engine
- [x] Phase 3 — LLM provider layer (keys not yet registered — router skips keyless providers; stub + Ollama are the offline paths)
- [x] Phase 4 — Bots + trigger engine (24h unattended soak deferred — needs provider keys)
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

## Phase 2 notes / decisions

- New `apps/server/src/paper/` (engine, protector, risk-guards); old `execution/` deleted
  (it targeted legacy tables — kv/orders/candles_1m — only the weighted-avg-entry pattern
  survived, rewritten bot-scoped).
- Buy accounting: qty = notional/mid, fill price = mid×(1+slip); cash −= notional + slip + fee
  (fee 0.1% and slip 0.05% both on pre-slip notional; slip ×2 inside a volatility window —
  `setVolatilityWindow(symbol, untilTs)` is the Phase 4 hook, default off). Sell mirrors.
  Dust: a partial sell leaving < $0.50 closes the position fully.
- `fill` event kind added to `@wick/shared` events (carries reason 'trade'|'sl'|'tp').
  Fills table has no reason column (schema per PLAN §6) — reason lives on the event and in
  the protector's synthetic decision `trigger_detail` (`sl:SYMBOL@tick level=stop`).
- Guards: pure `checkAndClamp(bot, decision, state)`; state assembled by
  `engine.buildGuardState(botId, symbol)`. "One position per symbol" is enforced as
  buy-while-holding → veto (no LLM adds); `tradesToday` counts all fills since UTC midnight
  (protector exits included — conservative). Cash clamp keeps 1.002 headroom so a passed
  buy can never hit the engine's insufficient_cash rejection.
- Guards tests: plain tsx + node:assert (`scripts/test-guards.ts`, 27 asserts) — vitest is
  not in the workspace and wasn't trivially addable, per IMPL-2 acceptance note.
- Dev CLI (`pnpm paper buy|sell|status|snapshot`): talks to the live server DB directly
  (WAL, second process) and primes the engine price chain with a Binance REST price
  (`primeMid`, 30s TTL) since the CLI process has no WS. Engine mid chain:
  WS last trade → primed REST → newest 1m candle close. CLI bypasses guards by design
  (harness must set e.g. 0.1% SLs that the clamp forbids).
- Protector: tick-driven same-tick exits; index rebuilt from `positions` on boot, armed only
  after marketWarm; plus a 5s index reconcile from DB so positions written by another
  process (the CLI) get armed — breach detection itself is never polled.
- Known issue (pre-existing, not Phase 2): the dev logger's pino-pretty worker-thread
  transport can crash the process when stdout is redirected to a file
  ("Emitted 'error' event on ThreadStream"). `NODE_ENV=production` (plain pino) is immune;
  pm2/Phase 7 runs production anyway.

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

## Phase 4 notes / decisions (bots + trigger engine)

- **No new dependencies.** New modules: `bots/{bot-store,bot-runner,snapshot,
  scheduler,boot}.ts`, `market/trigger-engine.ts`, `api/bots.ts`; three bus
  event kinds added to `@wick/shared` (`decision`, `trigger`, `bot_status`).
- Boot order: … marketWarm → indicator pass → `resumeBots()` (log line per
  running bot, busted re-check, cadence scheduler + trigger engine + hourly
  busted cron). `seedDefaultBots()` runs before the WS connect, idempotent by
  name — **Patience** and **Contrarian**, $1000 each, seeded `running`, with
  provider_order rotated by one so model-vs-model has data from day one.
- Wake queue: per-bot pending depth 1, absorption keeps the FRESHEST reason;
  `pump()` is deferred to a microtask so several triggers fired in the same
  tick coalesce into ONE decision (3 wakes → queued 1 / absorbed 2 / 1 row).
  Global cap 3 LLM calls in flight.
- Gates run before any snapshot work: status running → per-bot floor (10 min,
  from `triggers.thresholds.per_bot_wake_floor_min`, protector rows excluded)
  → trades-left-today → `poolRemaining() > 0`. **Deviation:** the trades-left
  gate only applies when the bot is FLAT; holding a position it still wakes to
  reassess and the guards veto the trade with `max_trades_day` (that is what
  the IMPL-3 acceptance check observes).
- Decision rows keep the LLM's intended `action` when guards veto (status
  `vetoed` + `veto_reason`), rather than rewriting it to `wait` — PLAN §11
  says vetoed scores as wait but must stay distinguishable, and the status
  column carries that. Engine rejections land as `vetoed` /
  `engine_<reason>`. `llm_failed` → action `wait`, no trade, no retry.
- `snapshot_json` = the full prompt Snapshot plus a `meta` block
  `{run, botId, triggerType, triggerDetail, priority, cadenceTf}` — the run
  counter lives there (Phase 5 filters by it).
- Scheduled wakes: one per (bot, tf, candle ts) — the 7 symbols all emit a
  close for the same candle — staggered 0–30 s by FNV-1a hash of the bot id
  (no `Math.random`). They route through `fireTrigger` as P3 `scheduled` so
  they get the same trigger_log/budget treatment, but skip the per
  (type × symbol) cooldown (the cadence is the discipline).
- Trigger engine sources: `tick` (price_velocity P1, position_event P1),
  `indicator` 1h (rsi_cross, macd_cross, bb_breakout P2), `candle` 1h close
  (volume_spike P2, computed straight from the last 20 candle volumes),
  `funding` (funding_flip P2), `fill` (position index refresh). rsi/atr/bb
  state is primed from `indicator_values` at start, so a cross is detectable
  on the first live candle after a restart. price_velocity also opens the
  15-min ×2-slippage window via `setVolatilityWindow`.
- `position_event` arms only after price moves 0.5% from entry (avoids the
  open-a-position-instantly-satisfies-P&L-crossing loop) and wakes only the
  owning bot. Drawdown-warning wakes are not wired as a separate source —
  the busted check covers the kill line; revisit in Phase 6 if the UI wants it.
- Budget gate (`budgetGate`, pure + unit-tested): P1 needs pool > 0 (it may
  draw on the reserve); P2/P3 need pool > 30% reserve, and P2 additionally
  needs pool > 50% of the day's total OR an open position in that symbol.
- `trigger_log` gets one row per (evaluation × candidate bot) with fired 0/1
  and the gate reason appended to `detail` in `[...]`; a matching trigger with
  no eligible bot logs a single `bot_id NULL` row. Every row is mirrored on
  the bus as a `trigger` event (gated ones included, for the dimmed UI).
- `reset` liquidates at mid with **no fees and no fill rows** (bookkeeping,
  not a trade), restores cash = bankroll_start, bumps `config.run`, and
  DELETES that bot's `equity_snapshots` — the drawdown high-water mark is
  derived from them, so an old run's peak would otherwise bust the new run
  instantly. Decisions/fills keep their rows. Busted uses the same
  liquidation path.
- Tests: `pnpm tsx scripts/test-bots.ts` — 7 checks (e2e fill, max_trades_day
  veto, rsi_cross fire + cooldown block, budget P1-vs-P3, absorption 3→1,
  deterministic stagger, boot resume). It stops non-test bots, restores every
  setting it lowers and purges its own rows; the stub provider is injected as
  a temporary `providers.registry` row (`stub-e2e`).
- Stale `apps/web/.next` (gitignored build output from the cockpit era) was
  deleted — it made `pnpm -r typecheck` fail on pages removed in Phase 0.
- **Deferred:** the 24h unattended two-bot soak. It needs at least one
  provider key; with none registered every wake records `llm_failed` (free,
  harmless, but proves nothing). Run it once keys are in the vault.
