# IMPL Part 1 — Foundation (Phases 0 + 1)

> **Prerequisite:** Read [PLAN.md](PLAN.md) first — all shared context (locked decisions, tech stack, repo layout, schema, APIs, conventions, pitfalls, design) lives there. This file contains **only** the implementation tasks and exit criteria for Phases 0 and 1.

**Covers:**
- **Phase 0** — Preflight + Spike (~1 week)
- **Phase 1** — Backbone (~1 week)

**At the end of this part you will have:**
- A notebook of verified behavior for every data source we plan to use.
- An empty but fully-wired monorepo skeleton.
- Next.js frontend with all tab routes rendering in the pixel 80s theme.
- Fastify backend with SQLite migrated, SSE stream live, settings API working.
- PM2 configured for always-on operation.
- `STATUS.md` live-tracking progress.

**Handoff to Part 2:** section at the end of this file lists the state Phase 2 assumes.

---

## Ground rules for this part

- **Do NOT start Phase 2 work in this part.** Phase 2 pulls in Binance WebSocket and trading UI; resist the urge to "just get the chart working" while in Phase 1. Each part has a clean exit.
- **Commit at every exit criterion.** Don't batch commits.
- **Update `STATUS.md` after every commit.**
- If a Tier 1 API key is missing during Phase 0 probes, mark the probe `BLOCKED` in `NOTES.md` and continue with the rest. Don't stall waiting for keys.

---

## Phase 0 — Preflight + Spike

### Goal

Verify environment. Prove every data source works **in isolation** before architecture. Record observed behavior so later design decisions are grounded in reality, not docs.

### 0.1 — Run the preflight checklist

Go through [PLAN.md §16](PLAN.md#16-pre-flight-checklist) top to bottom. Most items are already verified; you're re-confirming on the current machine.

```bash
# From D:/Claude/trading-cockpit/
node --version            # expect >= v22
pnpm --version            # install if missing: npm i -g pnpm
git --version
python --version
```

If `pnpm` is missing:
```bash
npm i -g pnpm
```

### 0.2 — Initialize minimum repo scaffolding (just enough to hold probe scripts)

```bash
cd D:/Claude/trading-cockpit
git init
```

Create these files at the repo root:

**`.gitignore`**
```
node_modules/
dist/
.next/
.turbo/
apps/*/data/
apps/*/dist/
*.log
.env
.env.local
logs/
.DS_Store
*.tsbuildinfo
```

**`.env.example`** — copy from [PLAN.md §9](PLAN.md#9-apis--keys).

**`.env`** — start empty; keys added as user provides them.

**`package.json`** (root)
```json
{
  "name": "trading-cockpit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "probe": "tsx scripts/probe/run.ts"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0"
  }
}
```

**`tsconfig.base.json`**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

**`tsconfig.json`** (root, for probe scripts)
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./scripts"
  },
  "include": ["scripts/**/*.ts"]
}
```

Install:
```bash
pnpm install
```

### 0.3 — Write one probe per data source

Folder: `scripts/probe/`. Each probe is a standalone TS file runnable via `pnpm tsx scripts/probe/<name>.ts`. Each **prints what it fetched** and **how long it took**. Each probe logs results to `scripts/probe/NOTES.md`.

**Template (`scripts/probe/_template.ts`):**
```ts
const started = performance.now();
async function main() {
  // fetch / ws / rss / rpc ...
}
main()
  .then(() => console.log(`[OK] ${import.meta.url}  elapsed=${Math.round(performance.now()-started)}ms`))
  .catch(e => { console.error(`[FAIL] ${e?.message || e}`); process.exit(1); });
