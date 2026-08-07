# Wick — Plan (Shared Reference)

> **Source of truth.** Read this file fully before touching any implementation file.
> Implementation phases are split across four **IMPL-\*.md** files — see [section 14](#14-phase-index).

**Owner:** Luka
**Repo:** `github.com/nimrod21/Wick` · **Local:** `D:/Projects/Wick`
**Status:** Planning complete — implementation not started
**Last updated:** 2026-08-08

**Files in this plan:**
- `PLAN.md` — this file, shared reference
- `IMPL-1-RESET-DATA.md` — Phase 0 (reset/carve-out) + Phase 1 (market data & indicators)
- `IMPL-2-ENGINE.md` — Phase 2 (paper trading engine) + Phase 3 (LLM provider layer)
- `IMPL-3-BOTS-LEARNING.md` — Phase 4 (bots + trigger engine) + Phase 5 (learning & memory)
- `IMPL-4-UI-HARDENING.md` — Phase 6 (UI) + Phase 7 (hardening & service)
- `STATUS.md` — create at Phase 0 start; live progress tracker (same format as old repo)

---

## 0. Start Here

**What this is:** Wick is a rebuild of `trading-cockpit` around one idea: **LLM paper-trading
bots that run continuously, decide on real live crypto data, log every decision, get judged
in hindsight, and slowly learn which signals to trust.** The dashboard exists to watch the
bots, not the other way around.

**If you're a fresh Claude picking this up:**
1. Read this PLAN.md fully.
2. Check `STATUS.md` in repo root for current phase.
3. Open the IMPL file for the current phase ([section 14](#14-phase-index)).
4. Never expand scope without asking Luka first. Explicit standing instruction: "don't change my ideas."
5. All timestamps UTC internally, rendered local at the edge.
6. Temp/scratch files go to `D:/Claude/tempo/`, never into the repo.
7. Capitalized names for project folders/repos (Wick, not wick).

**Non-negotiables:**
- Local only — server binds `127.0.0.1`.
- **Strictly $0 running cost.** Free LLM tiers only, keyless Binance data, no paid services.
- Paper money only. No live trading anywhere in this plan.
- Wait is a first-class decision. Anti-microtrading guards are code, not prompt suggestions.
- Keys encrypted in local SQLite vault (existing mechanism), never logged, never sent to frontend in full.
- Toned-down pixel-80s design ([section 12](#12-design-direction)).

---

## 1. Mission & Scope

### In scope
- Live real-time charts + indicators for the crypto watchlist (default: BTC, ETH, SOL, BNB, XRP, ADA, LTC — UI-editable).
- Multiple LLM bots, each with its own fake bankroll, personality config, and model/provider preference.
- Bots run server-side continuously until stopped, busted, or drawdown-killed. Restart-safe.
- Free-tier LLM provider rotation (OpenRouter free models, Groq, Gemini, Mistral, Cerebras, optional local Ollama).
- Code-side trigger engine that wakes bots on market events; code-side stop-loss/take-profit that never waits for an LLM.
- Full decision audit trail: every buy/sell/wait with inputs, reasoning, provider, outcome.
- Learning loop: per-indicator hit-rate stats → adaptive weights/toggles; bot journal → compressed standing lessons; both fed back into prompts.

### Out of scope (do not build, do not stub)
- Stocks, commodities, forex — crypto only.
- Live trading, real keys with trade permissions, withdrawals.
- Whale tracking, news aggregation, macro dashboards, standalone alerts (superseded by triggers).
- Backtesting engine (v2 candidate; the decision log is designed so one can be added later).
- Shorting/perps simulation. v1 is spot long/flat. (Funding rate is still *read* as an indicator.)

---

## 2. Locked Decisions

| # | Decision |
|---|---|
| 1 | Name **Wick**; repo `nimrod21/Wick`; local `D:/Projects/Wick`. |
| 2 | Crypto-only, Binance public data (keyless WS + REST). |
| 3 | LLM cost strictly $0: stacked free tiers behind a rotation layer. No $10 OpenRouter deposit assumed. |
| 4 | Bots decide on candle close (default 1h) **plus** event triggers — never on every tick. |
| 5 | Exits are protected by code (SL/TP watcher on live ticks), not by the LLM. |
| 6 | Anti-microtrading guards enforced in code (cooldown, min-hold, max trades/day, min confidence). |
| 7 | `wait` is logged and evaluated like any other decision, and can score as correct. |
| 8 | Realistic paper fees (0.1%/side) + slippage; fee drag shown to the bot in its prompt. |
| 9 | Learning = bookkeeping + prompt feedback (stats, weights, lessons). No model training. Slow by design: minimum sample sizes before any adjustment. |
| 10 | Every decision records which provider/model answered, so models can be compared on trading record. |
| 11 | Fresh DB schema (old cockpit data is worthless; delete `data/`, new migrations from 001). |
| 12 | Pixel-80s design, toned down: dark base, 2–3 phosphor accents, pixel font for headings only. |
| 13 | Keep the old backbone (Fastify, SQLite, event bus, SSE, vault, rate limiter, Binance collectors, indicator math, paper-mode/order-manager/risk-guards as adaptation bases). Delete everything else ([section 3](#3-carve-out-map)). |

---

## 3. Carve-out Map

What happens to every part of the old repo at Phase 0.

### Keep as-is (rename imports only)
`apps/server/src/index.ts` (trimmed), `api/server.ts`, `api/sse.ts`, `api/settings.ts`,
`api/candles.ts`, `api/assets.ts`, `core/event-bus.ts`, `core/indicators.ts`,
`db/client.ts`, `db/migrate.ts`, `util/crypto-vault.ts`, `util/logger.ts`,
`util/rate-limiter.ts`, `util/time.ts`, `collectors/crypto/binance-ws.ts`,
`collectors/crypto/binance-rest.ts`, `collectors/macro/fear-greed.ts`,
`collectors/macro/funding-oi.ts`, `jobs/scheduler.ts`, `packages/shared`.

### Keep as adaptation base (heavy edits in Phase 2)
`execution/paper-mode.ts`, `execution/order-manager.ts`, `execution/risk-guards.ts`.

### Delete (files + their deps + their API routes + their seed files)
- Whales: `collectors/onchain/*`, `api/whales.ts`, `seed/whale_addresses.json`, `seed/ignore_addresses.json`
- News: `collectors/news/*`, `api/news.ts`, `data/sentiment-lexicon.json`, `data/ticker-aliases.json`, `seed/rss_feeds.json`, deps `rss-parser`
- Stocks/commodities: `collectors/stocks/*`, `execution/stocks-alpaca.ts`, `data/us-market-holidays.json`, `util/market-hours.ts`, `seed/stock_watchlist.json`, `seed/commodity_watchlist.json`, deps `yahoo-finance2`, `@alpacahq/alpaca-trade-api`
- Macro (unused parts): `collectors/macro/fred.ts`, `collectors/macro/dxy-vix.ts`, `collectors/macro/btc-dominance.ts` (keep fear-greed + funding-oi)
- Probability engine: `core/probability-engine.ts`, `api/probability.ts`, `seed/probability_weights.json` (bots replace it)
- Alerts: `core/alert-engine.ts`, `api/alerts.ts`, web `alerts/` page + components (trigger engine replaces it)
- Live execution: `execution/crypto-ccxt.ts`, dep `ccxt`, `api/live-mode.ts`, `api/orders.ts`/`positions.ts` (rebuilt bot-scoped in Phase 2)
- `core/normalizer.ts`, `core/snapshot-job.ts` if nothing keeps using them after the cut
- Old DB migrations + `data/*.db`
- Web pages: `whales/`, `news/`, `alerts/`, `indicators/` (indicator display moves into market/bot pages), old `trading/`

### Rename
- Packages `@cockpit/*` → `@wick/*`; root package `trading-cockpit` → `wick`.
- pm2 app `cockpit-server` → `wick-server` in `ecosystem.config.cjs`.
- README rewritten for Wick; old PLAN/IMPL/STATUS md files replaced by this plan's files.

---

## 4. Architecture Overview

```
apps/server  (Fastify, 127.0.0.1:3001)
  collectors/binance-{ws,rest}   → live ticks, candles, funding   ─┐
  collectors/fear-greed          → daily F&G index                 ├→ event-bus → SSE → web
  market/indicator-engine        → per-candle indicator values    ─┘
  market/trigger-engine          → watches ticks+indicators, emits bot wake events (pure code)
  bots/bot-runner                → per-bot loop: wake → snapshot → prompt → LLM → guards → execute
  bots/scheduler                 → candle-close ticks per bot cadence
  llm/router                     → provider rotation, quota ledger, zod-validated decisions
  paper/engine                   → fills w/ fees+slippage, positions, equity, bankroll
  paper/protector                → SL/TP watcher on live ticks (no LLM)
  learn/evaluator                → scores decisions after horizons (cron)
  learn/indicator-stats          → hit rates → weights/toggles
  learn/journal                  → reflections + daily lesson compression (1 LLM call/bot/day)
  db (better-sqlite3)            → single wick.db, WAL mode

apps/web  (Next.js, 127.0.0.1:3000)
  /            dashboard: bot cards, market strip, live decision feed
  /bots/[id]   chart w/ trade markers, decision log, indicator stats, journal, controls
  /market      per-symbol charts + indicator panels
  /settings    provider keys, quota status, watchlist, guard defaults
```

Data flow for one decision:
```
trigger (or candle close) → budget/cooldown gate → snapshot builder
  → prompt (market + indicators×weights + position + stats + lessons + trigger reason)
  → llm/router (rotation) → zod parse → risk-guards clamp/veto
  → paper engine execute (or wait) → decisions row → SSE to UI
  … later: evaluator scores it → indicator-stats update → journal reflection
```

---

## 5. Tech Stack

Unchanged from cockpit where possible (already installed and working):
**Fastify 4 + fastify-sse-v2, better-sqlite3 v12 (WAL), zod, node-cron, pino, ws, undici,
bottleneck, Next.js 14 + React 18, Tailwind, pnpm workspaces, tsx, TypeScript 5, pm2.**

New (all free):
- **lightweight-charts** (TradingView OSS) — real candle charts. Replaces any old chart lib.
- No LLM SDK: all providers speak OpenAI-compatible `/chat/completions` over `undici` fetch.
  (Gemini native API differs — the router has a tiny per-provider request adapter instead.)

Environment (carried over from cockpit, still true):
- **Node 22 LTS required** (better-sqlite3 prebuilt issue on Node 24). Portable install:
  `D:/Claude/Tools/node-v22/` — prepend to PATH: `export PATH="/d/Claude/Tools/node-v22:$PATH"`.
- Windows service via pm2, `ecosystem.config.cjs`.

---

## 6. Data Model

Fresh schema, migration `001_wick.sql`. All `ts` columns are UTC unix ms. All money is USD floats (paper — precision paranoia not needed; qty floats fine for spot).

```sql
assets            (symbol PK, display_name, active, added_ts)          -- watchlist, UI-editable
candles           (symbol, tf, ts, o, h, l, c, v, PK(symbol,tf,ts))    -- 1m,15m,1h,4h,1d cache
indicator_values  (symbol, tf, ts, name, value, vote, PK(symbol,tf,ts,name))
                  -- vote: 'bull'|'bear'|'neutral' — the directional read used for learning
settings          (key PK, value)                                       -- includes encrypted keys (existing vault format)

bots              (id PK, name, status, bankroll_start, cash, config_json, created_ts, stopped_ts)
                  -- status: 'running'|'stopped'|'busted'
                  -- config_json: {cadence_tf, symbols[], provider_order[], model_prefs[],
                  --   personality, min_confidence, max_trades_day, cooldown_min, min_hold_min,
                  --   max_pos_pct, drawdown_kill_pct, default_sl_pct, default_tp_pct}
positions         (bot_id, symbol, qty, avg_entry, stop_price, tp_price, opened_ts, PK(bot_id,symbol))
fills             (id PK, bot_id, decision_id, symbol, side, qty, price, fee, slip, ts)
equity_snapshots  (bot_id, ts, equity, PK(bot_id,ts))                   -- hourly, for sparklines/drawdown

decisions         (id PK, bot_id, ts, trigger_type, trigger_detail,
                   snapshot_json,          -- full indicator values+votes+weights at decision time
                   action,                 -- 'buy'|'sell'|'wait'
                   symbol, size_pct, confidence, reasoning,
                   sl_pct, tp_pct,
                   provider, model, latency_ms,
                   status,                 -- 'executed'|'vetoed'|'llm_failed'
                   veto_reason)
outcomes          (decision_id, horizon,   -- '1h'|'4h'|'24h'
                   fwd_ret_pct, score,     -- score ∈ [-1,1], see §11
                   evaluated_ts, PK(decision_id,horizon))

indicator_stats   (bot_id, indicator, samples, hits, weight, enabled, updated_ts, PK(bot_id,indicator))
journal           (id PK, bot_id, ts, kind, text)                       -- kind: 'reflection'|'lesson'
lessons_current   (bot_id PK, text, updated_ts)                         -- ≤10 bullet lessons, prompt-injected

llm_usage         (provider, date, calls, errors, PK(provider,date))    -- daily quota ledger, survives restart
trigger_log       (id PK, ts, bot_id, type, detail, fired)              -- fired=0 when gated by cooldown/budget
```

---

## 7. LLM Provider Layer

One module: `llm/router.ts` + `llm/providers.ts` (registry) + per-provider adapters.

**Registry** (defaults; editable in Settings, stored in `settings` table):

| Priority | Provider | Endpoint style | Default model | Free limits (approx, verify at setup) |
|---|---|---|---|---|
| 1 | OpenRouter | OpenAI-compat | a current `:free` model (e.g. `deepseek/deepseek-chat-v3-0324:free`) | ~50 req/day, 20/min |
| 2 | Groq | OpenAI-compat | `llama-3.3-70b-versatile` | ~1k+ req/day |
| 3 | Gemini (AI Studio) | native adapter | `gemini-2.5-flash-lite` or flash | ~250–1500 req/day by model |
| 4 | Mistral | OpenAI-compat | `mistral-small-latest` | free tier, ~1 req/s |
| 5 | Cerebras | OpenAI-compat | `llama-3.3-70b` | generous free tier |
| 6 | Ollama (optional) | OpenAI-compat, `localhost:11434` | any local model | unlimited |

Free-tier model names/limits drift — the registry keeps `rpm`/`rpd` per provider as editable
settings, and setup instructions live in IMPL-2. Do not hardcode limits in logic.

**Routing rules:**
1. A call carries the bot's `provider_order` (default: registry order). Pick the first provider with headroom in the `llm_usage` ledger and its rpm bucket.
2. On 429 / 5xx / timeout (20s) / malformed JSON after one repair-retry → mark error in ledger, fall through to next provider.
3. All providers exhausted → the decision is recorded as `llm_failed` and treated as `wait`. Never crash the bot loop.
4. Every successful call logs provider+model+latency onto the decision row.

**Decision contract** (zod, `packages/shared`):
```ts
{ action: 'buy'|'sell'|'wait',
  symbol: string|null,          // required for buy/sell
  size_pct: number|null,        // buy: % of cash; sell: % of position; 1–100
  confidence: number,           // 0–100
  reasoning: string,            // ≤ 400 chars
  sl_pct: number|null, tp_pct: number|null }   // optional overrides for this position
```
Response must be JSON only (`response_format: json_object` where supported; otherwise prompt-enforced + extract-first-JSON fallback). One "your JSON was invalid, reply with only corrected JSON" retry, then fail over.

---

## 8. Bot Decision Loop

A bot is a DB row + config; `bot-runner.ts` executes wakes. No per-bot threads — a single
async queue serializes decisions per bot.

**Wake sources:** scheduler (candle close of the bot's `cadence_tf`, default 1h) and trigger engine (§9).

**On wake:**
1. Gate: bot `running`? global per-bot floor (≥10 min since last decision)? trades-left-today > 0 for trade-capable wakes? LLM budget available (§9 priority rules)?
2. Build snapshot: latest candles summary (last 24×1h OHLC compressed), all **enabled** indicator values + votes + weights + hit-rates, open position + unrealized P&L, cash/equity/drawdown, fee drag (7d fees vs 7d gross P&L), last 5 decisions with their evaluated outcomes, `lessons_current`, trigger reason, guard state ("3 trades left today, cooldown 12min remaining").
3. Prompt = static system prompt (role, hard rules, fee schedule, personality from config) + snapshot. System prompt states: **default is `wait`; trade only with confidence ≥ bot's min_confidence; you win by being right, not by being busy.**
4. Call `llm/router`. Parse decision.
5. `risk-guards` pass (§10) — may veto (logged `vetoed` + reason) or clamp size.
6. Execute via paper engine; write decision row; SSE-push to UI.

**Lifecycle:** `running → stopped` (user), `→ busted` (equity ≤ 0 or drawdown ≥ `drawdown_kill_pct`, default 50% — bot halts but its corpse remains fully inspectable). Reset = new bankroll, archives old decisions under a run counter. On server boot: reload bots, positions, quota ledger; resume `running` bots; protector re-arms from `positions` table.

---

## 9. Trigger Engine (pure code, zero LLM)

`market/trigger-engine.ts` subscribes to the event bus (ticks + new candles + indicator updates).

**Trigger types:**

| Pri | Type | Condition (defaults, config in settings) |
|---|---|---|
| P1 | `position_event` | unrealized P&L crosses ±half of SL/TP distance; or equity drawdown crosses warning line |
| P1 | `price_velocity` | \|Δprice\| over 15m > 2 × ATR(1h) |
| P2 | `rsi_cross` | RSI(14,1h) crosses 30 or 70 |
| P2 | `macd_cross` | MACD/signal cross on 1h |
| P2 | `bb_breakout` | close outside Bollinger(20,2) on 1h |
| P2 | `volume_spike` | candle volume > 3 × 20-candle average |
| P2 | `funding_flip` | funding rate sign change |
| P3 | `scheduled` | bot's cadence candle close |

**Discipline:**
- Per (trigger type × symbol) cooldown: 15 min. Per-bot global floor: one wake per 10 min.
- Budget gate: compute remaining pooled daily calls from `llm_usage` vs registry `rpd`. Reserve 30% of the day's pool for P1. P2 passes only if pool > 50% remaining or it's the bot's watched symbol with an open position. P3 always attempts (it's the baseline cadence) but yields if pool is exhausted.
- Every trigger evaluation that matches logs to `trigger_log` with `fired` 0/1 — gating must be visible/debuggable.
- Trigger reason string is passed into the prompt ("Woken by: RSI(1h) crossed 70 on SOL").

**The protector is not a trigger:** `paper/protector.ts` watches live ticks against `positions.stop_price/tp_price` and executes SL/TP fills immediately in code. A P1 wake may *also* fire so the bot can reassess, but the exit never waits for it.

---

## 10. Guards & Anti-Microtrading

Hard rules in `risk-guards.ts` (code veto/clamp, per-bot config, defaults):

- Min confidence to trade: **65**. Below → recorded as `wait` (veto reason kept).
- Cooldown after any fill: **30 min**. Min hold before selling (except SL/TP): **60 min**.
- Max trades/day: **6**. Max position per symbol: **30%** of equity. One position per symbol.
- Buy size clamp: min $10 notional, max = available cash.
- Default SL **−5%** / TP **+10%** applied if LLM omits them; LLM overrides clamped to SL ∈ [−15%, −1%], TP ∈ [+2%, +50%].
- Drawdown kill: **50%** from bankroll high-water mark → `busted`.
- Fees: **0.1% per side** + slippage 0.05% (bumped ×2 during a `price_velocity` trigger window). Fills at live mid ± slippage.

Why (context from Luka's previous attempt): earlier bots microtraded — acted every tick,
never waited. These guards + candle-close cadence + `wait`-as-default prompt + visible fee
drag are the fix. **Do not weaken them to make bots "more active."**

---

## 11. Learning System

Three memories, all fed back into every prompt. Slow by design.

**1. Outcome evaluation** — `learn/evaluator.ts`, cron every 15 min:
for each decision past a horizon (1h, 4h, 24h) without an outcome row, compute forward return
of the decision's symbol (or BTC for symbol-less waits) and score ∈ [−1,1]:
- `buy`: score = clamp(fwd_ret / 2%, −1, 1) minus round-trip fee (0.25%) — being right small still costs.
- `sell`: score = clamp(−fwd_ret / 2%, −1, 1) — selling before a drop is a win.
- `wait`: score = +0.3 if \|fwd_ret\| < 0.3% (nothing to catch) or fwd_ret < −0.3% (buying would have lost); −0.3 if fwd_ret > +1% (missed a real move); else 0. Waiting is rewarded, but chronic missing isn't.
- **4h is the primary horizon** for stats; 1h/24h stored for analysis.

**2. Indicator stats** — on each evaluated (4h) decision, for every indicator vote in its snapshot:
`hit` if vote direction matched sign(fwd_ret) beyond ±0.3%, neutral votes skipped.
Per (bot, indicator): hit-rate with Laplace smoothing.
- Weight update only when `samples ≥ 30`: `w ← clamp(w × (1 + 0.1×(hitrate − 0.5)), 0.25, 2.0)`, recomputed daily.
- Auto-disable when `samples ≥ 100` and hitrate < 0.45. Disabled indicators re-enter a 1-week trial every 4 weeks (votes recorded, not shown to bot) — regimes change.
- Weights + hit-rates are *shown to the bot* in the prompt and *used* to order/annotate indicators; they never place trades themselves.

**3. Journal & lessons** — after each evaluated trade decision, a code-generated one-line
reflection ("Bought SOL on volume_spike at conf 72 → −1.8% @4h. RSI vote wrong, MACD right.")
into `journal`. Once per day per bot, **one** LLM call compresses the last 7 days of
reflections + current stats into ≤10 standing lessons → `lessons_current` (replaces previous).
Lessons ride along in every prompt. This is the only non-decision LLM spend.

---

## 12. Design Direction

Pixel-80s, **toned down** — CRT terminal, not neon arcade.

- Base: near-black `#0B0B10`, panels `#12121A`, 1px hard borders `#2A2A38`. No gradients, no glow by default.
- Accents (max 3 on screen): phosphor green `#33FF66` (positive/running), amber `#FFB000` (warnings/wait), cyan `#2DE2E6` (info/links). Red `#FF3860` only for losses/busted.
- Type: pixel font (Press Start 2P or similar) for page titles + bot names **only**, small sizes; everything else JetBrains Mono. Numbers tabular.
- Charts: lightweight-charts dark theme matched to palette; green/red candles desaturated.
- Optional CRT scanline overlay as a settings toggle, default **off**.
- Motion: none decorative; only data updates (tick flash, decision feed slide-in).

---

## 13. Page / Route Map

| Route | Content |
|---|---|
| `/` | Bot cards (name, status LED, equity + sparkline, W/L, today's trades/calls) · market strip (7 symbols, live) · global live decision feed |
| `/bots/[id]` | Controls (start/stop/reset, allowance, config) · equity curve · price chart with buy/sell/SL/TP markers · decision log (expandable reasoning + outcome badges) · indicator stats table (weight, hit-rate, samples, enabled) · journal & current lessons |
| `/market` | Per-symbol candle chart (tf switcher) + indicator panel + funding/F&G |
| `/settings` | Provider keys (vault) + per-provider quota status/limits · watchlist editor · guard defaults · CRT toggle |

Server API (Fastify, all under `/api`): `bots` CRUD + `start/stop/reset`, `decisions`,
`outcomes`, `stats`, `journal`, `market/candles`, `market/indicators`, `providers/status`,
`settings`, `sse` (events: tick, candle, decision, fill, equity, trigger, bot-status).

---

## 14. Phase Index

| Phase | File | Content | Exit check |
|---|---|---|---|
| 0 | IMPL-1 | Reset & carve-out: deletions, renames, fresh schema | typecheck green, server boots, old scope gone |
| 1 | IMPL-1 | Market data: Binance WS/REST, candle store, indicator engine, SSE | live values for 7 symbols, indicators on candle close |
| 2 | IMPL-2 | Paper engine: fills/fees/slippage, positions, equity, protector | scripted buy→SL exit works tick-driven |
| 3 | IMPL-2 | LLM layer: vault keys, router, rotation, quota ledger, decision schema | `pnpm ask` returns valid decision, forced-429 rotation works |
| 4 | IMPL-3 | Bots + triggers: lifecycle, scheduler, trigger engine, full pipeline | bot trades end-to-end from a real trigger; survives restart |
| 5 | IMPL-3 | Learning: evaluator, indicator stats/weights, journal/lessons | outcomes scored, weights move only past sample floor |
| 6 | IMPL-4 | UI: design system + all four pages, live SSE | dashboard reflects a live bot within 1s of events |
| 7 | IMPL-4 | Hardening: pm2, boot-resume, quota persistence, smoke tests, docs | survives reboot; 24h unattended run clean |

Sequential; each IMPL file has detailed tasks + acceptance checks. wsskill parallelization
is possible *within* a phase (file lists are disjoint where noted) — not across phases.

---

## 15. Conventions

- TypeScript strict everywhere; zod at every boundary (API in, LLM out, settings).
- Imports `@wick/shared` for shared types; no cross-imports between server modules except via event bus and db.
- SQL: prepared statements only, WAL mode, one write connection.
- Logs: pino; per-bot child logger `{bot: id}`. Never log keys or full prompts at info level (debug only).
- Commits per phase-wave, no AI attribution lines.
- No new dependencies without a line in STATUS.md saying why.

## 16. Pitfalls (carried over + new)

1. **Node 24 breaks better-sqlite3** — use Node 22 portable (`D:/Claude/Tools/node-v22`).
2. `fastify-sse-v2` is the community package name (not `@fastify/sse-v2`).
3. Binance WS drops silently — existing reconnect logic in `binance-ws.ts`; keep its heartbeat.
4. Free-tier model IDs rot fast. Registry is data, not code; verify at setup; handle "model not found" like a 429 (fall through).
5. Gemini's native API shape differs from OpenAI's — isolate in its adapter, don't leak into router logic.
6. LLMs sometimes return prose around JSON — extract-first-JSON-object fallback before the repair retry.
7. Free endpoints can be slow (>10s). 20s timeout, and the bot queue must not block other bots (per-bot serialization, global concurrency ok).
8. SQLite busy under WAL when evaluator cron + fills collide — single write connection, short transactions.
9. Don't let the trigger engine wake bots during the first minutes after boot before candles backfill — gate on "market data warm" flag.
10. Windows: pm2 needs the Node 22 path inside `ecosystem.config.cjs` env, not just the shell PATH.
