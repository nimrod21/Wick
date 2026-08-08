# Wick

**LLM paper-trading bots that run continuously on live crypto data, log every
decision, get judged in hindsight, and slowly learn which signals to trust.**

Bots wake on candle closes and market events, look at a snapshot of indicators
they have earned trust in, ask a free-tier LLM what to do, and are then held to
hard-coded risk guards before anything is "traded". Every buy, sell and **wait**
is stored with its inputs, its reasoning, the provider that answered, and — a
few hours later — a score for whether it was right. The dashboard exists to
watch the bots, not the other way around.

> **Paper only, $0 by design.** No exchange keys, no orders, no money. Market
> data is keyless public Binance; every LLM provider is used on its free tier
> behind a quota ledger that refuses to exceed it. If Wick ever needs a credit
> card, something is wrong.

Planning docs: [PLAN.md](PLAN.md) (source of truth) · `IMPL-1..4-*.md` (phase
detail) · [STATUS.md](STATUS.md) (what is built and verified).

---

## Architecture

```
apps/server  Fastify, 127.0.0.1:3001                       apps/web  Next.js, 127.0.0.1:3000
┌──────────────────────────────────────────────┐           ┌───────────────────────────────┐
│ collectors/  binance-ws · binance-rest        │           │ /            bot cards,       │
│              fear-greed · funding-oi          │           │              market strip,    │
│                    │ ticks, candles           │           │              live feed        │
│ market/      indicator-engine ─┐              │           │ /bots/[id]   charts, decision │
│              trigger-engine ───┤ wake         │  SSE      │              log, stats,      │
│ bots/        scheduler ────────┤ (P1/P2/P3)   │ ────────► │              journal          │
│              bot-runner ◄──────┘              │           │ /market      per-symbol TA    │
│                    │ snapshot + prompt        │           │ /settings    keys, quota,     │
│ llm/         router → provider rotation       │           │              watchlist,guards │
│                    │ zod-validated decision   │           └───────────────────────────────┘
│ paper/       risk-guards → engine (fees+slip) │
│              protector (SL/TP on live ticks)  │      all state in one SQLite file (WAL):
│ learn/       evaluator → indicator-stats      │      apps/server/data/wick.db
│              journal → lessons_current        │
│ jobs/        scheduler · hygiene (prune,      │
│              backup ×3, weekly VACUUM)        │
└──────────────────────────────────────────────┘
```

Three rules the code enforces, not the prompt:

1. **Exits never wait for an LLM.** `paper/protector.ts` watches live ticks
   against each position's stop/take-profit and fills immediately.
2. **Anti-microtrading is code.** Min confidence, cooldown, min hold, max
   trades/day, max position size, drawdown kill — `paper/risk-guards.ts` vetoes
   or clamps, and the veto is logged.
3. **`wait` is a real decision.** It is scored like any trade, and waiting
   correctly earns points.

---

## Running it

**Node 22 is required** — `better-sqlite3` has no working prebuild on Node 24.
A portable copy lives at `D:/Claude/Tools/node-v22`; put it first on PATH:

```bash
export PATH="/d/Claude/Tools/node-v22:$PATH"   # Git Bash
$env:PATH = "D:\Claude\Tools\node-v22;$env:PATH"   # PowerShell
```

```bash
pnpm install
pnpm migrate        # creates apps/server/data/wick.db + seeds watchlist, settings, 2 bots
pnpm dev            # server :3001 + web :3000, hot reload
```

Open http://127.0.0.1:3000. The first boot backfills candles for the seven
watchlist symbols; bots stay gated until `marketWarm` (usually < 60s).

Useful scripts:

| Command | What it does |
|---|---|
| `pnpm build` | shared package + server `dist/` + `next build` |
| `pnpm smoke` | boots a real server, drives one stub-provider wake end to end, asserts fill + decision + SSE, tears down |
| `pnpm doctor` | one-screen health report: versions, builds, WS, quota per provider, DB stats, backups |
| `pnpm ask --symbol BTCUSDT [--dry]` | render a real prompt / get one routed decision from the CLI |
| `pnpm keys list` | masked view of the encrypted key vault |
| `pnpm test:guards / test:llm / test:bots / test:learn` | phase test suites |

`GET http://127.0.0.1:3001/health` returns the same report `pnpm doctor`
prints: WS connected, `marketWarm`, per-provider headroom, bots running, last
evaluator run.

### Run it as a service (pm2)

```bash
pnpm pm2:start     # builds, then starts wick-server (dist) + wick-web (next start)
pnpm pm2:status
pnpm pm2:logs
pnpm pm2:stop      # or pnpm pm2:delete
```

`ecosystem.config.cjs` pins the Node 22 interpreter and PATH — pm2 on Windows
does not inherit the shell's. Both apps run built output; never serve dev mode
as a service.

One-time extras Luka runs by hand:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 5
pm2 save && pm2-startup install     # boot autostart (plain `pm2 startup` is Unix-only)
```

---

## Provider keys

Wick ships with no keys and works without any (bots just record `llm_failed`
and wait). Full instructions — signup URLs, storing keys, verifying model IDs —
are in [`apps/server/src/llm/README-setup.md`](apps/server/src/llm/README-setup.md).
The short version:

```bash
pnpm keys set llm.groq.key gsk_...      # AES-GCM into the settings vault
pnpm keys list
```

or paste them into **Settings → Providers** in the UI (same vault, masked, with
a per-provider "test" button and live usage bars). The vault is encrypted with
`WICK_MASTER_KEY`, generated into `.env` on first boot — back that file up, it
is the only thing that can decrypt your keys.

Free-tier model IDs rot. `providers.registry` in the `settings` table (editable
from the UI) holds each provider's base URL, model, `rpm` and `rpd`; a retired
model is treated like a 429 and the router falls through to the next provider.

---

## Data & durability

Everything lives in `apps/server/data/wick.db` (SQLite, WAL). The decision
history *is* the product, so:

- nightly 03:20 — prune 1m candles > 14 days and `trigger_log` > 30 days, then
  write a rotated backup into `data/backups/` (3 kept)
- weekly Sun 03:40 — `VACUUM`, skipped if a fill landed in the last minute
- decisions, fills, outcomes and journal rows are never pruned

Wick is crash-only: kill it at any moment and restart. Fills are single
transactions, an interrupted LLM call leaves no decision behind, a decision
written without its fill is repaired to `vetoed / crash_no_fill` on boot, the
protector re-arms from the `positions` table, and the evaluator re-picks
anything it had not scored yet.
