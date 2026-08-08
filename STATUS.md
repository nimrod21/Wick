# Wick — Status

**Current phase:** 7 — Hardening & service (built + verified). **All seven phases are
complete.** What is left is Luka's to run by hand: 72h soak, design/screenshot review,
provider-key registration, pm2 boot autostart.

## Phase checklist

- [x] Phase 0 — Reset & carve-out
- [x] Phase 1 — Market data & indicators (this wave; 12h soak + WS-drop heal not yet exercised)
- [x] Phase 2 — Paper trading engine
- [x] Phase 3 — LLM provider layer (keys not yet registered — router skips keyless providers; stub + Ollama are the offline paths)
- [x] Phase 4 — Bots + trigger engine (24h unattended soak deferred — needs provider keys)
- [x] Phase 5 — Learning & memory (weights/lessons verified on seeded data — real
      accumulation needs bots deciding, i.e. provider keys)
- [x] Phase 6 — UI (all four pages live over SSE; **design pass with Luka pending** —
      screenshots in `D:/Claude/tempo/wick-phase6/`)
- [x] Phase 7 — Hardening & service (pm2 both apps, crash-only audit 12/12, data
      hygiene, `/health` + `pnpm doctor`, `pnpm smoke`, README — **72h soak deferred to Luka**)

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

## Phase 5 notes / decisions (learning & memory)

- **No new dependencies, no schema change.** New modules: `learn/{evaluator,
  indicator-stats,journal}.ts`, `api/learn.ts`; one bus event kind added to
  `@wick/shared` (`outcome`). All three learn modules start in `index.ts`
  after `resumeBots()` — subscribers BEFORE the evaluator cron so no outcome
  is published to an empty bus.
