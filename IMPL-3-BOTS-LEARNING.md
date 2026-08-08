# IMPL-3 — Phase 4 (Bots + Trigger Engine) + Phase 5 (Learning & Memory)

> Read `PLAN.md` fully first. Requires Phases 0–3 complete.

---

## Phase 4 — Bots + Trigger Engine

**Objective:** the full living loop: bots exist as configurable entities, wake on schedule
and on market events, decide via the router, trade via the paper engine, and survive restarts.
After this phase Wick *works*; it just doesn't learn yet.

### Tasks

**4.1 Bot lifecycle.** `bots/bot-store.ts` + API:
- CRUD `POST/GET/PATCH /api/bots`, actions `POST /api/bots/:id/start|stop|reset`.
- Create: name, bankroll, config (defaults from PLAN §8/§10; personality free-text; symbols
  default = full watchlist; cadence default 1h; provider_order default = registry order).
- `reset`: increments a `run` counter kept in config, zeroes positions (paper-sells at mid,
  no fees), restores cash = bankroll_start; old decisions/fills keep their rows (queries
  filter by run where it matters — decisions store run id in snapshot_json meta).
- Busted check: after every fill + hourly — equity ≤ 0 or drawdown ≥ kill % → status
  `busted`, positions liquidated at mid, bus event `bot-status`.