```

**Probe list (create all; Tier 0 first, Tier 1 as keys arrive):**

| File | What it does | Key needed |
|---|---|---|
| `probe-binance-ws.ts` | Connect `wss://stream.binance.com/ws/btcusdt@kline_1m`, log 10 ticks, disconnect. | No |
| `probe-binance-rest.ts` | `GET /api/v3/klines?symbol=BTCUSDT&interval=1m&limit=100`. Log bounds, latency. | No |
| `probe-yahoo.ts` | Via `yahoo-finance2`, fetch `^VIX`, `DX-Y.NYB`, `AAPL`. Log payload shape. | No |
| `probe-rss.ts` | Parse 3 feeds (CoinDesk, Reuters markets, Bloomberg markets). Log item counts + dedupe. | No |
| `probe-fng.ts` | `GET https://api.alternative.me/fng/?limit=10`. Log values + timestamps. | No |
| `probe-blockstream.ts` | `GET https://blockstream.info/api/address/<known-btc-whale>/txs`. Log recent tx count. | No |
| `probe-coingecko.ts` | `GET /api/v3/global` — BTC dominance; and `/simple/price` for sanity. | No |
| `probe-twelvedata.ts` | `/time_series?symbol=XAU/USD&interval=1min`, then `WTI/USD`, then `AAPL`. | Yes |
| `probe-finnhub.ts` | `/company-news?symbol=AAPL&from=...&to=...`. | Yes |
| `probe-etherscan.ts` | `module=account&action=txlist&address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` (vitalik.eth). | Yes |
| `probe-helius.ts` | Query SOL address txs via Helius enhanced-transactions endpoint. | Yes |
| `probe-cryptopanic.ts` | `/api/v1/posts/?auth_token=...&public=true`. | Yes |
| `probe-fred.ts` | `/fred/series/observations?series_id=CPIAUCSL`. | Yes |
| `probe-alpaca.ts` | Authenticate against `https://paper-api.alpaca.markets/v2/account`. | Yes |

### 0.4 — Record findings

`scripts/probe/NOTES.md` (append an entry per probe):

```md
## probe-binance-ws
- Status: OK
- Latency: ~150ms to first tick
- Observations: sends JSON frames; kline `k.x` is true when candle is closed
- Quirks: server pings every 3 min; reconnect if no traffic for 10 min

## probe-twelvedata
- Status: BLOCKED (no key yet)
- Expected: XAU/USD spot, 1m candles
- Free tier: 800/day, 8/min — confirmed from dashboard
...
```

These notes feed Phase 1 onward. Don't skip them.

### 0.5 — Exit criteria (Phase 0)

- [ ] All Tier 0 probes run and print expected data.
- [ ] Every Tier 1 probe either passes or is marked `BLOCKED` in NOTES.md with reason.
- [ ] `scripts/probe/NOTES.md` has one entry per probe.
- [ ] Git repo initialized, `.gitignore`, `.env.example`, root `package.json` committed.
- [ ] Commit message: `Phase 0: preflight + spike complete`.

---

## Phase 1 — Backbone

### Goal

Empty but functional shell: monorepo, SQLite migrated, event bus, SSE endpoint, all frontend tab routes rendering in pixel 80s theme, PM2 configured.

No real collectors. No real charts. Just the **scaffolding** so Phase 2 slots into a ready home.

### 1.1 — Monorepo initialization

**`pnpm-workspace.yaml`:**
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

**Root `package.json`** — replace with:
```json
{
  "name": "trading-cockpit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev":          "pnpm -r --parallel dev",
    "dev:server":   "pnpm --filter @cockpit/server dev",
    "dev:web":      "pnpm --filter @cockpit/web dev",
    "build":        "pnpm -r build",
    "typecheck":    "pnpm -r typecheck",
    "migrate":      "pnpm --filter @cockpit/server migrate",
    "pm2:start":    "pm2 start ecosystem.config.cjs",
    "pm2:stop":     "pm2 stop cockpit-server",
    "pm2:logs":     "pm2 logs cockpit-server",
    "pm2:status":   "pm2 status",
    "probe":        "tsx scripts/probe/run.ts"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0"
  }
}
```

### 1.2 — `packages/shared`

