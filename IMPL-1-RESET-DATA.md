# IMPL-1 — Phase 0 (Reset & Carve-out) + Phase 1 (Market Data & Indicators)

> Read `PLAN.md` fully first. This file assumes it.

---

## Phase 0 — Reset & Carve-out

**Objective:** the repo compiles and boots as *Wick* with the old scope surgically removed,
packages renamed, and a fresh empty DB schema. No new features yet.

### Prereqs
- Node 22 on PATH (`export PATH="/d/Claude/Tools/node-v22:$PATH"`), pnpm working.
- Create `STATUS.md` in repo root (copy the old format: phase checklist, env notes, blockers).
- Work on `main` directly (single-user repo) or a `wick-reset` branch — Luka's call at start.

### Tasks

**0.1 Delete dead scope.** Remove every file in PLAN §3 "Delete" list. Then chase compile
errors outward: remove their route registrations in `index.ts`/`api/server.ts`, their
event-bus topic constants, their shared types in `packages/shared`, their seed loaders.
Deletion is done when `grep -ri "whale\|alpaca\|cryptopanic\|fred\|yahoo\|ccxt\|probability\|alert" apps packages`
returns only comments/README hits (then clean those too).

**0.2 Prune dependencies.** Root + server `package.json`: drop `yahoo-finance2`, `rss-parser`,
`@alpacahq/alpaca-trade-api`, `ccxt`, and anything else now unimported (`pnpm why` to verify).
Add nothing yet.

**0.3 Rename.** `@cockpit/server|web|shared` → `@wick/server|web|shared`; root name `wick`;
all imports; `ecosystem.config.cjs` app name `wick-server` (+ keep Node 22 path in its `env`);
pm2 script names in root package.json. README.md: 5-line placeholder ("Wick — LLM paper-trading
bots on live crypto data. Rebuild in progress, see PLAN.md").

**0.4 Fresh DB.** Delete `data/*.db*` and all old migrations. Write `001_wick.sql`
implementing PLAN §6 exactly (all tables, PKs, plus indexes:
`decisions(bot_id, ts)`, `outcomes(decision_id)`, `fills(bot_id, ts)`, `candles(symbol, tf, ts)`,
`trigger_log(ts)`, `journal(bot_id, ts)`). Keep the existing migrate runner. Seed: 7 default
assets from old `crypto_watchlist.json`, default settings rows (guard defaults, trigger
thresholds, provider registry skeleton with empty keys).

**0.5 Trim `index.ts` boot** to: config → db+migrate → vault → event bus → (collectors, off
until Phase 1 wiring check) → API server → SSE. Server boots clean with zero collectors erroring.

**0.6 Web shell.** Delete removed pages; leave `/` rendering a "WICK" placeholder with the
PLAN §12 palette tokens defined as CSS variables in `globals.css` (design system proper is Phase 6).
App title/icon → Wick.

### Acceptance (Phase 0 exit)
- [ ] `pnpm install` clean on Node 22; lockfile pruned.
- [ ] `pnpm typecheck` green across all 3 packages.
- [ ] `pnpm migrate` creates wick.db with exactly the PLAN §6 tables; idempotent on re-run.
- [ ] Server boots on `127.0.0.1:3001`; `GET /health` 200; `GET /api/assets` returns 7 seeded symbols.
- [ ] Grep check from 0.1 returns nothing.
- [ ] Commit: `Phase 0 — reset to Wick`.

---

## Phase 1 — Market Data & Indicators

**Objective:** live Binance data for the watchlist flowing continuously: ticks over SSE,
candles persisted for 1m/15m/1h/4h/1d, indicators computed on every candle close with
directional votes stored. This is the sensory system everything else reads.

### Tasks

**1.1 Binance collectors (adapt existing).**
- `binance-ws.ts`: subscribe trade/miniTicker + kline streams for active assets × (1m, 1h).
  Keep existing reconnect/heartbeat. Publish `tick` and `kline` events on the bus.
- `binance-rest.ts`: backfill on boot — 500 candles per (symbol × tf) for 1m/15m/1h/4h/1d
  into `candles`; then keep 15m/4h/1d updated by aggregating closed 1m/1h klines (or periodic
  REST refresh — pick one, note in STATUS).
- Respect existing rate-limiter for REST bursts.
- Set a `marketWarm` flag on the bus once backfill completes (PLAN §16.9 — trigger engine gates on it).

**1.2 Funding + Fear&Greed (adapt existing).**
- `funding-oi.ts`: poll Binance futures funding rate per symbol every 15 min → bus event + latest value queryable.
- `fear-greed.ts`: poll alternative.me daily → same.
- Both are *indicator inputs*, not tradeable data.

**1.3 Indicator engine.** New `market/indicator-engine.ts`, consuming `kline` close events;
math lives in existing `core/indicators.ts` (extend, don't rewrite; add only what's missing).
On each closed candle (per symbol, tf ∈ {1h} for votes; compute-only for other tfs as needed):

| Indicator | Values | Vote rule (bull / bear / neutral) |
|---|---|---|
| RSI(14) | value | <30 bull · >70 bear · else neutral |
| EMA trend | EMA20 vs EMA50 vs EMA200 | 20>50>200 bull · 20<50<200 bear · else neutral |
| MACD(12,26,9) | macd, signal, hist | hist crosses >0 bull · <0 bear · else neutral |
| Bollinger(20,2) | upper, lower, %B | close<lower bull (mean-revert read) · close>upper bear · else neutral |
| ATR(14) | value | no vote (volatility input for triggers/slippage) |
| Volume ratio | vol / SMA20(vol) | >2 with green candle bull · >2 with red bear · else neutral |
| Funding | rate | < −0.01% bull · > +0.05% bear · else neutral |
| Fear&Greed | index | <25 bull · >75 bear · else neutral |

Write to `indicator_values` (name, value, vote), publish `indicator` bus event.
Vote rules are v1 defaults — keep them in one table-like const so Phase 5 stats can reference names 1:1.

**1.4 API + SSE.**
- `GET /api/market/candles?symbol&tf&limit` (from DB, newest last).
- `GET /api/market/indicators?symbol&tf` (latest set with votes).
- `GET /api/market/summary` — all symbols: last price, 24h change, latest votes (dashboard strip).
- SSE channel emits `tick` (throttled ≤2/s per symbol), `candle`, `indicator`.

**1.5 Scheduler.** Adapt `jobs/scheduler.ts` (node-cron): funding poll, F&G poll, candle-gap
self-heal (hourly: detect missing candles, REST-backfill).

### Acceptance (Phase 1 exit)
- [ ] Boot from empty DB: backfill completes < 60s, `marketWarm` fires, no rate-limit errors.
- [ ] `candles` grows on the minute; kill network 30s → WS reconnects, gap self-heals within the hour.
- [ ] `GET /api/market/indicators?symbol=BTCUSDT&tf=1h` returns all 8 indicators with votes after next candle close.
- [ ] SSE: `curl -N /api/sse` shows live ticks for all 7 symbols.
- [ ] 12h soak (leave running): no crash, no unbounded memory, candle gaps zero.
- [ ] Commit: `Phase 1 — market data + indicators`.

### Pitfalls
- Binance kline event fires many times per candle; act only on `k.x === true` (candle closed).
- Backfill vs WS race: buffer WS klines during backfill, apply after (existing code may already do this — verify).
- alternative.me has no SLA — cache last value, tolerate 24h staleness silently.
- Funding endpoint is `fapi.binance.com` (futures domain) — different rate-limit bucket than spot.