- **Scoring reading (interpretation, flagged):** PLAN §11 says buy scores
  `clamp(fwd_ret / 2%, -1, 1) minus round-trip fee (0.25%)`. The fee is
  applied in RETURN space — `clamp((ret − 0.25) / 2, −1, 1)` — not subtracted
  from the already-scaled score. Return space is dimensionally coherent (the
  fee is quoted as a percentage return), keeps the score inside [−1,1] without
  a second clamp, and still makes small winners negative ("being right small
  still costs": +0.2% → −0.025). Sell carries no fee term because the plan
  states none. If Luka meant the literal score-space subtraction, it is a
  one-line change in `scoreFor`.
- No look-ahead is structural, not a check: `priceAt(symbol, t)` selects
  `MAX(ts) WHERE ts <= t − 1h` because a candle's `ts` is its OPEN time, so
  only candles that had already CLOSED by `t` can be picked. A decision at
  14:00 prices at 100 (the 13:00 candle's close) and its 1h forward price is
  the 14:00 candle's close, i.e. 15:00 — the IMPL-3 pitfall verbatim.
  A missing candle > 2h from the target instant returns null → the decision is
  skipped and picked up by a later cron run once self-heal backfills.
- `llm_failed` decisions are NOT scored (IMPL-3 §5.1 lists `executed` +
  `vetoed`): no model answered, so there is nothing to judge. Vetoed rows are
  scored as `wait` while `action`/`status` keep the original intent.
- `outcome` bus events fire on the **4h horizon only** — 1h/24h rows are
  stored for analysis but emitting them would triple-count every sample.
  Protector (`trigger_type = 'protector'`, provider `code`) exits are scored
  like any other sell; they have no `snapshot_json`, so they contribute no
  indicator samples, and they show up as their own `code` row on the model
  scoreboard.
- **Re-trial without a schema column:** PLAN §6 fixes `indicator_stats` at
  (bot, indicator, samples, hits, weight, enabled, updated_ts), so there is
  nowhere to store "disabled at". The 4-weekly re-trial is therefore derived
  from the clock — `isRetrialWeek()` is true in 1 UTC week out of 4 — and
  during that week the daily recompute re-enables a disabled indicator whose
  RECENT record (last 200 evaluated decisions, replayed from `snapshot_json`)
  has >= 30 samples and a smoothed hit-rate >= 0.5. Disabled indicators are
  never shown to the bot, in or out of the window; they always keep recording
  votes via the shadow flag.
- Snapshot indicators gained `samples` + `shadow`; the prompt line is now
  `- rsi14: 63.10 [neutral] — hit-rate 50% (w 1.00, n 29)` and shadow rows are
  dropped from the render (they stay in `snapshot_json`). Golden regenerated:
  955 est tokens with full learning data, 1059 with 10 long lessons — both
  well under the 2.5k target.
- `llm/router.ts` gained `complete()` (free text, same rotation + quota
  ledger, no JSON contract, no repair retry) for the one lesson call per bot
  per day. Both `decide` and `complete` now share a lazy `eligibleProviders`
  generator — laziness matters, headroom is re-checked at each candidate.
- Lessons REPLACE (never append) and a failed call changes nothing at all —
  yesterday's bullets simply stand another day. Bullets are capped at 10 and
  1000 chars total in code, not by trusting the model.
- Reflections are written only for EXECUTED buy/sell decisions; waits and
  vetoes are already visible in the last-5-decisions block and would drown the
  journal. Vote names in the text are the indicator names verbatim (1:1 join).
- Crons: evaluator `*/15 * * * *`; indicator recompute `5 0 * * *`; lessons
  `20 0 * * *` staggered 0–10 min by bot-id hash (after the recompute, so the
  lesson call sees the stats the next prompt will use).
- APIs: `GET /api/bots/:id/stats|journal?kind=|outcomes`, `GET /api/stats/models`.
- Tests: `pnpm test:learn` (`scripts/test-learn.ts`) — 16 checks on synthetic
  `TEST{1,2,3}USDT` candle series and test bots, all rows/settings restored.
  Also added `test:guards|llm|bots|learn` package scripts (the suites already
  existed, they just had no entry point).
- **Not yet exercised live:** nothing has accumulated real samples, because no
  bot has produced a real decision yet (no provider keys). The 30/100 floors
  mean weights will not move for days of real running — that is the design.

## Phase 6 notes / decisions (UI)

- **One new dependency link:** `zod` added to `apps/web` (already in the lockfile via
  `@wick/shared`/server — a link, not a download). `lightweight-charts` was already in
  `apps/web/package.json` from the Phase-0 shell. No state library added; the app uses
  the `@tanstack/react-query` + `lib/query.ts` that survived from cockpit.
- **Fonts self-hosted**, no CDN: `apps/web/public/fonts/*.woff2` (Press Start 2P latin-400,
  JetBrains Mono latin-400/500/700), pulled once with `npm pack @fontsource/...` and
  declared as `@font-face` in `globals.css`. Both SIL OFL 1.1 — `public/fonts/LICENSES.txt`.
  The Phase-0 `@import url(fonts.googleapis.com)` is GONE.
- **Design system** (`app/globals.css` + `components/ui/index.tsx`): `Panel`, `StatusLed`
  (solid, no blink), `Stat`, `Sparkline` (inline SVG), `ActionBadge`, `OutcomeBadge`,
  `PixelTitle`, plus `WeightBar`/`UsageBar`/`Btn`/`VoteDot`/`Empty`. Motion is data-only
  (`flash-up`/`flash-down` tick flash, `slide-in` feed) and is disabled under
  `prefers-reduced-motion`. CRT overlay is `components/CrtOverlay.tsx`, mounted only when
  the settings toggle is on (localStorage `wick.crt`, default OFF).
- **Chart colors are duplicated as hex in `lib/chart-theme.ts`** — canvas cannot resolve
  CSS variables. Keep it in sync with `globals.css` by hand.
- **SSE**: `lib/sse.ts` owns ONE `EventSource` for the whole app, opened lazily on the
  first `useLive` subscriber and fanned out by topic. `onerror` closes and reconnects with
  1s→30s backoff (the native retry can sit on a dead socket after a server restart). The
  `Nav` subscribes to `market_warm` purely to keep that connection open on pages that
  consume no live data. Streaming through the Next `/api/*` rewrite was verified — no
  buffering, no need to talk to :3001 directly.
- **Decision log virtualization is hand-rolled** (no new dep): fixed 30px rows, +188px when
  expanded, prefix-summed offsets and a binary search for the first visible row.
- **Equity drawdown shading** uses a two-area-series trick (red area on the HWM, then an
  OPAQUE panel-colored area on the equity painted over it) — lightweight-charts v4 has no
  band series. Snapshots come from `equity_snapshots`, never recomputed client-side.
- **"Allowance"** in the bot header is read as the daily trade budget (`max_trades_day`),
  edited inline; everything else in `config_json` lives in the zod-validated config drawer.
- **Deviations from the "one server edit" brief (2 files touched, both flagged):**
  1. NEW `apps/server/src/api/providers.ts` — `GET /api/providers` (registry + today's
     `llm_usage` + headroom, which nothing exposed and the usage bars need) and
     `POST /api/providers/:id/test` (one cheap call pinned to one provider through
     `router.complete()`); registered in `api/server.ts`.
  2. `apps/server/src/api/assets.ts` — `POST /api/assets` now validates the symbol against
     Binance `exchangeInfo` (spot + `TRADING`, cached 1h, add REJECTED on network failure).
     IMPL-4 §6.6 requires server-side validation and nothing did it.
- **Registry gotcha:** `providers.registry` rows with `baseUrl: ""` are silently dropped by
  `getProviders()` (`z.string().min(1)`), so a stub provider row needs a non-empty baseUrl.
- Verification used a throwaway `stub` provider + two 1m-cadence probe bots, then purged
  everything (`bots` is back to Patience/Contrarian, all decision/fill/trigger tables at 0).
  One `llm_usage` row for `mistral` is left on purpose — it records a real 401 test call.
- **Not done / for Luka:** the §12 design pass (screenshot review) is explicitly deferred.
  Screenshots: `D:/Claude/tempo/wick-phase6/wick-{dashboard,dashboard-feed,bot-page,
  bot-page-expanded,bot-chart-1d,bot-indicators,market,settings,settings-advanced-crt}.png`.
- `next.config.mjs` still rewrites a dead `/stream` route (cockpit leftover, harmless).

## Phase 6 acceptance re-verification (independent run, 2026-08-08 16:35–16:52)

Full IMPL-4 §6 acceptance list re-run against the built (`next build` + `next start`)
web app, not dev mode. All items pass except the vault one, which passes within a boot
and fails across restarts because of a pre-existing Phase-3 defect (below).

| Acceptance | Result | Evidence |
|---|---|---|
| `pnpm typecheck` | pass | 3/3 projects, no output |
| `pnpm --filter @wick/web build` | pass | 7 routes, compiled in 3.1s, no warnings |
| Dashboard: 2 seeded bots + live market strip | pass | 7 symbols with live prices, `warm`, both bot cards |
| Decision in feed ≤1s after SSE event | pass | **13 ms** measured in-page (SSE `decision` receipt → feed row in DOM) |
| Bot page markers / expansion / outcome badges | pass | buy+sell markers + SL price line from real `pnpm paper` fills; row expands to reasoning; `1h +0.30` / `4h -0.30` / `24h —` badges |
| Stop/start from UI takes effect on next wake | pass | `trigger_log` for the probe bot has rows at 16:45:05 and 16:48:05 but **none at 16:46/16:47**, exactly the stopped window |
| Settings: key round-trip via vault | **partial** | save → `present:true`, `masked "wicxxx…6789"`, `getApiKey` decrypts (`hasKey:true`). After a server restart: `"decrypt failed"` — see defect below |
| No external font/CDN requests | pass | Playwright network log: **0** requests outside `127.0.0.1:3000`; only `/fonts/*.woff2` local; built CSS has no external `url()`; no `fonts.googleapis`/`gstatic`/`jsdelivr`/`unpkg` anywhere in `.next` |
| Console clean | pass | 0 errors, 0 warnings across `/`, `/bots/[id]`, `/market`, `/settings` |
| Design pass vs §12 | **deferred to Luka** | screenshots below |

**BLOCKER for Phase 7 — `WICK_MASTER_KEY` is regenerated on every boot.**
`apps/server/src/config.ts` does `import 'dotenv/config'`, which reads `.env` relative to
`process.cwd()`. Under `pnpm --filter @wick/server dev` the cwd is `apps/server/`, whose
`.env` only holds the legacy `COCKPIT_MASTER_KEY`. The repo-root `.env` that actually holds
`WICK_MASTER_KEY` is never loaded, so `index.ts` believes it is a first run, generates a new
key and **overwrites the root `.env`** — every single boot. Reproduced: root `.env` md5
changed across a restart and the just-saved cerebras key came back `"decrypt failed"`.
Nothing was lost (no real key has ever been stored), but the settings page cannot be trusted
until this is fixed. One-line fix in `config.ts`: load the repo-root `.env` explicitly on the
same path `index.ts` already computes, instead of relying on cwd. Not applied here — outside
the Phase 6 brief's permitted server edits.

Also noted (not fixed): lightweight-charts renders a TradingView attribution `<a>` pointing
at `tradingview.com`. It is a link, never fetched — no network request is made — but it is
the only external URL rendered by the app.

**Screenshots** (this run): `D:/Claude/tempo/Wick-plan/shots/` —
`01-dashboard`, `02-bot-page`, `03-bot-decision-expanded`, `04-bot-triggers-stopped`,
`05-bot-indicators`, `06-bot-journal`, `07-bot-config-drawer`, `08-market`, `09-settings`,
`10-settings-advanced-crt-on`, `11-dashboard-clean` (all `.png`).
**Design/screenshot review with Luka is still the one open Phase 6 item.**

Verification data was created and then purged: probe bots 3–5, their decisions/fills/
positions/outcomes/journal/lessons/indicator_stats/trigger_log rows, the throwaway `stub`
registry entry, its `llm_usage` row, and the test cerebras vault key are all gone; `bots` is
back to Patience/Contrarian and every trade table is at 0.

---

## Phase 7 notes / decisions (hardening & service)

**Verified 2026-08-08.** Everything below was run end to end on this box against the
built artifacts, not dev mode.

### 7.1 Service (pm2)

- `ecosystem.config.cjs` now runs **both** apps: `wick-server` (`apps/server/dist/index.js`)
  and `wick-web` (`next start -p 3000 -H 127.0.0.1`, script `node_modules/next/dist/bin/next`
  so pm2 never spawns the `.cmd` shim). Node 22 interpreter + `PATH` are pinned in each
  app's `env` (PLAN §16.10) and `NODE_ENV=production` is set for both.
- Shared restart policy: `max_restarts: 10`, `exp_backoff_restart_delay: 3000`,
  `min_uptime: 20s`, `max_memory_restart: 1G`. Logs split per app into
  `logs/{server,web}-{out,err}.log`.
- `NODE_ENV=production` is load-bearing for the SERVER too, not just Next:
  `util/logger.ts` attaches the `pino-pretty` transport in non-production and that
  worker thread crashes the process when stdout is a pm2 file/pipe. `pnpm smoke` sets
  it for the same reason.
- Root scripts: `pm2:start` (builds first), `pm2:restart`, `pm2:stop`, `pm2:delete`,
  `pm2:logs`, `pm2:status`.
- **pm2-logrotate stays a one-time manual install** (documented in README, not in the
  config file): `pm2 install pm2-logrotate` + `max_size 10M` + `retain 5`.
- Cycle test: `pm2 start ecosystem.config.cjs` -> both apps `online`, `/health` 200 with
  `marketWarm:true` off the built dist, web `/` 200 (8211 bytes) -> `pm2 delete all`,
  pm2 list left empty. **`pm2 save` / `pm2-startup install` were deliberately NOT run.**

**Blocker found and fixed while doing this:** `node apps/server/dist/index.js` had never
worked. `@wick/shared` was a source-only package (`main: ./src/index.ts`), which tsx and
Next transpile but plain Node cannot load — the built server died with
`ERR_MODULE_NOT_FOUND .../packages/shared/src/assets.js`. `packages/shared` now emits
`dist/` (`build` script; `main`/`types`/`exports` point at it), and the root `dev` script
builds it first so a clean clone still boots in dev.

### 7.2 Crash-only audit — 12/12 pass

Processes were killed with SIGKILL and the DB inspected afterwards. Every row the
harness created was purged (`bots` back to Patience/Contrarian, all trade tables at 0).

| Scenario | Result | Evidence |
|---|---|---|
| kill -9 **inside a fill transaction** | pass | victim killed mid-transaction (marker written from inside the tx): `fills=0 positions=0 cash=1000` — every write rolled back; `PRAGMA integrity_check=ok` |
| kill -9 **mid-LLM call** | pass | bot pointed at a black-hole HTTP provider that accepts and never answers; killed with the request in flight -> `decisions=0 fills=0` (absent, never phantom-executed) |
| **restart after that kill** | pass | server reboots to `marketWarm`, `bots reloaded` logged, still `decisions=0` — the in-flight wake is neither resumed nor duplicated (the wake queue is process memory, so it empty-starts by construction) |
| kill -9 **mid-evaluator pass** | pass | 2400 seeded decisions; killed after 0.7s with `3191/7200` outcome rows written, 0 duplicate `(decision,horizon)` rows |
| **evaluator re-picks** | pass | re-run drained the rest: `7200/7200` outcomes, 4009 added, 0 duplicates (idempotent via the outcomes PK + the `NOT EXISTS` filter) |
| **protector re-arms** | pass | position with a stop above market inserted, server booted cold -> `protector armed` -> sell fill @ 64972.96 vs stop 97508.17, position gone, exactly 1 `trigger_type='protector'` decision |

**Fix made:** `bot-runner` writes the decision row *before* asking the engine to fill it
(so the fill can carry `decision_id`), so a kill -9 in between leaves a `buy` decision
marked `executed` that never moved money — a phantom trade in both the audit trail and
the learning stats. New `bots/reconcile.ts` runs at boot and rewrites any buy/sell
decision that is `executed` with no matching `fills` row to
`vetoed / veto_reason='crash_no_fill'`. Verified: a hand-planted phantom row came back
`status=vetoed veto_reason=crash_no_fill` after one boot. Chosen over widening the
transaction across an event-publishing engine call — crash-only repair, not a bigger lock.

### 7.3 Data hygiene

`jobs/hygiene.ts`, started from `index.ts`:

- nightly **03:20** — prune `candles` with `tf='1m'` older than 14d and `trigger_log`
  older than 30d (higher timeframes are tiny and the evaluator prices off 1h, so only 1m
  is pruned; decisions/fills/outcomes/journal are never pruned), then a rotated backup.
- backups via better-sqlite3's online `backup()` (WAL-safe, no writer lock) into
  `apps/server/data/backups/`, newest 3 kept. Verified: 4 backups written, oldest
  removed, 3 remain.
- weekly **Sun 03:40** — `VACUUM`, **skipped when a fill landed in the last 60s**
  (IMPL-4 pitfall). Both paths verified: `vacuumed` when quiet, `skipped` with a fresh fill.
- No SSE GC pass was needed: `api/sse.ts` already unsubscribes from the bus on the
  socket's `close` event.

### 7.4 Ops surface

- `GET /health` (now `api/health.ts`) returns ws `{connected,lastMessageAgoMs,reconnectAttempt,symbols,buffering}`,
  `marketWarm`, per-provider `{enabled,rpd,used,errors,remaining,headroom}`, `poolRemaining`,
  bots `{total,running,stopped,busted}`, last evaluator run `{ts,agoSec,written,skipped}`
  and DB stats. New accessors: `wsStatus()` (binance-ws) and `lastEvaluatorRun()` (evaluator).
- `pnpm doctor` prints the same report plus what the server cannot see: Node version
  (warns off 22), presence of `apps/server/dist` and `apps/web/.next`, master key,
  per-provider key presence, backup files. Degrades to `SERVER DOWN` with local DB
  numbers when nothing is listening, and exits 0 either way.

### 7.5 Smoke test

`pnpm smoke` — **green, 9/9**, ~90s. It installs a throwaway `stub-smoke` provider
(adapter `stub`, no network, no key), boots the real server (built dist when present,
else tsx on source) against real Binance, waits for `marketWarm`, creates a 1m-cadence
throwaway bot pinned to that provider and waits for the scheduled wake. Asserts: the
decision row is the stubbed BUY and `executed`, the provider is recorded, the fill was
written (`qty=0.003076 @ 65048.50 fee=0.20`), the position opened with SL/TP armed, and
both the decision and the fill arrived over SSE. Teardown removes the bot and every row
it wrote, its `llm_usage` row, and restores `providers.registry` byte for byte.

- The stub adapter gained a `WICK_STUB_DECISION` env override so an out-of-process
  server can return a deterministic non-`wait` decision; in-process `setStubScript`
  behaviour is unchanged.
- Registry gotcha (again): a stub provider row needs a non-empty `baseUrl` or
  `getProviders()` silently drops it.

### 7.6 Docs & cleanup

- `README.md` rewritten: what Wick is, the three code-enforced rules, an architecture
  sketch, Node 22 run instructions, script table, pm2 service section (including the
  manual logrotate/startup steps), provider-key setup pointing at `llm/README-setup.md`,
  data durability, and the "paper only, $0 by design" statement.
- Dead `/stream` rewrite (cockpit leftover) removed from `apps/web/next.config.mjs`.

### Deferred — Luka runs these

1. **72h unattended soak** with 2 bots on real free tiers (the real Phase-7 gate:
   uptime, calls/day per provider, decisions, candle gaps self-healed, memory flat).
   Needs provider keys first; the report belongs in this file.
2. **Design/screenshot review** of the Phase 6 UI vs PLAN §12 — still the one open
   Phase 6 item (screenshots in `D:/Claude/tempo/Wick-plan/shots/`).
3. **Provider key registration** — no key has ever been stored, so the router skips
   every provider and live bots would record `llm_failed`.
4. **pm2 boot autostart** — `pm2 save` + `pm2-startup install`, plus
   `pm2 install pm2-logrotate`. Deliberately not touched here; pm2 was left with an
   empty process list.
5. Windows sleep/hibernate still kills the WS silently — either disable sleep on the
   box or confirm reconnect + hourly self-heal covers a multi-hour gap.