Create package with exported types per [PLAN.md §11](PLAN.md#11-real-time-pipeline) (Event types), [§13](PLAN.md#13-execution-module-design) (Order, Position), [§14](PLAN.md#14-alert-system-design) (AlertCondition).

```
packages/shared/
├── package.json         # name: "@cockpit/shared", "type": "module"
├── tsconfig.json        # extends ../../tsconfig.base.json; outDir "dist"
└── src/
    ├── index.ts         # re-exports all
    ├── events.ts        # Event types
    ├── assets.ts        # AssetId, AssetType, Timeframe
    ├── probability.ts   # Signal, ProbabilityScore
    ├── orders.ts        # Order, Position, PlaceOrderRequest
    └── alerts.ts        # AlertCondition, AlertRule
```

### 1.3 — `apps/server` — Fastify + SQLite + event bus

Dependencies to install in `apps/server`:
```bash
pnpm add fastify @fastify/cors @fastify/sse-v2 better-sqlite3 pino pino-pretty zod dotenv bottleneck node-cron undici
pnpm add -D typescript tsx @types/node @types/better-sqlite3 @types/node-cron
```

**Directory tree** (matches [PLAN.md §7](PLAN.md#7-repo-skeleton)). Create empty files for collectors/execution/jobs — they're stubbed in Phase 1, filled in later parts.

**Key files to implement in Phase 1:**

- **`src/config.ts`** — loads `.env` via dotenv, validates with Zod, exposes typed config object.
- **`src/util/logger.ts`** — Pino instance; `pino-pretty` when `NODE_ENV !== 'production'`.
- **`src/util/crypto-vault.ts`** — AES-256-GCM encrypt/decrypt helpers. Derives key from `COCKPIT_MASTER_KEY`. If missing at startup: generate random 32 bytes, append to `.env`, log once.
- **`src/util/rate-limiter.ts`** — factory over Bottleneck; one registry so every outbound service has exactly one shared limiter.
- **`src/util/time.ts`** — `nowSec()`, `toSec(date)`, `fromSec(s)`.
- **`src/db/client.ts`** — better-sqlite3 singleton at `apps/server/data/cockpit.db`. `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`.
- **`src/db/migrations/001_initial.sql`** — full schema from [PLAN.md §8](PLAN.md#8-data-model).
- **`src/db/migrate.ts`** — runs pending migrations in a transaction. Records in `migrations_applied` table. CLI entry: `pnpm migrate`.
- **`src/core/event-bus.ts`** — strongly-typed EventEmitter wrapper. API: `bus.emit<'whale_tx'>(event)`, `bus.on(kind, cb)`, `bus.onAny(cb)`.
- **`src/api/server.ts`** — Fastify instance. CORS allows `http://127.0.0.1:3000` only. Registers routes.
- **`src/api/sse.ts`** — `GET /stream?topics=...&assetIds=...`. Keeps subscriber map. On bus event, filters + pushes. Heartbeat every 15s.
- **`src/api/settings.ts`** — REST CRUD for API keys (`GET /api/settings/keys`, `PUT /api/settings/keys/:service` stores encrypted, `POST /api/settings/keys/:service/test` returns mock-ok in Phase 1). Masked reads.
- **`src/api/assets.ts`** — REST CRUD for watchlists. `GET /api/assets?type=crypto`, `POST /api/assets`, `DELETE /api/assets/:id`.
- **`src/index.ts`** — entry: load config, run migrations, load seeds, start Fastify, emit a heartbeat event every 10s (for Phase 1 SSE verification).

**Seed loader behavior:** on boot, if `assets` table is empty, load from `src/seed/crypto_watchlist.json`, `stock_watchlist.json`, `commodity_watchlist.json`. Do not overwrite if rows exist.

**Seed file contents** — create with the data from [PLAN.md §3](PLAN.md#3-user--watchlists).

Example `crypto_watchlist.json`:
```json
[
  { "symbol": "BTCUSDT", "display_name": "Bitcoin",   "type": "crypto", "exchange": "binance", "tradeable_via": "ccxt" },
  { "symbol": "ETHUSDT", "display_name": "Ethereum",  "type": "crypto", "exchange": "binance", "tradeable_via": "ccxt" },
  { "symbol": "SOLUSDT", "display_name": "Solana",    "type": "crypto", "exchange": "binance", "tradeable_via": "ccxt" },
  { "symbol": "BNBUSDT", "display_name": "BNB",       "type": "crypto", "exchange": "binance", "tradeable_via": "ccxt" },
  { "symbol": "XRPUSDT", "display_name": "XRP",       "type": "crypto", "exchange": "binance", "tradeable_via": "ccxt" },
  { "symbol": "ADAUSDT", "display_name": "Cardano",   "type": "crypto", "exchange": "binance", "tradeable_via": "ccxt" },
  { "symbol": "LTCUSDT", "display_name": "Litecoin",  "type": "crypto", "exchange": "binance", "tradeable_via": "ccxt" }
]
```

Stock + commodity seeds follow the same shape. Commodities include `tradeable_symbol` (`GLD`, `SLV`, `USO`) so the execution layer can map display→tradeable later.

### 1.4 — `apps/web` — Next.js 15 + pixel 80s shell

```bash
cd apps/web
# (from the apps/web package.json, use pnpm directly — do not use create-next-app
# because it initializes its own package lock; we're in a workspace)
pnpm add next react react-dom lightweight-charts zustand @tanstack/react-query
pnpm add -D typescript @types/react @types/react-dom @types/node tailwindcss postcss autoprefixer
```

Init Tailwind:
```bash
npx tailwindcss init -p
```

Install shadcn/ui:
```bash
pnpm dlx shadcn@latest init
# pick: default style, CSS variables yes, baseColor slate
```

**`app/layout.tsx`** — loads Google Fonts (Press Start 2P, VT323, Pixelify Sans), mounts `<Scanlines/>`, `<Navbar/>`, children. Dark by default — `<html class="dark">`.

**`app/globals.css`** — paste the CSS variables from [PLAN.md §4](PLAN.md#4-pixel-80s-design-direction). Set `--radius: 0px`. Define `.scanlines`, `.glow`, `.pixel-border` utility classes.

**Components to build now (minimal):**
- `components/shell/Scanlines.tsx` — fixed overlay pseudo-element.
- `components/shell/Navbar.tsx` — top nav with routes from [PLAN.md §10](PLAN.md#10-page--route-map); status dot; clock.
- `components/shell/StatusDot.tsx` — reads `/stream` connection state.
- `components/shell/LocalClock.tsx` — `VT323`, ticks each second.

**Pages to create (empty placeholders, rendering only a title):**
- `app/page.tsx` — "DASHBOARD" placeholder
- `app/trading/layout.tsx` — sub-tab shell (Crypto/Metals/Commodities/Stocks)
- `app/trading/crypto/page.tsx`, `metals/page.tsx`, `commodities/page.tsx`, `stocks/page.tsx`
- `app/whales/page.tsx`, `news/page.tsx`, `indicators/page.tsx`, `alerts/page.tsx`, `settings/page.tsx`

Each placeholder renders just `<h1 class="font-[PressStart2P] text-neon-cyan glow">WHALES</h1>` (or similar per tab) so you can visually confirm the theme is working.

**Libs:**
- `lib/api.ts` — typed fetch wrapper pointing to `http://127.0.0.1:3001`.
- `lib/sse.ts` — `useEventStream(topics, assetIds?)` hook: EventSource, reconnect backoff, filter by topic, dispatch to Zustand stores.
- `lib/store.ts` — Zustand stores stubbed (`priceStore`, `whaleStore`, `newsStore`, `indicatorStore`, `alertStore`).
- `lib/query.ts` — TanStack QueryClient, `<QueryClientProvider>` in layout.

**Settings page (real, functional in Phase 1):**
- List services from [PLAN.md §9](PLAN.md#9-apis--keys) service table with status (connected/missing).
- Paste key + secret inputs, save button.
- "Test connection" button (Phase 1 returns mock-ok; real tests added per-service in later phases).
- Signup link for each missing key.

### 1.5 — PM2 configuration

At repo root:

**`ecosystem.config.cjs`** — per [PLAN.md §17](PLAN.md#17-windows-service-pm2).

Add a tiny build step for the server:
```bash
cd apps/server
pnpm add -D typescript
# tsconfig.json with outDir "dist", rootDir "src"
```

Server `package.json`:
```json
{
  "name": "@cockpit/server",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev":       "tsx watch src/index.ts",
    "build":     "tsc",
    "start":     "node dist/index.js",
    "migrate":   "tsx src/db/migrate.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

Install PM2 globally (Phase 1 setup only — do not `pm2 start` yet; wait for exit criteria):
```bash
npm i -g pm2
npm i -g pm2-windows-startup
```

### 1.6 — `STATUS.md` creation

Create `STATUS.md` at repo root using the template from [PLAN.md §20](PLAN.md#20-progress-tracking). Mark Phase 0 complete, Phase 1 in progress.

### 1.7 — Exit criteria (Phase 1)

- [ ] `pnpm install` at root completes with no errors.
- [ ] `pnpm migrate` runs the initial migration; `cockpit.db` exists at `apps/server/data/cockpit.db`.
- [ ] `sqlite3 apps/server/data/cockpit.db ".tables"` shows every table from [PLAN.md §8](PLAN.md#8-data-model).
- [ ] `pnpm dev` starts both apps. Server logs "listening on 127.0.0.1:3001". Web dev server on port 3000.
- [ ] Opening `http://127.0.0.1:3000/` renders the Dashboard placeholder with the pixel 80s fonts, neon palette, scanlines overlay.
- [ ] Every route (`/trading/crypto`, `/trading/metals`, `/trading/commodities`, `/trading/stocks`, `/whales`, `/news`, `/indicators`, `/alerts`, `/settings`) renders without errors.
- [ ] Navbar status dot connects to `/stream` and shows "live" (blinking cyan). Server emits a heartbeat event every 10s; browser console logs it.
- [ ] `/settings` page lists every service from [PLAN.md §9](PLAN.md#9-apis--keys) with correct status (connected/missing).
- [ ] Pasting a test key into the Twelve Data row and clicking Save persists it encrypted in `api_keys`. Re-opening the page shows it as connected with masked value.
- [ ] Seed watchlists loaded: `GET /api/assets?type=crypto` returns the 7 crypto pairs.
- [ ] `pnpm build` produces `apps/server/dist/index.js`.
- [ ] `pm2 start ecosystem.config.cjs` detaches the server; `pm2 status` shows it online; `pm2 logs cockpit-server` tails output.
- [ ] Running `pm2 save` + reboot test: server comes back up on login (this is optional; skip if you don't want to reboot now, but verify the `pm2-startup install` step succeeded).
- [ ] Commit: `Phase 1: backbone`. Tag `v1.0`.
- [ ] `STATUS.md` updated.

### 1.8 — Common Phase 1 pitfalls

- **better-sqlite3 native build on Node 24.** If `pnpm install` fails compiling better-sqlite3, the fallback is Node 22 LTS via nvm-windows. Don't try to fix native build tooling — just downgrade.
- **Tailwind + Next 15 config.** App Router needs `content` globs that include `app/**` and `components/**`. Check `tailwind.config.ts` after `tailwindcss init`.
- **Google Fonts blocked.** If corp network blocks Google Fonts, self-host the three WOFF2 files in `public/fonts/` and reference them from CSS. Design still works offline.
- **SSE through dev proxy.** Don't proxy `/stream` through Next.js dev server — hit the backend directly at `127.0.0.1:3001` from the browser. Avoids buffer issues.
- **Pixel fonts too large.** Press Start 2P at 16px is oppressive. Keep it at 10–14px; use VT323 at 16–20px for most things.
- **Master key generation.** If `COCKPIT_MASTER_KEY` is missing, the server generates one and writes to `.env`. Verify this works on first run — otherwise encrypted keys can't be decrypted after restart.
- **Workspace deps.** After `pnpm add` in a sub-package, run `pnpm install` at root to link workspace packages like `@cockpit/shared`.

---

## Handoff to Part 2

When all Phase 1 exit criteria are green, open [IMPL-2-TRADING.md](IMPL-2-TRADING.md). Part 2 assumes:

- Backend running on `127.0.0.1:3001` with SQLite migrated, event bus live, SSE stream emitting heartbeats.
- Frontend running on `127.0.0.1:3000` with all tab routes rendering the pixel 80s theme.
- `packages/shared` exports Event types (including `PriceCandleEvent`) that Phase 2 will emit.
- Seed watchlists loaded: 7 crypto, 10 stocks, 3 commodity display + 3 tradeable proxies.
- Settings page functional for adding/testing API keys.
- PM2 available and `ecosystem.config.cjs` committed.
- `STATUS.md` reflects Phase 1 complete, Phase 2 next.

**Commit `STATUS.md` with Part 1 marked done** before moving on.

---

**End of Part 1.**
