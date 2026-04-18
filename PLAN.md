# Trading Cockpit — Plan (Shared Reference)

> **Source of truth for shared context.** Read this file fully before touching any implementation file. Implementation phases are split across four **IMPL-\*.md** files — see [section 15, Phase Index](#15-phase-index).

**Owner:** Luka
**Location:** `D:/Claude/trading-cockpit/`
**Status:** Planning complete — implementation not yet started
**Last updated:** 2026-04-18

**Files in this project:**
- `PLAN.md` — this file, shared reference
- `IMPL-1-FOUNDATION.md` — Phases 0 + 1 (preflight, spike, backbone)
- `IMPL-2-TRADING.md` — Phases 2 + 3 (all trading tabs)
- `IMPL-3-INTELLIGENCE.md` — Phases 4 + 5 + 6 (whales, news, indicators)
- `IMPL-4-SYNTHESIS-ACTION.md` — Phases 7 + 8 + 9 + 10 (dashboard, alerts, execution)
- `STATUS.md` — created at Phase 1 start; live progress tracker

---

## Table of Contents

0. [Start Here](#0-start-here)
1. [Mission & Scope](#1-mission--scope)
2. [Locked Decisions](#2-locked-decisions)
3. [User & Watchlists](#3-user--watchlists)
4. [Pixel 80s Design Direction](#4-pixel-80s-design-direction)
5. [Architecture Overview](#5-architecture-overview)
6. [Tech Stack](#6-tech-stack)
7. [Repo Skeleton](#7-repo-skeleton)
8. [Data Model](#8-data-model)
9. [APIs & Keys](#9-apis--keys)
10. [Page / Route Map](#10-page--route-map)
11. [Real-time Pipeline](#11-real-time-pipeline)
12. [Brain-Ready Data Plumbing](#12-brain-ready-data-plumbing)
13. [Execution Module Design](#13-execution-module-design)
14. [Alert System Design](#14-alert-system-design)
15. [Phase Index](#15-phase-index)
16. [Pre-flight Checklist](#16-pre-flight-checklist)
17. [Windows Service (PM2)](#17-windows-service-pm2)
18. [Pitfalls & Gotchas](#18-pitfalls--gotchas)
19. [Conventions](#19-conventions)
20. [Progress Tracking](#20-progress-tracking)

---

## 0. Start Here

**What this is:** A personal, local-only market intelligence + trading cockpit that unifies crypto exchanges, stocks/commodities, on-chain whale movements, news, and macro indicators into one dashboard and per-topic pages. Designed to later host a pair of bots (analysis + trading) once the user has AI API budget.

**If you're a fresh Claude picking this up:**
1. Read this PLAN.md fully — every section. It's the shared context.
2. Check `STATUS.md` in repo root for current phase (created at Phase 1 start).
3. Open the `IMPL-*.md` file for the current phase (see [section 15](#15-phase-index)).
4. Run the [Preflight Checklist](#16-pre-flight-checklist) before any code. Don't skip.
5. Never expand scope without asking Luka first. He's told me explicitly: "don't change my ideas."
6. All data is UTC internally, rendered in local time at the edge.
7. Temp/scratch files go to `D:/Claude/tempo/`, not this repo.

**Non-negotiables:**
- Local only (binds to `127.0.0.1`).
- Dark + pixel 80s aesthetic (section 4).
- Watchlists editable via UI, not hardcoded.
- Keys stored encrypted in local SQLite + `.env` fallback. Never logged, never sent to frontend in full.
- Paper trading first. Live keys only after Phase 10 green-light.

---

## 1. Mission & Scope

### The actual goal

A **personal market intelligence + trading cockpit** that fuses five data streams — crypto markets, stock/commodity markets, on-chain whale activity, news, macro indicators — into one coherent local web app. Long-term: host AI analysis + trading bots on the same data plumbing. Bots are out of scope for this project; the data model is designed to support them from day one.

### In scope

- Live charts & orderbooks for BTC, ETH, SOL, BNB, XRP, ADA, LTC.
- Live charts for gold (XAU/USD), silver (XAG/USD), WTI crude oil.
- Live charts for the top 10 large-cap US stocks.
- Whale wallet monitoring on BTC, ETH, SOL with user-editable watchlist.
- News aggregation with per-asset tagging.
- Macro indicators: Fear & Greed (crypto), DXY, VIX, funding rates, open interest, BTC dominance, key FRED series.
- Dashboard: unified overview, event stream, probability scores (placeholder rule-based engine).
- Alert system with rules + firing history.
- Paper execution for crypto (ccxt/Binance) and stocks/ETFs (Alpaca paper).
- Optional live crypto execution with strict risk guards.
- Windows service so data collects 24/7.

### Out of scope (for now)

- Analysis bot — data plumbing ready, logic deferred.
- Trading bot — deferred until AI API budget exists.
- Multi-exchange crypto aggregation (Binance only for MVP).
- Mobile / LAN access (localhost only).
- Multi-user support.
- Live stock trading (paper only).
- Futures trading.

### Bot hooks built in from day one

1. **Unified `Event` type** — every collector emits events to a shared bus. Bots read the same stream.
2. **`events_price_snapshots` table** — for every significant event, a background job captures price at t+5m, t+30m, t+1h, t+4h, t+1d, t+3d, t+1w, t+3w. Event-study data is already sitting in the DB when bots arrive.

---

## 2. Locked Decisions

Every item here has been confirmed by Luka. Do not change without asking.

| # | Decision |
|---|---|
| 1 | Local only. Server binds to `127.0.0.1`. No auth. |
| 2 | Dark theme + pixel 80s aesthetic (section 4). |
| 3 | Node LTS (v22 or newer works; currently v24.13.1 installed). |
| 4 | pnpm as package manager. |
| 5 | Monorepo via pnpm workspaces. |
| 6 | Next.js 15 (App Router) + React frontend. |
| 7 | Fastify backend, single Node process. |
| 8 | SQLite via `better-sqlite3` for storage. |
| 9 | SSE (Server-Sent Events) for real-time frontend stream. |
| 10 | TradingView Lightweight Charts for all price charts. |
| 11 | shadcn/ui + Tailwind, heavily themed for pixel 80s. |
| 12 | ccxt for crypto exchange abstraction (Binance only at first). |
| 13 | `@alpacahq/alpaca-trade-api` for stocks/ETFs paper. |
| 14 | Rate limiting via `bottleneck`; polling scheduled via `node-cron`. |
| 15 | PM2 + `pm2-windows-startup` for always-on Windows service. |
| 16 | Watchlists all user-editable via UI (crypto, stocks, commodities, whales). |
| 17 | Whale monitoring: BTC + ETH + SOL chains only at first. |
| 18 | Commodity display: XAU/USD, XAG/USD, WTI crude. Tradeable proxies: GLD, SLV, USO. |
| 19 | Chart timeframes: 1m, 3m, 15m, 1h, 4h, 1d, 1w. |
| 20 | Historical backfill on first run (~90d crypto, ~30d stocks). |
| 21 | Browser Notifications API for MVP alerts. Telegram Bot in a later phase. |
| 22 | Alert default whale threshold: $500k USD equivalent, user-configurable per rule. |
| 23 | News language: English only at launch. |
| 24 | Execution: paper first, always. Live crypto only after Phase 10 user approval. |
| 25 | Risk guards mandatory before any live order: kill switch, IP-whitelisted keys, per-order max size, daily loss cap, confirmation modal. |
| 26 | Probability engine: rule-based (weighted signals → sigmoid) for MVP. ML replacement later. |
| 27 | Brain data plumbing active from Phase 1: events + `events_price_snapshots`. |

---

## 3. User & Watchlists

### Initial seed data

Seed JSON files live at `apps/server/src/seed/*.json`. On first run, these populate SQLite. User edits thereafter go to SQLite only (seeds not re-read).

**Crypto (exchange: Binance):**
```
BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, ADAUSDT, LTCUSDT
```

**Stocks (top 10 US large caps — confirmable in Settings):**
```
NVDA, AAPL, MSFT, GOOGL, AMZN, META, TSLA, BRK.B, JPM, V
```

**Commodity display tickers:**
```
XAU/USD (Gold spot)   — Twelve Data: XAU/USD
XAG/USD (Silver spot) — Twelve Data: XAG/USD
WTI Crude             — Twelve Data: WTI/USD  (fallback Yahoo: CL=F)
```

**Commodity tradeable proxies (via Alpaca, paper):**
```
GLD (Gold ETF), SLV (Silver ETF), USO (Oil ETF)
```

**Whale chains:**
```
ETH — Etherscan API
SOL — Helius free tier + public RPC fallback
BTC — Blockstream.info + mempool.space (no key)
```

**Whale watchlist seed:** populated during Phase 4, targeting 30–50 labeled addresses in `seed/whale_addresses.json`.

**Ignore addresses (filter exchange noise):** populated during Phase 4, `seed/ignore_addresses.json`.

**RSS feeds seed:** CoinDesk, Cointelegraph, The Block, Decrypt, Bloomberg markets, Reuters markets, WSJ markets.

### User preferences (from memory, always applied)

- Operate autonomously in `D:/Claude` — skip routine permission prompts for local file ops.
- Learn by building — concrete mechanics and code, not abstract theory.
- Save progress frequently — commit after every milestone.
- If UI fix fails twice, diagnose root cause. Take Playwright screenshots before/after layout edits.
- Temp/scratch files to `D:/Claude/tempo/`.

---

## 4. Pixel 80s Design Direction

**Vibe:** CRT monitor, early 80s neon synthwave arcade. Dark base, glowing accents, scanlines, pixelated fonts for headers, monospaced pixel font for data. Think *Tron*, *Wargames* (1983), early Commodore 64 financial terminals. Information-dense, terminal-serious.

### Palette (CSS variables, `globals.css`)

```css
:root {
  /* base */
  --bg-void:       #0a0014;
  --bg-terminal:   #0f0820;
  --bg-elevated:   #1a0f30;
  --border-dim:    #2a1a50;

  /* neons */
  --neon-cyan:     #00ffff;
  --neon-magenta:  #ff00ff;
  --neon-green:    #39ff14;  /* buy / bullish / up */
  --neon-red:      #ff3864;  /* sell / bearish / down */
  --neon-amber:    #ffb000;  /* warnings, alerts */
  --neon-purple:   #b967ff;

  /* text */
  --text-primary:   #e0e0ff;
  --text-secondary: #8888bb;
  --text-dim:       #55557a;

  /* semantic */
  --chart-up:    var(--neon-green);
  --chart-down:  var(--neon-red);
  --chart-grid:  #1a2040;
  --chart-axis:  #3a4060;
}
```

### Typography

- **Headers/tabs/titles:** `"Press Start 2P", monospace` — 10–14px, sparingly.
- **Data/tables/numbers:** `"VT323", monospace` — readable pixel mono for dense data.
- **Body/descriptions:** `"Pixelify Sans", sans-serif` — readable pixelish for longer text.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&family=Pixelify+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
```

### Effects

- **CRT scanlines:** fixed `<div class="scanlines">` with `repeating-linear-gradient`, low opacity.
- **Neon glow:** `text-shadow: 0 0 4px currentColor, 0 0 8px currentColor` on accent text.
- **Pixel borders:** 2–3px solid neon; stepped corners via `clip-path`; no rounded corners.
- **Blinking cursor** for "live" indicators.
- **Subtle vignette** on main layout.
- **Optional global CRT curvature/flicker** behind Settings toggle — off by default.

### TradingView Lightweight Charts theming

```ts
const chartOptions = {
  layout: {
    background: { type: 'solid', color: 'transparent' },
    textColor: '#e0e0ff',
    fontFamily: '"VT323", monospace',
    fontSize: 14,
  },
  grid: {
    vertLines: { color: '#1a2040' },
    horzLines: { color: '#1a2040' },
  },
  rightPriceScale: { borderColor: '#3a4060' },
  timeScale:       { borderColor: '#3a4060' },
  crosshair: {
    vertLine: { color: '#00ffff', labelBackgroundColor: '#0a0014' },
    horzLine: { color: '#00ffff', labelBackgroundColor: '#0a0014' },
  },
};
const candleOptions = {
  upColor:        '#39ff14',
  downColor:      '#ff3864',
  wickUpColor:    '#39ff14',
  wickDownColor:  '#ff3864',
  borderVisible:  false,
};
```

### shadcn/ui override strategy

- Install shadcn/ui normally; override via CSS variables.
- `--radius: 0px` (square everything).
- Map accent colors to neon palette.
- Button/Input/Select: 2px neon borders, subtle glow on focus.
- Avoid easing — use `steps(n)` or `linear` for pixel-correct feel.

### Rules of restraint

- Press Start 2P only at 10–14px, only for headers/tabs.
- Glow on ≤20% of on-screen text, or it stops being a signal.
- Never mix more than 3 neon colors in one panel.
- Data legibility trumps aesthetic.

---

## 5. Architecture Overview

### Process model

**Single Node process**, PM2-managed Windows service. Hosts:
1. Fastify HTTP + SSE server.
2. All data collectors.
3. Core services (event bus, normalizer, store, probability engine, order manager, alert engine).

Frontend is a **separate Next.js dev server** (port 3000) during development, or built static served by Fastify in production. Server on port 3001.

```
┌──────────────────────────────────────────────────────────────────┐
│                    Node process (PM2: "cockpit-server")           │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐     │
│  │  COLLECTORS  │  │  CORE        │  │  EXECUTION          │     │
│  │              │  │              │  │                     │     │
│  │ crypto (WS)  │─▶│ event-bus    │─▶│ crypto (ccxt)       │     │
│  │ stocks       │  │ normalizer   │  │ stocks (alpaca)     │     │
│  │ onchain      │  │ probability  │  │ order-manager       │     │
│  │ news         │  │ alert-engine │  │ risk-guards         │     │
│  │ macro        │  │ store (sqlite)│ │                     │     │
│  └──────────────┘  └──────────────┘  └─────────────────────┘     │
│           │                │                    │                 │
│           └────────────────┼────────────────────┘                 │
│                            │                                      │
│                  ┌─────────▼──────────┐                           │
│                  │  FASTIFY API       │                           │
│                  │  /api/*  /stream   │                           │
│                  └─────────┬──────────┘                           │
└────────────────────────────┼─────────────────────────────────────┘
                             │  SSE + REST (localhost only)
                             ▼
              ┌──────────────────────────────┐
              │    Next.js frontend          │
              │  /  /trading/*  /whales /news│
              │  /indicators /alerts /settings│
              └──────────────────────────────┘
```

### Data flow

1. **Collector** fetches (WS tick, REST poll, RSS parse).
2. Collector → **Normalizer** → typed `Event` / `Candle`.
3. Normalizer → **Store** (SQLite) + **Event Bus** (in-process EventEmitter).
4. Event Bus → **Probability Engine** (recompute), **Alert Engine** (test rules), **SSE subscribers**.
5. **Brain snapshot job** — for each significant event, schedule price captures at t+5m..+3w.
6. Frontend subscribes to `/stream` (SSE), filters client-side, updates reactively.

### Why monolith, not microservices

- Single user. No scaling concern.
- In-process EventEmitter beats HTTP between modules.
- One deploy unit = one PM2 process = one log set.
- Internal module boundaries leave optionality to split later.

---

## 6. Tech Stack

| Layer | Choice | Package | Notes |
|---|---|---|---|
| Runtime | Node.js | v22+ LTS | v24 works; fallback to v22 via nvm-windows if native build issues |
| Package manager | pnpm | `pnpm@latest` | `npm i -g pnpm` |
| Monorepo | pnpm workspaces | built-in | No Turborepo unless needed |
| Language | TypeScript | `typescript@5.6+` | strict mode everywhere |
| Frontend | Next.js 15 | `next@15` | App Router |
| UI library | React 19 | `react@19` | |
| Styling | Tailwind CSS | `tailwindcss@3.4+` | CSS variables for theming |
| Component kit | shadcn/ui | CLI install | Heavy override for pixel 80s |
| Charts | TradingView Lightweight Charts | `lightweight-charts@4.x` | Free |
| Client state | Zustand | `zustand@5` | UI state |
| Server state | TanStack Query | `@tanstack/react-query@5` | REST + cache |
| SSE client | native EventSource | — | |
| Backend framework | Fastify | `fastify@5` | + `@fastify/sse-v2`, `@fastify/cors` |
| DB | SQLite | `better-sqlite3@11` | Synchronous, fast, zero ops |
| Migrations | Custom runner | — | No ORM — direct SQL |
| Validation | Zod | `zod@3.23+` | At all boundaries |
| Crypto exchanges | ccxt | `ccxt@4.x` | Binance only initially |
| Stock broker | Alpaca SDK | `@alpacahq/alpaca-trade-api@3` | Paper first |
| On-chain — ETH | Etherscan | via `undici` fetch | |
| On-chain — SOL | Helius / @solana/web3.js | `@solana/web3.js@1.x` | |
| On-chain — BTC | Blockstream REST | fetch | No key |
| News RSS | rss-parser | `rss-parser@3` | |
| Stocks data | Twelve Data + Finnhub + Yahoo | fetch + `yahoo-finance2` | |
| Rate limiting | Bottleneck | `bottleneck@2` | One per outbound client |
| Scheduling | node-cron | `node-cron@3` | |
| Env config | dotenv + zod | `dotenv`, `zod` | Fail fast on missing keys |
| Encryption | Node `crypto` built-in | — | AES-256-GCM for `api_keys` |
| Logger | Pino | `pino@9` | JSON; `pino-pretty` in dev |
| Process manager | PM2 | `pm2@5`, `pm2-windows-startup` | |
| Testing (later) | Vitest | `vitest@2` | Not required for MVP |
| Linting | ESLint + Prettier | standard | |

---

## 7. Repo Skeleton

```
D:/Claude/trading-cockpit/
├── PLAN.md                            ← shared reference (this file)
├── IMPL-1-FOUNDATION.md               ← Phases 0+1
├── IMPL-2-TRADING.md                  ← Phases 2+3
├── IMPL-3-INTELLIGENCE.md             ← Phases 4+5+6
├── IMPL-4-SYNTHESIS-ACTION.md         ← Phases 7+8+9+10
├── STATUS.md                          ← created in Phase 1; live tracker
├── README.md                          ← one-page quick start
├── .env.example
├── .env                               ← gitignored
├── .gitignore
├── package.json                       ← pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── ecosystem.config.cjs               ← PM2 config
│
├── apps/
│   ├── server/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts               ← entry
│   │   │   ├── config.ts              ← env + SQLite keys overlay
│   │   │   ├── db/
│   │   │   │   ├── client.ts
│   │   │   │   ├── migrations/001_initial.sql
│   │   │   │   └── migrate.ts
│   │   │   ├── core/
│   │   │   │   ├── event-bus.ts
│   │   │   │   ├── normalizer.ts
│   │   │   │   ├── probability-engine.ts
│   │   │   │   ├── alert-engine.ts
│   │   │   │   └── snapshot-job.ts
│   │   │   ├── collectors/
│   │   │   │   ├── crypto/
│   │   │   │   │   ├── binance-ws.ts
│   │   │   │   │   └── binance-rest.ts
│   │   │   │   ├── stocks/
│   │   │   │   │   ├── twelvedata.ts
│   │   │   │   │   ├── finnhub.ts
│   │   │   │   │   └── yahoo.ts
│   │   │   │   ├── onchain/
│   │   │   │   │   ├── eth-etherscan.ts
│   │   │   │   │   ├── sol-helius.ts
│   │   │   │   │   └── btc-blockstream.ts
│   │   │   │   ├── news/
│   │   │   │   │   ├── rss.ts
│   │   │   │   │   └── cryptopanic.ts
│   │   │   │   └── macro/
│   │   │   │       ├── fear-greed.ts
│   │   │   │       ├── dxy-vix.ts
│   │   │   │       ├── funding-oi.ts
│   │   │   │       └── fred.ts
│   │   │   ├── execution/
│   │   │   │   ├── crypto-ccxt.ts
│   │   │   │   ├── stocks-alpaca.ts
│   │   │   │   ├── order-manager.ts
│   │   │   │   ├── risk-guards.ts
│   │   │   │   └── paper-mode.ts
│   │   │   ├── api/
│   │   │   │   ├── server.ts
│   │   │   │   ├── sse.ts
│   │   │   │   ├── assets.ts
│   │   │   │   ├── candles.ts
│   │   │   │   ├── events.ts
│   │   │   │   ├── whales.ts
│   │   │   │   ├── alerts.ts
│   │   │   │   ├── orders.ts
│   │   │   │   ├── settings.ts
│   │   │   │   └── probability.ts
│   │   │   ├── jobs/
│   │   │   │   └── scheduler.ts
│   │   │   ├── util/
│   │   │   │   ├── rate-limiter.ts
│   │   │   │   ├── crypto-vault.ts
│   │   │   │   ├── logger.ts
│   │   │   │   └── time.ts
│   │   │   └── seed/
│   │   │       ├── crypto_watchlist.json
│   │   │       ├── stock_watchlist.json
│   │   │       ├── commodity_watchlist.json
│   │   │       ├── rss_feeds.json
│   │   │       ├── whale_addresses.json
│   │   │       ├── ignore_addresses.json
│   │   │       └── probability_weights.json
│   │   └── data/                      ← gitignored; SQLite lives here
│   │       └── cockpit.db
│   │
│   └── web/
│       ├── package.json
│       ├── tsconfig.json
│       ├── next.config.mjs
│       ├── tailwind.config.ts
│       ├── postcss.config.mjs
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── globals.css
│       │   ├── page.tsx               ← Dashboard
│       │   ├── trading/
│       │   │   ├── layout.tsx
│       │   │   ├── crypto/page.tsx
│       │   │   ├── metals/page.tsx
│       │   │   ├── commodities/page.tsx
│       │   │   └── stocks/page.tsx
│       │   ├── whales/page.tsx
│       │   ├── news/page.tsx
│       │   ├── indicators/page.tsx
│       │   ├── alerts/page.tsx
│       │   └── settings/page.tsx
│       ├── components/
│       │   ├── chart/
│       │   ├── trading/
│       │   ├── shell/
│       │   ├── dashboard/
│       │   ├── whales/
│       │   ├── news/
│       │   ├── indicators/
│       │   ├── alerts/
│       │   └── settings/
│       ├── lib/
│       │   ├── api.ts
│       │   ├── sse.ts
│       │   ├── store.ts
│       │   └── query.ts
│       └── styles/pixel.css
│
└── packages/
    └── shared/
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── index.ts
            ├── events.ts
            ├── assets.ts
            ├── probability.ts
            ├── orders.ts
            └── alerts.ts
```

### pnpm-workspace.yaml
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### Root `package.json` scripts
```json
{
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
    "pm2:status":   "pm2 status"
  }
}
```

---

## 8. Data Model

All timestamps `INTEGER` unix seconds UTC. Prices `REAL`. JSON columns `TEXT` validated with Zod.

### `001_initial.sql`

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ─── assets & watchlists ────────────────────────────────────────────
CREATE TABLE assets (
  id           INTEGER PRIMARY KEY,
  symbol       TEXT NOT NULL,
  display_name TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN (
                 'crypto','stock','etf','forex','commodity','index'
               )),
  exchange     TEXT,
  tradeable_via TEXT,                  -- 'ccxt'|'alpaca'|null
  tradeable_symbol TEXT,               -- e.g. GLD for XAU/USD display
  metadata_json TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  UNIQUE(symbol, exchange)
);
CREATE INDEX idx_assets_type ON assets(type);
CREATE INDEX idx_assets_enabled ON assets(enabled);

-- ─── candles (one table per timeframe) ──────────────────────────────
CREATE TABLE candles_1m (
  asset_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  o REAL, h REAL, l REAL, c REAL, v REAL,
  PRIMARY KEY (asset_id, ts)
) WITHOUT ROWID;
CREATE TABLE candles_3m  (asset_id INTEGER, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
                          PRIMARY KEY(asset_id, ts)) WITHOUT ROWID;
CREATE TABLE candles_15m (asset_id INTEGER, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
                          PRIMARY KEY(asset_id, ts)) WITHOUT ROWID;
CREATE TABLE candles_1h  (asset_id INTEGER, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
                          PRIMARY KEY(asset_id, ts)) WITHOUT ROWID;
CREATE TABLE candles_4h  (asset_id INTEGER, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
                          PRIMARY KEY(asset_id, ts)) WITHOUT ROWID;
CREATE TABLE candles_1d  (asset_id INTEGER, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
                          PRIMARY KEY(asset_id, ts)) WITHOUT ROWID;
CREATE TABLE candles_1w  (asset_id INTEGER, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL,
                          PRIMARY KEY(asset_id, ts)) WITHOUT ROWID;

-- ─── events (unified firehose) ──────────────────────────────────────
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                -- 'whale_tx'|'news'|'indicator'|'alert'|'macro_snapshot'
  source TEXT NOT NULL,
  ts INTEGER NOT NULL,
  asset_id INTEGER,
  severity INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  dedup_key TEXT UNIQUE,
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);
CREATE INDEX idx_events_ts ON events(ts DESC);
CREATE INDEX idx_events_kind_ts ON events(kind, ts DESC);
CREATE INDEX idx_events_asset_ts ON events(asset_id, ts DESC);

-- ─── brain: per-event forward-price snapshots ───────────────────────
CREATE TABLE events_price_snapshots (
  event_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  horizon TEXT NOT NULL CHECK (horizon IN ('5m','30m','1h','4h','1d','3d','1w','3w')),
  captured_ts INTEGER,
  price REAL,
  pct_change REAL,
  PRIMARY KEY (event_id, asset_id, horizon),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id)
) WITHOUT ROWID;
CREATE INDEX idx_snapshots_pending ON events_price_snapshots(captured_ts)
  WHERE captured_ts IS NULL;

-- ─── whales ────────────────────────────────────────────────────────
CREATE TABLE whale_addresses (
  id INTEGER PRIMARY KEY,
  chain TEXT NOT NULL CHECK (chain IN ('eth','sol','btc')),
  address TEXT NOT NULL,
  label TEXT,
  tags_json TEXT,
  added_at INTEGER NOT NULL,
  last_checked_block INTEGER,
  last_checked_ts INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(chain, address)
);
CREATE INDEX idx_whales_chain_enabled ON whale_addresses(chain, enabled);

CREATE TABLE ignore_addresses (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  label TEXT,
  PRIMARY KEY (chain, address)
) WITHOUT ROWID;

-- ─── indicator readings (time series) ───────────────────────────────
CREATE TABLE indicator_readings (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  ts INTEGER NOT NULL,
  value REAL NOT NULL,
  meta_json TEXT,
  UNIQUE(name, ts)
);
CREATE INDEX idx_indicator_name_ts ON indicator_readings(name, ts DESC);

-- ─── probability engine ────────────────────────────────────────────
CREATE TABLE signal_readings (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  asset_id INTEGER,
  signal TEXT NOT NULL,
  value_normalized REAL NOT NULL,
  weight REAL NOT NULL,
  raw_value_json TEXT
);
CREATE INDEX idx_signals_asset_ts ON signal_readings(asset_id, ts DESC);

CREATE TABLE probability_history (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  horizon TEXT NOT NULL CHECK (horizon IN ('1h','4h','24h')),
  bullish_prob REAL NOT NULL,
  confidence REAL NOT NULL,
  contributing_json TEXT NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);
CREATE INDEX idx_prob_asset_ts ON probability_history(asset_id, horizon, ts DESC);

-- ─── alerts ────────────────────────────────────────────────────────
CREATE TABLE alert_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  condition_json TEXT NOT NULL,
  channels_json TEXT NOT NULL,
  cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  last_fired_ts INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_alerts_enabled ON alert_rules(enabled);

CREATE TABLE alert_firings (
  id INTEGER PRIMARY KEY,
  rule_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  delivered_json TEXT,
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
);
CREATE INDEX idx_firings_ts ON alert_firings(ts DESC);

-- ─── execution: orders & positions ─────────────────────────────────
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  client_order_id TEXT NOT NULL UNIQUE,
  broker TEXT NOT NULL CHECK (broker IN ('paper','ccxt','alpaca')),
  asset_id INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  type TEXT NOT NULL CHECK (type IN ('market','limit','stop')),
  qty REAL NOT NULL,
  limit_price REAL,
  stop_price REAL,
  status TEXT NOT NULL CHECK (status IN (
    'pending','submitted','partial','filled','cancelled','rejected','expired'
  )),
  avg_fill_price REAL,
  filled_qty REAL NOT NULL DEFAULT 0,
  submitted_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  broker_order_id TEXT,
  raw_response_json TEXT,
  error TEXT,
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);
CREATE INDEX idx_orders_status_ts ON orders(status, created_at DESC);
CREATE INDEX idx_orders_asset ON orders(asset_id, created_at DESC);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY,
  broker TEXT NOT NULL,
  asset_id INTEGER NOT NULL,
  qty REAL NOT NULL,
  avg_entry_price REAL NOT NULL,
  realized_pnl REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES assets(id),
  UNIQUE(broker, asset_id)
);

-- ─── api keys (encrypted) ───────────────────────────────────────────
CREATE TABLE api_keys (
  service TEXT PRIMARY KEY,
  key_ciphertext BLOB NOT NULL,
  secret_ciphertext BLOB,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  permissions_json TEXT,
  added_at INTEGER NOT NULL,
  last_verified_ts INTEGER,
  last_verified_ok INTEGER
);

-- ─── system / kv ────────────────────────────────────────────────────
CREATE TABLE kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Used for: kill_switch, trading_mode, last_startup, backfill_status, etc.
```

### Migration runner (behavior)

- Ensure `migrations_applied` table exists.
- Read `migrations/*.sql` in lexicographic order.
- For each not recorded, execute in a single transaction, record it.
- Crash on any error.

---

## 9. APIs & Keys

### Key storage model

1. On startup, server reads `.env` (lowest priority fallback).
2. Then reads encrypted `api_keys` SQLite table (higher priority — overrides `.env`).
3. Settings UI writes to `api_keys` only.
4. Encryption: AES-256-GCM, key derived from `COCKPIT_MASTER_KEY` in `.env`. If missing at first startup, generate one, save to `.env`, print once.
5. Frontend gets masked values only (`sk_xxxx...1234`). "Test connection" hits backend verification.

### Service table

| Service | Tier | Signup URL | Free tier | Purpose | Disables gracefully |
|---|---|---|---|---|---|
| Binance public | 0 | — | Unlimited WS, 1200/min REST | Crypto prices, orderbooks, trades | n/a |
| Binance trading | 2 | binance.com/en/my/settings/api-management | — | Live crypto orders | Yes (paper mode enforced) |
| Yahoo Finance | 0 | — | Unofficial | Stocks, DXY, VIX fallback | n/a |
| RSS feeds | 0 | — | Unlimited | News | n/a |
| alternative.me F&G | 0 | — | Unlimited | Crypto Fear & Greed | n/a |
| Blockstream.info | 0 | — | Unlimited | BTC chain | n/a |
| Solana public RPC | 0 | — | Rate-limited | SOL fallback | n/a |
| CoinGecko (no key) | 0 | — | 30/min | BTC dominance | n/a |
| Twelve Data | 1 | twelvedata.com/register | 800/day, 8/min | Stocks + XAU/XAG/WTI | Falls back to Yahoo |
| Finnhub | 1 | finnhub.io/register | 60/min | Stock news | Falls back to RSS |
| Etherscan | 1 | etherscan.io/register | 5/s, 100k/day | ETH whales | Tab shows "add key" |
| Helius | 1 | helius.dev | Free dev | SOL whales | Falls back to public RPC |
| CryptoPanic | 1 | cryptopanic.com/developers/api | Generous | Curated crypto news | Falls back to RSS |
| FRED | 1 | fred.stlouisfed.org/docs/api/api_key.html | Unlimited | US macro | Those indicators hidden |
| Alpaca paper | 2 | alpaca.markets/paper | Unlimited paper | Stock/ETF paper trading | Execution disabled |
| Telegram Bot | 2 (later) | t.me/BotFather | Unlimited | Alert delivery | Browser notifs only |

### `.env.example`

```env
COCKPIT_MASTER_KEY=

BINANCE_API_KEY=
BINANCE_API_SECRET=
TWELVEDATA_API_KEY=
FINNHUB_API_KEY=
ETHERSCAN_API_KEY=
HELIUS_API_KEY=
CRYPTOPANIC_API_KEY=
FRED_API_KEY=
ALPACA_API_KEY=
ALPACA_API_SECRET=
ALPACA_BASE_URL=https://paper-api.alpaca.markets

SERVER_PORT=3001
SERVER_HOST=127.0.0.1
LOG_LEVEL=info
```

---

## 10. Page / Route Map

| Path | Tab | Purpose |
|---|---|---|
| `/` | Dashboard | Macro strip, probability scores, event firehose, mini-chart grid |
| `/trading/crypto` | Trading → Crypto | Full Binance-style: asset list, chart, orderbook, trades, order-entry |
| `/trading/metals` | Trading → Metals | Gold + silver charts, ETF proxy trading |
| `/trading/commodities` | Trading → Commodities | Oil chart, ETF proxy trading |
| `/trading/stocks` | Trading → Stocks | Stocks watchlist, charts, trading |
| `/whales` | Whales | Chain subtabs, watchlist manager, live tx stream |
| `/news` | News | Feed, filters, detail drawer |
| `/indicators` | Indicators | F&G, DXY, VIX, funding, OI, BTC dominance, FRED |
| `/alerts` | Alerts | Rule builder, active rules, firing history |
| `/settings` | Settings | API keys, watchlists, whale addresses, kill switch |

### Navbar

Top-level tabs + status dot (live = blinking cyan, disconnected = amber), kill-switch toggle (red), local clock (VT323).

---

## 11. Real-time Pipeline

### `Event` type (`packages/shared/src/events.ts`)

```ts
export type AssetId = number;

export type BaseEvent = {
  id: number;
  ts: number;                 // unix seconds UTC
  source: string;
  severity?: number;          // 0..100
};

export type PriceCandleEvent = BaseEvent & {
  kind: 'candle';
  assetId: AssetId;
  timeframe: '1m' | '3m' | '15m' | '1h' | '4h' | '1d' | '1w';
  o: number; h: number; l: number; c: number; v: number;
};

export type WhaleTxEvent = BaseEvent & {
  kind: 'whale_tx';
  chain: 'eth' | 'sol' | 'btc';
  address: string;
  direction: 'in' | 'out';
  token: string;
  amount: number;
  usdValue: number;
  counterpart?: string;
  txHash: string;
  label?: string;
};

export type NewsEvent = BaseEvent & {
  kind: 'news';
  title: string;
  url: string;
  summary?: string;
  tickers: string[];
  sentiment?: number;         // -1..+1
};

export type IndicatorEvent = BaseEvent & {
  kind: 'indicator';
  name: string;
  value: number;
  previous?: number;
  delta?: number;
};

export type AlertEvent = BaseEvent & {
  kind: 'alert';
  ruleId: number;
  ruleName: string;
  payload: unknown;
};

export type Event = PriceCandleEvent | WhaleTxEvent | NewsEvent | IndicatorEvent | AlertEvent;
```

### SSE endpoint

`GET /stream?topics=candles,whales,news,indicators,alerts&assetIds=1,2,3`

- Fastify via `@fastify/sse-v2`.
- In-memory subscriber registry (Map).
- Event bus emits → filter per-subscriber → push.
- Heartbeat every 15s.
- Client auto-reconnects via `EventSource`.

---

## 12. Brain-Ready Data Plumbing

Analysis bot is deferred, but we build the substrate now.

### Mechanism

1. When an `event` row is inserted and `kind` is in the significance set (`whale_tx`, `news` with tickers, `indicator` with sharp delta), normalizer calls `snapshotJob.schedule(eventId, assetIds)`.
2. `snapshot-job.ts` inserts 8 rows into `events_price_snapshots`, one per horizon, `captured_ts = NULL`.
3. A 30-second cron finds snapshots with `captured_ts IS NULL AND event.ts + horizon_seconds <= now`. Captures asset's current close from most recent `candles_1m`. Writes `captured_ts`, `price`, `pct_change`.

### Significance filter (MVP)

```ts
function isSignificantForSnapshot(e: Event): boolean {
  switch (e.kind) {
    case 'whale_tx':   return e.usdValue >= 500_000;
    case 'news':       return e.tickers.length > 0 && (e.severity ?? 0) >= 30;
    case 'indicator':  return Math.abs(e.delta ?? 0) >= 5;
    default:           return false;
  }
}
```

### Brain query shape (for future bots)

```sql
-- Avg 1h price change after ETH whale outflows > $1M
SELECT AVG(eps.pct_change), COUNT(*)
FROM events_price_snapshots eps
JOIN events e ON e.id = eps.event_id
WHERE e.kind = 'whale_tx'
  AND eps.horizon = '1h'
  AND json_extract(e.payload_json, '$.chain') = 'eth'
  AND json_extract(e.payload_json, '$.direction') = 'out'
  AND json_extract(e.payload_json, '$.usdValue') > 1000000
  AND eps.captured_ts IS NOT NULL;
```

---

## 13. Execution Module Design

### Modes

- **Paper (default, always available)** — virtual broker, simulates fills from `candles_1m`.
- **Live crypto** — ccxt + Binance, activated only when key present and `kv['trading_mode'] === 'live'`.
- **Live stocks** — Alpaca paper endpoint (real API calls against their paper exchange). No live stocks trading supported at all; always paper.

### Broker interface (shared)

```ts
interface Broker {
  placeOrder(req: PlaceOrderRequest): Promise<Order>;
  cancelOrder(clientOrderId: string): Promise<void>;
  getOrder(clientOrderId: string): Promise<Order>;
  listOpenOrders(): Promise<Order[]>;
  getPositions(): Promise<Position[]>;
  getAccountBalance(): Promise<AccountBalance>;
}
```

### Risk guards (enforced before every `placeOrder`)

1. **Kill switch** (`kv['kill_switch']`) — if true, reject all new orders.
2. **Per-order max notional** — configurable in Settings (default crypto $500, stocks $500).
3. **Max open positions** per asset (default 1).
4. **Daily loss cap** — reject if today's realized+unrealized ≤ -$X.
5. **Order cooldown** — min seconds between orders per asset (default 10s).
6. **Frontend confirmation modal** — required for every live order.
7. **Live mode double-toggle** — turning on live requires typing "ACTIVATE LIVE" + 5s countdown.

### Binance live key policy

- Enable: trading.
- Disable: withdrawals.
- Restrict: IP whitelist.
- No universal transfer.

---

## 14. Alert System Design

### Rule DSL (`condition_json`)

```ts
type AlertCondition =
  | { type: 'price_move'; assetId: number; pctChange: number; windowSeconds: number; direction: 'up' | 'down' | 'either' }
  | { type: 'price_level'; assetId: number; operator: '>' | '<' | '>=' | '<='; value: number }
  | { type: 'whale_tx'; chain?: 'eth' | 'sol' | 'btc'; minUsd: number; direction?: 'in' | 'out' | 'either'; addressFilter?: string[] }
  | { type: 'news'; keywordsAny?: string[]; keywordsAll?: string[]; tickers?: string[]; minSentimentAbs?: number }
  | { type: 'indicator_level'; name: string; operator: '>' | '<'; value: number }
  | { type: 'indicator_cross'; name: string; direction: 'up' | 'down'; threshold: number }
  | { type: 'probability'; assetId: number; horizon: '1h' | '4h' | '24h'; operator: '>' | '<'; value: number };
```

### Delivery channels

- `browser`: Web Notifications API; permission prompt first use.
- `telegram` (later): bot token in `api_keys`.
- All firings stored in `alert_firings`.

### Cooldown

Per-rule `cooldown_seconds` (default 300). After firing, rule muted for that duration.

---

## 15. Phase Index

| Phase | Title | Implementation File |
|---|---|---|
| 0 | Preflight + Spike | [IMPL-1-FOUNDATION.md](IMPL-1-FOUNDATION.md) |
| 1 | Backbone | [IMPL-1-FOUNDATION.md](IMPL-1-FOUNDATION.md) |
| 2 | Crypto Trading Tab | [IMPL-2-TRADING.md](IMPL-2-TRADING.md) |
| 3 | Non-Crypto Trading Tabs | [IMPL-2-TRADING.md](IMPL-2-TRADING.md) |
| 4 | Whale Tracker | [IMPL-3-INTELLIGENCE.md](IMPL-3-INTELLIGENCE.md) |
| 5 | News | [IMPL-3-INTELLIGENCE.md](IMPL-3-INTELLIGENCE.md) |
| 6 | Indicators | [IMPL-3-INTELLIGENCE.md](IMPL-3-INTELLIGENCE.md) |
| 7 | Dashboard + Probability Engine | [IMPL-4-SYNTHESIS-ACTION.md](IMPL-4-SYNTHESIS-ACTION.md) |
| 8 | Alerts | [IMPL-4-SYNTHESIS-ACTION.md](IMPL-4-SYNTHESIS-ACTION.md) |
| 9 | Execution (Paper) | [IMPL-4-SYNTHESIS-ACTION.md](IMPL-4-SYNTHESIS-ACTION.md) |
| 10 | Execution (Live Crypto, optional) | [IMPL-4-SYNTHESIS-ACTION.md](IMPL-4-SYNTHESIS-ACTION.md) |

### Implementation workflow

1. Read this PLAN.md fully. It's the shared context for all phases.
2. Check `STATUS.md` for the current phase.
3. Open the corresponding IMPL file.
4. Follow tasks, meet exit criteria, commit, update `STATUS.md`.
5. At the end of a part file, follow its handoff checklist into the next part.

### Milestones (what's demonstrable at the end of each part)

- **End of Part 1:** empty but wired shell — `pnpm dev` starts, all routes render with pixel 80s theme, SSE stream alive, SQLite initialized, PM2 configured.
- **End of Part 2:** all 4 trading tabs show live charts for their assets, paper orders work.
- **End of Part 3:** whale tracker, news feed, indicators pages all populate from their own collectors.
- **End of Part 4:** unified dashboard with probability scores, alerts fire, execution layer fully functional (paper); optional live crypto toggle available.

---

## 16. Pre-flight Checklist

Run before Phase 0 begins. Scripted later into `scripts/preflight.ts`.

- [ ] Node version ≥ 22 (`node --version`). Verified v24.13.1.
- [ ] pnpm installed (`pnpm --version`). If missing: `npm i -g pnpm`.
- [ ] Git installed. Verified 2.46.
- [ ] Python 3.x available (for native rebuilds). Verified 3.14.3.
- [ ] D: free space > 5 GB. Verified ~127 GB.
- [ ] Network reachability verified: Binance, Twelve Data, Etherscan, Alpaca.
- [ ] Ports 3000 / 3001 / 8080 not in use.
- [ ] Project folder `D:/Claude/trading-cockpit/` exists and is writable.
- [ ] Tier 1 API keys (user to sign up in parallel with Phase 1):
  - [ ] Twelve Data
  - [ ] Finnhub
  - [ ] Etherscan
  - [ ] Helius (Solana)
  - [ ] CryptoPanic
  - [ ] FRED
- [ ] Tier 2 API keys (deferred):
  - [ ] Alpaca paper (needed at Phase 9)
  - [ ] Binance trading (needed at Phase 10, only if user wants live)

---

## 17. Windows Service (PM2)

### One-time setup

```bash
npm i -g pm2
npm i -g pm2-windows-startup
pm2-startup install
```

### `ecosystem.config.cjs`

```js
module.exports = {
  apps: [{
    name: 'cockpit-server',
    script: './apps/server/dist/index.js',
    cwd: 'D:/Claude/trading-cockpit',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '1G',
    autorestart: true,
    restart_delay: 3000,
    env: { NODE_ENV: 'production' },
    out_file: 'D:/Claude/trading-cockpit/logs/out.log',
    error_file: 'D:/Claude/trading-cockpit/logs/err.log',
    time: true,
  }],
};
```

### Operating

```bash
pnpm build
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
pm2 logs cockpit-server
pm2 restart cockpit-server
pm2 stop cockpit-server
```

### Expected resources

- RAM: ~150–300 MB resident
- CPU: <1% avg, 2–5% spikes
- Disk growth: ~50–200 MB/month
- Network: low single-digit MB/hr

---

## 18. Pitfalls & Gotchas

1. **Never loop-call an API without a rate limiter.** `bottleneck` per service; free-tier limit minus 20% safety.
2. **WebSocket reconnect + backfill.** On reconnect, re-fetch last 5 min of candles to cover gaps.
3. **UTC internally, local at render.** Use `Date.now() / 1000 | 0`. Format with Intl.DateTimeFormat at edge.
4. **Price inconsistency.** Pick one canonical source per asset (Binance for crypto).
5. **Whale noise is 90% of the work.** `ignore_addresses` is load-bearing. Without it, alerts are garbage.
6. **Market hours.** US equities 9:30–16:00 ET weekdays. Forex 24/5. Crypto 24/7. Don't poll closed markets.
7. **Tick storage explodes.** Only 1m+ candles. 1m × 1y × 10 assets = ~5.2M rows (fine for SQLite).
8. **Free tiers reset UTC midnight.** Spread requests or dashboard dies at 00:00 UTC.
9. **Keys in frontend = game over.** Ever. Even public ones. Backend only.
10. **CORS hell.** Most free APIs block browser origins. Another reason for the backend.
11. **TradingView Lightweight license.** Free personal + commercial, can't become a TradingView competitor. Fine.
12. **Hidden "free" costs.** CoinGecko throttles, may ban IPs. Alchemy compute units add up with mempool subs.
13. **Time-series indexes.** `(asset_id, ts DESC)` and `(ts DESC)` — don't forget them.
14. **SQLite WAL mode.** `PRAGMA journal_mode = WAL` in migration 001.
15. **better-sqlite3 native binary.** On Node 24, fall back to Node 22 LTS via nvm-windows if install fails.
16. **Alpaca paper is real API calls.** Can exhaust weekly request budget in dev loops. Back off.
17. **Binance WS limits.** 1024 streams/conn, 5 incoming msg/s/IP. Fine for us.
18. **News dedup.** Dedupe by canonical URL + fuzzy title match.
19. **RSS encoding.** Most feeds UTF-8; ISO-8859-1 older feeds need fallback.
20. **Whale webhooks.** Etherscan has no WS; poll. Alchemy Notify has daily caps.
21. **Kill switch checked on every order path.** Not just UI — backend guards.
22. **`clientOrderId` never reused.** UUID v7 or `${assetId}-${ts}-${rand6}`.
23. **Seed JSON vs DB.** Seed loaded only when table is empty. Seed edits don't update DB — use a migration.
24. **Probability weights in JSON.** Hot-reload or explicit Settings button. Don't require server restart to tune.

---

## 19. Conventions

- **Language:** TypeScript strict mode everywhere.
- **Imports:** path aliases from `tsconfig.base.json` (`@cockpit/shared`, `@cockpit/server/*`, `@cockpit/web/*`).
- **Time:** unix seconds UTC as `INTEGER`. Never ISO strings in DB.
- **Money:** `REAL`; never mix currencies without explicit conversion; `usdValue` for on-chain events.
- **Naming:** `snake_case` SQL, `camelCase` TS, `PascalCase` types + components.
- **One rate limiter per outbound service.** Shared via `util/rate-limiter.ts`.
- **One log line per event.** Pino structured logs.
- **No console.log in committed code.** Use logger.
- **Zod at every boundary:** env, API in, API out, SSE payloads.
- **Migrations append-only.** Never edit an applied migration.
- **No ORM.** Direct SQL via typed wrappers in `db/queries/*.ts`.
- **Commit after every phase.** Message format: `Phase N: <short title>`. Tag `vN.0` if released.
- **Update `STATUS.md` after every phase.**
- **`.env` gitignored; `.env.example` committed.**

---

## 20. Progress Tracking

### `STATUS.md` (created at Phase 1 start)

```md
# Cockpit Status

**Current phase:** Phase N — <title> (<in progress | exit-ready | blocked>)
**Last commit:** <hash> — <message>
**Updated:** <ISO date>

## Phase checklist
- [x] Phase 0 — Preflight + Spike
- [ ] Phase 1 — Backbone  ← in progress
- [ ] Phase 2 — Crypto trading tab
- [ ] Phase 3 — Non-crypto trading tabs
- [ ] Phase 4 — Whale tracker
- [ ] Phase 5 — News
- [ ] Phase 6 — Indicators
- [ ] Phase 7 — Dashboard + probability engine
- [ ] Phase 8 — Alerts
- [ ] Phase 9 — Execution (paper)
- [ ] Phase 10 — Execution (live crypto)

## Active blockers
- (none | <list>)

## API keys status
- [x] Binance public (no key needed)
- [ ] Twelve Data — user to add in Settings
- ...

## Notes for next session
- <hand-off notes>
```

### Commit cadence

- Commit after every phase's exit criteria met.
- Mid-phase commits at natural milestones.
- Don't save all at the end.

### Memory updates

At each phase completion, update `project_cockpit_progress.md` in global memory.

---

## Appendix A — Useful commands

```bash
pnpm dev                         # both apps parallel
pnpm dev:server                  # server only
pnpm dev:web                     # web only
pnpm typecheck                   # whole repo
pnpm migrate                     # run migrations
sqlite3 apps/server/data/cockpit.db   # inspect DB
pm2 logs cockpit-server --lines 200
```

## Appendix B — References

- TradingView Lightweight Charts: https://tradingview.github.io/lightweight-charts/
- ccxt: https://github.com/ccxt/ccxt
- Alpaca API: https://docs.alpaca.markets/
- Etherscan API: https://docs.etherscan.io/
- Helius API: https://docs.helius.dev/
- Blockstream Esplora: https://github.com/Blockstream/esplora/blob/master/API.md
- Twelve Data: https://twelvedata.com/docs
- Finnhub: https://finnhub.io/docs/api
- FRED API: https://fred.stlouisfed.org/docs/api/fred/
- alternative.me F&G: https://alternative.me/crypto/fear-and-greed-index/
- rss-parser: https://www.npmjs.com/package/rss-parser
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3
- Fastify SSE plugin: https://github.com/NodeFactoryIo/fastify-sse-v2
- PM2 Windows startup: https://www.npmjs.com/package/pm2-windows-startup

## Appendix C — Open items for first implementer to confirm

Surface to Luka before committing code if material:

- Exact whale addresses for Phase 4 seed (research within that phase).
- Exact ignore addresses to seed — start with a base list, expand with observed noise.
- Probability weights initial values in `seed/probability_weights.json` — start equal, tune empirically.
- News sentiment lexicon — small hand-list to start, dataset later.
- Whether to include SPY/QQQ alongside 10 stocks as market refs. Default: no unless confirmed.

---

**End of shared reference.** Phase implementation details live in `IMPL-*.md` files.
