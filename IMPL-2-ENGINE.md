# IMPL-2 — Phase 2 (Paper Trading Engine) + Phase 3 (LLM Provider Layer)

> Read `PLAN.md` fully first. Requires Phases 0–1 complete.

---

## Phase 2 — Paper Trading Engine

**Objective:** bot-scoped fake-money trading against live prices: fills with fees+slippage,
positions, equity accounting, and a tick-driven SL/TP protector. No LLM involved yet —
everything testable via a dev CLI.

### Tasks

**2.1 Paper engine.** Rework `execution/paper-mode.ts` → `paper/engine.ts`, bot-scoped:
- `buy(botId, symbol, notionalUsd, {slPct, tpPct})`: price = live mid × (1 + slip); slip =
  0.05% base, ×2 while a `price_velocity` trigger window is open for that symbol (engine
  reads a volatility flag the trigger engine maintains — Phase 4 wires it; until then base).
  Fee = 0.1% of notional. Writes `fills`, upserts `positions` (avg-entry math for adds),
  decrements `bots.cash`. Computes and stores absolute `stop_price`/`tp_price` from pcts.
- `sell(botId, symbol, pctOfPosition)`: mirror; realized P&L implicit in cash; position row
  deleted at qty≈0 (dust threshold $0.50).
- Rejections (not exceptions): insufficient cash, no position, below $10 min notional —
  returned as typed results for the caller to log.