- Seed: two default bots on first migrate, distinct personalities ("Patient trend-follower —
  strongly prefers waiting", "Contrarian dip-buyer — buys fear, sells greed") and different
  provider_order, so model-vs-model comparison starts on day one.

**4.2 Bot runner.** `bots/bot-runner.ts`:
- Per-bot FIFO wake queue, max depth 1 pending wake (a queued wake absorbs newer ones —
  latest trigger reason wins); global concurrency limit 3 LLM calls in flight.
- Wake execution = PLAN §8 steps 1–6 exactly: gates → snapshot → prompt → router → guards →
  execute/wait → decision row → SSE `decision` event.
- Snapshot builder `bots/snapshot.ts`: pure assembly from DB + live caches (candles summary,
  enabled indicators with weight/hit-rate — Phase 5 fills these, until then weight 1.0 /
  "n/a", position + uPnL, cash/equity/drawdown, fee drag 7d, last 5 decisions + outcomes if
  present, lessons_current or "", trigger reason, guard state).
- `llm_failed` → decision row with that status, no trade, no retry until next wake.

**4.3 Scheduler wakes.** On each closed candle of tf X (bus event from Phase 1), wake every
running bot with `cadence_tf === X` (trigger_type `scheduled`), staggered 0–30s random-ish
offset derived from bot id (avoid burst on shared quota; deterministic, no Math.random in
hot path needed — hash bot id).

**4.4 Trigger engine.** `market/trigger-engine.ts` implementing PLAN §9 exactly:
- Subscribes: `tick`, `candle`, `indicator`, `fill`. Gated on `marketWarm`.
- Maintains per-symbol rolling state (15m price window, ATR cache, vol average, last funding
  sign) and the volatility flag the paper engine reads for slippage ×2 (Phase 2 wiring point).
- Condition table from PLAN §9 with thresholds read from settings (seeded defaults; editable).
- On match: log `trigger_log` (fired=0/1), apply cooldowns (per type×symbol 15m, per-bot
  floor 10m) and budget gate (PLAN §9: P1 reserve 30%, P2 needs >50% pool or open-position
  symbol, P3 yields when pool empty; pool = `quota.poolRemaining()`), then wake matching bots
  (bots whose `symbols` include the trigger symbol; `position_event` wakes only the owner bot).
- SSE `trigger` event either way — the UI shows gated triggers dimmed (transparency for tuning).

**4.5 Boot resume.** On server start after `marketWarm`: reload bots; `running` bots resume
scheduling; protector re-armed (Phase 2); quota ledger already persistent; log a boot line
per bot ("resumed, equity $X, position Y").

### Acceptance (Phase 4 exit)
- [ ] Create bot via API with $1000 → next 1h close: decision row (any action) with full snapshot_json, provider, latency; SSE event seen.
- [ ] Guards observed live: force config max_trades_day=1, provoke 2 trade decisions → second is `vetoed` with reason.
- [ ] Trigger path: lower `rsi_cross` threshold to current value → trigger fires, `trigger_log` row, bot wakes with correct reason string in snapshot; cooldown blocks an immediate repeat (fired=0 row).
- [ ] Budget gate: set all rpd=3 in settings → P3 wakes stop when pool exhausted, P1 still passes (reserve math).
- [ ] Kill server with open position + running bot → restart → bot resumes, protector armed, no duplicate wakes, no lost state.
- [ ] Two seeded bots run 24h unattended: decisions logged from both, zero crashes, `llm_usage` totals within free limits.
- [ ] Commit: `Phase 4 — bots + trigger engine`.

### Pitfalls
- Wake absorption (4.2) matters: a volatile hour can fire 5 triggers — bot must decide once with the freshest reason, not 5 times.
- `position_event` triggers must not loop: opening a position immediately satisfies "P&L crossed 0" — arm position triggers only after price moves 0.5% from entry.
- Scheduled + trigger wake racing at candle close: per-bot queue serializes; absorption dedupes.
- Don't build the snapshot before passing gates (wasted DB work on gated wakes).

---

## Phase 5 — Learning & Memory

**Objective:** decisions get judged, indicators earn or lose trust, bots accumulate lessons —
all three memories feeding back into the next prompt. Slow and guarded per PLAN §11.

### Tasks

**5.1 Evaluator.** `learn/evaluator.ts`, cron */15min:
- Select decisions (status `executed`, and `wait`/`vetoed` too — vetoed scores as wait) older
  than each horizon without an outcome row. Forward return from `candles` (1h tf): price at
  decision ts → price at ts+horizon (nearest candle close; skip if candle gap, self-heal
  catches up later).
- Score exactly per PLAN §11 formulas (buy / sell / wait). Symbol-less waits score vs BTC.
- Write `outcomes`; on 4h horizon completion publish `outcome` bus event (feeds 5.2, 5.3, SSE).

**5.2 Indicator stats.** `learn/indicator-stats.ts`, consumes 4h `outcome` events:
- From the decision's snapshot_json: every enabled indicator's vote → hit/miss vs
  sign(fwd_ret_4h) beyond ±0.3%; neutral votes skipped. Upsert `indicator_stats` (bot-scoped).
- Daily cron: recompute weights per PLAN §11 rule (only samples ≥ 30; multiplicative ×(1 +
  0.1×(hitrate−0.5)); clamp [0.25, 2.0]); auto-disable at samples ≥ 100 ∧ hitrate < 0.45;
  4-weekly re-trial window (disabled indicators keep recording votes via snapshot — they're
  in snapshot_json but marked `shadow: true` and excluded from the prompt).
- Laplace smoothing: hitrate = (hits+1)/(samples+2).
- `GET /api/bots/:id/stats` returns the table (indicator, samples, hitrate, weight, enabled).

**5.3 Journal + lessons.** `learn/journal.ts`:
- On each 4h outcome for an executed trade decision: code-template reflection line →
  `journal` (kind `reflection`). Template includes action, symbol, trigger, confidence,
  fwd_ret, which votes were right/wrong. No LLM.
- Daily cron (per running bot, staggered): one LLM call via the router (provider order same
  as bot) — input: last 7 days reflections + current stats table + previous lessons; output:
  ≤10 bullet lessons (plain text, ≤1000 chars). Write `journal` (kind `lesson`) + replace
  `lessons_current`. On `llm_failed`: keep previous lessons, retry next day (never blocks).
- Budget note: this is ≤ N_bots calls/day — negligible vs pool.

**5.4 Close the loop.** Snapshot builder (4.2) now reads real weights/hit-rates and
`lessons_current`; prompt shows per-indicator annotation `RSI(14): 34 [bull] — your hit-rate
58% (w 1.2, n 47)`; disabled indicators absent. Last-5-decisions block now includes their
scores. Verify prompt stays < 2.5k tokens with full learning data (golden test updated).

**5.5 Learning APIs.** `GET /api/bots/:id/journal?kind=`, `GET /api/bots/:id/outcomes`
(joined decisions+outcomes for the UI decision log), `GET /api/stats/models` — aggregate W/L
and mean score per provider/model across bots (the model-vs-model scoreboard).

### Acceptance (Phase 5 exit)
- [ ] Backdate a synthetic decision 5h → evaluator run produces 1h+4h outcomes with correct signed scores for all three action types (unit-test the formulas with fixed candles).
- [ ] `wait` scoring: flat market wait → +0.3; wait through a +2% move → −0.3 (fixture-tested).
- [ ] indicator_stats accumulate live; weights unchanged while samples < 30 (assert after seeding 29 outcomes); weight moves on the 30th.
- [ ] Auto-disable fires on a seeded 100-sample 40% indicator; it disappears from next prompt; shadow votes still recorded.
- [ ] Daily lesson call produces ≤10 bullets in `lessons_current`; next decision's snapshot_json contains them.
- [ ] `GET /api/stats/models` shows both seeded bots' providers with score aggregates.
- [ ] Commit: `Phase 5 — learning loop`.

### Pitfalls
- Never evaluate with look-ahead: forward price must come from candles *after* decision ts (off-by-one on candle close boundaries — decision at 14:00:00 close uses 15:00 close for 1h horizon, not 14:00).
- Vetoed decisions score as wait but must be distinguishable in stats queries (status column preserved).
- Small-sample noise is the enemy (Luka's explicit concern): the 30/100 floors and 0.1 alpha are locked — do not "tune" them downward to see movement sooner.
- Lesson compression must replace, not append — lessons_current is a bounded artifact.
- The reflection template must name votes exactly as indicator names in stats (1:1 join key).