- `equity(botId)` = cash + Σ(qty × live mid). Hourly cron writes `equity_snapshots`; also
  maintains high-water mark for drawdown (store hwm in `bots.config_json` runtime section or
  derive from snapshots — derive, don't duplicate).

**2.2 Protector.** New `paper/protector.ts`: subscribes to bus ticks; in-memory index of all
open positions' stop/tp prices (rebuilt from DB on boot); on breach → immediate
`sell(100%)` with fill reason `sl`/`tp`, publishes `fill` event, logs a synthetic decision row
(`action: 'sell'`, `trigger_type: 'protector'`, provider `code`) so the audit trail stays complete.
Latency target: same tick, no polling.

**2.3 Risk guards.** Rework `execution/risk-guards.ts` → `paper/risk-guards.ts` as a pure
function `checkAndClamp(bot, decision, state) → {verdict: 'pass'|'veto', clamped, reason}`
implementing PLAN §10 exactly (min confidence, cooldown, min-hold, max trades/day, max
position %, SL/TP clamps, notional bounds). No I/O inside — state (last fill ts, trades
today, position) is passed in. Unit-testable.

**2.4 Dev CLI.** `scripts/paper.ts` (`pnpm paper buy BTCUSDT 100 --sl 5 --tp 10`, `pnpm paper
status <bot>`): drives engine against a seeded test bot. This is the Phase 2 test harness.

**2.5 API.** `GET /api/bots/:id/positions|fills|equity` (read-only; bot CRUD itself is Phase 4).

### Acceptance (Phase 2 exit)
- [ ] CLI: seed test bot $1000 → buy $100 BTC → `positions` row with correct stop/tp prices; cash = 1000 − 100 − 0.10 − slip.
- [ ] Set tight SL (0.1%) → protector fires on a real tick within seconds; fill logged with reason `sl`; position gone; synthetic decision row exists.
- [ ] Guards unit tests: each PLAN §10 rule has a passing veto/clamp case (vitest or plain tsx asserts — add `vitest` only if trivial, else script asserts; note choice in STATUS).
- [ ] Equity math: buy → price moves → `equity()` tracks live; hourly snapshot rows appear.
- [ ] Restart server mid-position → protector re-arms from DB (kill server, breach SL, restart → fires on first ticks).
- [ ] Commit: `Phase 2 — paper engine + protector`.

### Pitfalls
- Avg-entry on partial adds; fee applied on both sides; don't double-count slip into P&L display.
- Protector must ignore symbols with no live tick yet (boot gap) — it re-arms only after `marketWarm`.
- Float dust: qty compare with epsilon, notional min $10 pre-fee.

---

## Phase 3 — LLM Provider Layer

**Objective:** one call site — `llm/router.decide(botCtx, snapshot) → Decision` — that
rotates across free providers, enforces quotas, validates output, and never throws into the
bot loop. Testable standalone via CLI before any bot exists.

### Tasks

**3.1 Registry.** `llm/providers.ts`: provider records per PLAN §7 (id, baseUrl, authStyle,
adapter, models[], rpm, rpd, enabled). Defaults seeded into `settings` at migrate; runtime
values always read from settings (UI-editable later). Keys live in the existing vault under
`llm.openrouter.key` etc.

**3.2 Adapters.** `llm/adapters/openai-compat.ts` (OpenRouter, Groq, Mistral, Cerebras,
Ollama — base URL + auth header differ, request shape identical; `response_format:
json_object` where supported) and `llm/adapters/gemini.ts` (native `generateContent`,
`responseMimeType: application/json`). Both: 20s timeout via undici, return
`{ok, text, status}` — no throwing.

**3.3 Quota ledger.** `llm/quota.ts`: per-provider daily counter backed by `llm_usage`
(UTC date rollover), plus in-memory rpm token bucket. `hasHeadroom(provider)`,
`record(provider, ok)`. Pooled remaining: `poolRemaining()` = Σ over enabled providers
(rpd − used) — the trigger engine's budget gate (Phase 4) reads this.

**3.4 Router.** `llm/router.ts`:
1. Iterate bot's `provider_order` ∩ enabled, skip no-headroom.
2. Call adapter with system+user messages. On 429/5xx/timeout → record error, next provider.
3. Parse: strict `JSON.parse` → fallback extract-first-`{…}` → one repair retry ("Reply with
   only the corrected JSON") on the same provider → next provider.
4. Zod-validate against the Decision contract (PLAN §7). Coerce obvious sins (confidence
   "82%" → 82; uppercase action). Validation failure counts as malformed (step 3 path).
5. Return `{decision, provider, model, latencyMs}` or `{failed: true}` — the caller records
   `llm_failed` and treats it as wait. **Never throw.**

**3.5 Prompt builder.** `llm/prompt.ts`: pure function (botConfig, snapshot) → {system, user}.
System: role, personality line from config, hard rules verbatim (wait is default; trade only
at confidence ≥ N; fees 0.1%/side + slippage; you are judged on being right, not busy;
JSON-only output with the exact schema). User: the snapshot per PLAN §8 step 2. Deterministic
ordering, compact — target < 2.5k tokens; truncate candle history first if over.
Unit test: golden-file the rendered prompt for a fixed snapshot (catches accidental bloat).

**3.6 Setup + CLI.**
- `scripts/ask.ts` (`pnpm ask --symbol BTCUSDT [--provider groq] [--dry]`): builds a real
  snapshot from live Phase-1 data with default weights, prints rendered prompt (--dry) or
  routed decision + provider + latency.
- Registering keys: document in STATUS the signup URLs (openrouter.ai/keys, console.groq.com,
  aistudio.google.com/apikey, console.mistral.ai, cloud.cerebras.ai) — Luka registers, pastes
  into Settings page later; until then `pnpm keys set llm.groq.key <value>` helper writes to vault.
- Verify current free-model IDs at setup time and update registry settings (PLAN §16.4).

### Acceptance (Phase 3 exit)
- [ ] `pnpm ask --symbol BTCUSDT` returns a schema-valid decision from the first available provider; row in `llm_usage` incremented.
- [ ] Force rotation: set groq rpd=0 in settings → call skips to next provider; forced bad key → 401 recorded as error, falls through, no throw.
- [ ] Malformed-JSON path: adapter stub test returning prose → extraction/repair/fail-over behaves per 3.4.
- [ ] `pnpm ask --dry` prompt < 2.5k tokens for full snapshot; golden test green.
- [ ] All-providers-down (all disabled) → clean `{failed: true}`, no exception.
- [ ] Commit: `Phase 3 — LLM router + provider rotation`.

### Pitfalls
- OpenRouter free models need `HTTP-Referer`/`X-Title` headers or some models reject — set both.
- Groq/Cerebras `json_object` support varies by model — treat as hint, keep the extractor.
- Gemini free tier rejects `system` role on some models — adapter folds system into first user turn when needed.
- Quota rollover is UTC — one clock, matches the rest of the app.
- Never log prompts at info level (they contain the bot's full state); debug only.
