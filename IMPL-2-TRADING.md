# IMPL Part 2 — Trading Tabs (Phases 2 + 3)

> **Prerequisite:** Read [PLAN.md](PLAN.md) first. Part 1 ([IMPL-1-FOUNDATION.md](IMPL-1-FOUNDATION.md)) must be complete and committed — backbone, migrations, SSE, empty routes, PM2 all working.

**Covers:**
- **Phase 2** — Crypto Trading Tab (~2 weeks)
- **Phase 3** — Non-Crypto Trading Tabs (~2 weeks)

**At the end of this part you will have:**
- Live Binance WebSocket feeding candles + trades + orderbook for 7 crypto pairs.
- A Binance-style trading view with: asset list, themed TradingView chart, orderbook, trade tape, order-entry panel.
- Historical backfill (~90d crypto, ~30d stocks) loaded on first run.
- Same trading UI working for metals (XAU/USD, XAG/USD), commodities (WTI), and stocks (10 tickers), polled from Twelve Data + Finnhub + Yahoo.
- Market-hours awareness (no polling closed markets).
- Paper order placement functioning end-to-end for every asset type (stub execution — real Broker adapters land in Part 4).

**Handoff to Part 3** at the bottom lists assumed state.

---

## Ground rules for this part

- **Paper order entry is stubbed here.** Phase 9 in Part 4 is where the real `order-manager` + `risk-guards` + Alpaca/ccxt adapters land. In Part 2 we build only the UI + a naive "write to orders table, instantly filled at last close" path so clicking Buy/Sell does something visible.
- **Don't add whale/news/indicator features here** even if tempting. Those are Part 3.
- **Commit at every sub-milestone** (WS connected, historical backfilled, chart rendering, orderbook rendering, order-entry working, then per asset class).

---

## Phase 2 — Crypto Trading Tab

### Goal

Full Binance-style trading view for BTC, ETH, SOL, BNB, XRP, ADA, LTC. Live chart with all 7 timeframes, live orderbook (top 20 levels), live trade tape, working asset switcher, paper order entry (stubbed).

### 2.1 — Binance WebSocket collector

**File:** `apps/server/src/collectors/crypto/binance-ws.ts`

**Endpoints used:**
- Combined stream: `wss://stream.binance.com:9443/stream?streams=<stream1>/<stream2>/...`
- Per-pair streams to subscribe:
  - `<symbol>@kline_1m` — 1-minute candle ticks
  - `<symbol>@trade` — individual trades
  - `<symbol>@depth20@100ms` — orderbook top 20 levels, 100ms throttle

Seven pairs × 3 streams = 21 streams on one connection (well under Binance's 1024 limit).

**Implementation behavior:**
1. On startup, subscribe for every enabled crypto asset.
2. For each `kline` message with `k.x === true` (candle closed), upsert into `candles_1m` and emit a `PriceCandleEvent` to the bus. Also maintain a live "current candle" broadcast every tick for chart UI (SSE-only, not persisted).
3. For each `trade` message, emit a lightweight trade tick on the bus (new kind, see note below) and retain last N=200 per asset in-memory for the "recent trades" panel.
4. For each `depth20` snapshot, store the latest per asset in-memory (Map<assetId, OrderbookSnapshot>) and emit to SSE. Never persist orderbook to SQLite (volume too high, low value).
5. **Reconnect logic:** on close/error, exponential backoff (1s, 2s, 4s, 8s, cap 30s). On reconnect: for every asset, fetch last 5 minutes of 1m candles via REST (§2.2) to fill any gap, upsert, done.
6. Pings: Binance server pings every 3 min; WebSocket library auto-replies. If no traffic for 10 min, force reconnect.
7. Log structured connection events: `ws.connect`, `ws.subscribed`, `ws.message`, `ws.reconnect`.

**Add to shared types (extend `packages/shared/src/events.ts`):**
```ts
export type TradeTickEvent = BaseEvent & {
  kind: 'trade_tick';
  assetId: AssetId;
  price: number;
  qty: number;
  side: 'buy' | 'sell';
};

export type OrderbookEvent = BaseEvent & {
  kind: 'orderbook';
  assetId: AssetId;
  bids: [price: number, qty: number][];
  asks: [price: number, qty: number][];
};

// Add to the Event union
export type Event = PriceCandleEvent | TradeTickEvent | OrderbookEvent
  | WhaleTxEvent | NewsEvent | IndicatorEvent | AlertEvent;
```

### 2.2 — Binance REST collector (backfill + fallback)

**File:** `apps/server/src/collectors/crypto/binance-rest.ts`

Responsibilities:
- **Historical backfill** on first run: for each enabled crypto asset, pull ~90 days of `1m` candles (`/api/v3/klines?interval=1m&limit=1000` paginated). Upsert into `candles_1m`.
- **Aggregation to higher timeframes:** after backfill (and on a 1-hourly cron), compute `candles_3m`, `candles_15m`, `candles_1h`, `candles_4h`, `candles_1d`, `candles_1w` from `candles_1m` for each asset. Use SQL `GROUP BY (ts / window_seconds)` with SUM for volume, FIRST/LAST aggregates for open/close, MIN/MAX for high/low.
- **Gap-fill on reconnect** (called from WS collector): `getRecentCandles(assetId, fromTs)`.
- Rate-limited via Bottleneck: Binance allows 1200 req/min REST — set limiter to 900 (75% safety).

Track backfill progress in `kv['backfill_status']` so a restart mid-backfill resumes cleanly:
```json
{ "BTCUSDT": { "completed": true, "last_ts": 1713390000 },
  "ETHUSDT": { "completed": false, "last_ts": 1710000000 } }
```

### 2.3 — Backend API endpoints

Create these in `apps/server/src/api/`:

- **`candles.ts`** — `GET /api/candles?assetId={id}&timeframe={tf}&from={ts}&to={ts}&limit={n}` → rows from the matching `candles_<tf>` table.
- **`events.ts`** — `GET /api/events?kind={k}&assetId={id}&limit={n}&before={ts}` → rows from `events`, newest first.
- **`orders.ts`** — stub for Phase 2:
  - `POST /api/orders` with body `{ assetId, side, type, qty, limitPrice?, stopPrice? }` → writes to `orders` table as `paper` broker, status `filled` at last `candles_1m.c`, creates/updates `positions` row. Emits a `trade_tick` event for visibility. This is a deliberate shortcut; the real implementation is Phase 9.
  - `GET /api/orders?status=open|all&limit=n` → list.
  - `DELETE /api/orders/:id` → mark cancelled (no-op for already-filled).
- **`positions.ts`** — `GET /api/positions` → all rows.

All request/response bodies validated with Zod.

### 2.4 — Frontend chart component

**`apps/web/components/chart/LightweightChart.tsx`**

Props: `assetId: number`, `timeframe: Timeframe`, `height?: number`.

Behavior:
1. On mount, fetch `/api/candles` with the timeframe. Populate initial series.
2. Subscribe via `useEventStream(['candles', 'trade_tick'], [assetId])` for live updates. Update the series' last candle on each tick; append new candles when timeframe boundary crosses.
3. Chart options: themed per [PLAN.md §4](PLAN.md#4-pixel-80s-design-direction) (`chartOptions`, `candleOptions`).
4. Volume pane: second pane below candles with histogram.
5. Cleanup on unmount: `chart.remove()`, close EventSource.

**`apps/web/components/chart/TimeframeSwitcher.tsx`** — segmented control: `1m · 3m · 15m · 1h · 4h · 1d · 1w`. Stores selection in Zustand so it persists across re-renders.

### 2.5 — Trading panel components

- **`components/trading/AssetList.tsx`** — left column. For each enabled asset of the current tab's type:
  - Symbol + display name
  - Last price (from latest candle close)
  - 24h % change (from first vs last `candles_1h` in last 24 rows)
  - Mini sparkline (`candles_1h` last 24 closes)
  - Click → sets active asset via Zustand `tradingStore.setActiveAsset(id)`
  - Search input filters the list.

- **`components/trading/Orderbook.tsx`** — right column, crypto only:
  - Subscribes via SSE to `orderbook` events for active asset.
  - 20 bid rows + 20 ask rows, cumulative-volume bars drawn as `div` widths (neon green for bids, neon red for asks).
  - Spread row in the middle; mid-price in neon cyan.
  - VT323 font for numbers.

- **`components/trading/RecentTrades.tsx`** — live tape, last 50 trades:
  - Subscribes to `trade_tick` events for active asset.
  - Columns: time, price (up/down color), qty.
  - Scrolls; newest at top.

- **`components/trading/MarketStats.tsx`** — top strip:
  - 24h High/Low/Volume/Change, computed from recent 1h candles.
  - Funding rate (crypto only, added in Phase 6 — leave placeholder `--` for now).

- **`components/trading/OrderEntry.tsx`** — bottom panel:
  - Tabs: `MARKET` / `LIMIT` / `STOP` (stop disabled in Phase 2 — enable in Phase 9).
  - Buy (neon green) / Sell (neon red) segmented toggle.
  - Qty input (units) + approximate notional (qty × last price).
  - Submit button opens confirmation modal: "PAPER ORDER — confirm?" with details. On confirm: `POST /api/orders`.
  - Shows "PAPER" badge prominently in pixel 80s styling so it's never mistaken for live.

### 2.6 — Wire the Crypto page

**`apps/web/app/trading/layout.tsx`** — shared sub-tab bar for Crypto / Metals / Commodities / Stocks. Active tab reads from URL.

**`apps/web/app/trading/crypto/page.tsx`** — layout:
```
┌───────────────────────────────────────────────────────────┐
│  MarketStats (24h high/low/vol/change, funding placeholder)│
├─────────┬──────────────────────────────────┬──────────────┤
│         │                                   │              │
│  Asset  │      LightweightChart             │  Orderbook   │
│  List   │      + TimeframeSwitcher          │  (20 / 20)   │
│         │                                   │              │
│         │                                   ├──────────────┤
│         │                                   │ Recent Trades│
│         │                                   │              │
├─────────┴──────────────────────────────────┴──────────────┤
│                    OrderEntry (paper)                      │
└───────────────────────────────────────────────────────────┘
```

Active asset lives in Zustand `tradingStore.activeAsset['crypto']` (one per sub-tab so switching between tabs remembers selection).

### 2.7 — Exit criteria (Phase 2)

- [ ] Binance WS connects on server boot; log shows 21 streams subscribed.
- [ ] After backfill, `SELECT COUNT(*) FROM candles_1m WHERE asset_id = <BTC>` returns ~130k rows (~90 days).
- [ ] Switching timeframe re-fetches and re-renders the chart from the correct `candles_<tf>` table.
- [ ] Chart updates in real time — current candle grows; new candle appears at boundary crossings.
- [ ] Orderbook updates ≥5 times/second with cumulative bars visible.
- [ ] Recent trades tape flows with colored rows matching buy/sell side.
- [ ] Asset list switches active asset; chart + orderbook + trades all update accordingly.
- [ ] Placing a paper MARKET buy creates an `orders` row with status `filled`, `avg_fill_price` = last close, and a `positions` row. UI shows updated position.
- [ ] Placing a paper LIMIT order at a price the market hasn't crossed remains `pending` (even though Phase 2's "instant fill at close" is the default, limit orders pending until a subsequent `candles_1m.c` crosses the limit — implement this check in `api/orders.ts`).
- [ ] Killing the WS (disconnect PC network for 30s) → server auto-reconnects → gap in `candles_1m` filled via REST.
- [ ] `pm2 restart cockpit-server` — on restart, reconnect happens, backfill resume correctly (no duplicate rows).
- [ ] Commit: `Phase 2: crypto trading tab`. Tag `v2.0`.
- [ ] `STATUS.md` updated.

### 2.8 — Phase 2 pitfalls

- **Combined stream message shape.** Combined streams wrap payloads as `{ stream, data }`. Make sure the parser unwraps correctly.
- **`lastUpdateId` for orderbook.** If you ever upgrade to a full depth diff stream, you'd need to snapshot + buffer + resync. For `depth20@100ms` we only use snapshots — much simpler. Keep it snapshot-only.
- **Timezone off-by-one on aggregation.** Binance `klines` return ms timestamps; convert to seconds and floor to the timeframe boundary (`ts - (ts % tfSeconds)`).
- **Chart last-candle dupes.** TradingView Lightweight's `series.update()` requires increasing timestamps; if you `update()` with a ts equal to the current bar, it updates it (correct). New bar needs a larger ts.
- **Volume pane styling.** Use a second series with `priceScaleId: ''` and an independent price scale; style it much shorter than the main pane.
- **Reconnect storm.** If the WS reconnects faster than backfill completes, backfill can race. Serialize: backfill first, *then* start the WS.
- **Pixel fonts in chart crosshair.** VT323 is set in chart `fontFamily`, but the crosshair labels also need it. Test visually.
- **Scrolling trade tape jitter.** Virtualize only if perf is bad; for 50 rows, direct render is fine.
- **Paper order price accuracy.** Use the server's latest `candles_1m.c` for fill price — NOT the browser's last known price (prevents client-clock skew).

---

## Phase 3 — Non-Crypto Trading Tabs

### Goal

Replicate the trading UI for Metals (XAU/USD, XAG/USD), Commodities (WTI), and Stocks (10 tickers). No orderbook (free APIs don't give L2). Polling-based collectors. Market-hours aware. Paper orders route via the same stub endpoint, mapping display symbols to tradeable ETF proxies where applicable.

### 3.1 — Market-hours helper

**File:** `apps/server/src/util/market-hours.ts`

Exports:
```ts
type MarketType = 'us_equities' | 'forex' | 'crypto' | 'commodities_futures';

isMarketOpen(type: MarketType, at: Date = new Date()): boolean;
nextOpen(type: MarketType, after: Date = new Date()): Date;
```

Behavior:
- **US equities:** Mon–Fri, 09:30–16:00 America/New_York. Respect holidays — hardcode US market holidays for the current year in `src/data/us-market-holidays.json`. Stretch: compute 3-day-weekend holidays like Memorial Day programmatically.
- **Forex (gold/silver spot):** Sun 22:00 UTC → Fri 22:00 UTC (roughly). Close briefly at daily roll.
- **Crypto:** always open.
- **Commodities futures:** for WTI via CME Globex, similar 24/5 window. Keep simple: treat as forex for now.

Pollers must check this before fetching — otherwise you burn free-tier quota on flat data.

### 3.2 — Twelve Data collector

**File:** `apps/server/src/collectors/stocks/twelvedata.ts`

Responsibilities:
- For each enabled asset of type `stock`, `commodity`, or `forex`, poll `/time_series?symbol={sym}&interval=1min&outputsize=1` every 60s during that market's open hours.
- On first run, backfill ~30 days of 1m via `/time_series?interval=1min&outputsize=5000` (two pages if needed).
- Upsert into `candles_1m`, emit `PriceCandleEvent`.
- Rate limiter: 6/min (free tier is 8/min; leave headroom).
- Free-tier daily cap is 800 — monitor usage via the API's `api_usage` endpoint, log warnings at 70%, back off at 90%.

### 3.3 — Finnhub collector (complement)

**File:** `apps/server/src/collectors/stocks/finnhub.ts`

Two uses in Phase 3:
1. **Stock news** (for Phase 5 — scaffolding now): `/company-news?symbol={sym}&from=...&to=...` every 5 min during market hours. (In Phase 5 we display; here we set up the poller so data accumulates.)
2. **Real-time quote fallback** when Twelve Data is rate-limited: `/quote?symbol={sym}`. Used only as a safety net — don't poll continuously.

### 3.4 — Yahoo collector (keyless fallback)

**File:** `apps/server/src/collectors/stocks/yahoo.ts`

Uses `yahoo-finance2` library.

Poll `^VIX`, `DX-Y.NYB`, and any asset missing data from Twelve Data. Also useful for weekends/after-hours snapshots. Every 5 min. Unreliable — don't depend on it as primary. Only emit events when the value actually changes (avoid spam).

### 3.5 — Aggregation cron

Same pattern as §2.2 for crypto: every hour, recompute `candles_3m` … `candles_1w` for all non-crypto assets from `candles_1m`.

### 3.6 — Scheduler wiring

**File:** `apps/server/src/jobs/scheduler.ts`

Uses `node-cron`. Registers:
- `*/1 * * * *` — poll Twelve Data for open markets.
- `*/5 * * * *` — poll Finnhub news (storage only for now), Yahoo snapshots.
- `0 * * * *` — run aggregation for all non-crypto assets.
- `*/30 * * * *` — log free-tier usage summary (helps us notice before we hit caps).

### 3.7 — Frontend: per-asset-class pages

Reuse **every** component from Phase 2 — AssetList, Chart, TimeframeSwitcher, MarketStats, OrderEntry. Exceptions:
- **No orderbook** for non-crypto. Leave that column blank or use it for an alternative panel (e.g. a placeholder for "Macro context" filled in Phase 7).
- **No recent trades tape** for non-crypto (no tick feed). Replace with a "Last 20 minute bars" mini-table.

**Pages:**
- `app/trading/metals/page.tsx` — filters assets to `type IN ('commodity') AND metadata.category = 'metal'` (or similar). Two assets: XAU/USD, XAG/USD.
- `app/trading/commodities/page.tsx` — one asset: WTI.
- `app/trading/stocks/page.tsx` — 10 tickers.

### 3.8 — Display → tradeable mapping

When user places a paper order on `XAU/USD` (display), the order is recorded against `GLD` (tradeable proxy) in the `orders.asset_id` column. The UI's OrderEntry component reads `tradeable_via` + `tradeable_symbol` from the asset and:
- If `tradeable_via === 'alpaca'`, show a small annotation: *"Will trade GLD (paper) as proxy for XAU/USD"*.
- If `tradeable_via === null`, disable order entry with tooltip: *"Display-only asset."*

Backend `POST /api/orders` resolves the proxy:
```ts
const target = asset.tradeable_symbol
  ? await getAssetBySymbol(asset.tradeable_symbol)
  : asset;
// Create order against target.id
```

Add GLD/SLV/USO to `assets` table as type=`etf`, tradeable_via=`alpaca`, tradeable_symbol=null. Seed from `commodity_watchlist.json` (include both display and proxy rows).

### 3.9 — Exit criteria (Phase 3)

- [ ] Metals, Commodities, Stocks tabs render with the same trading UI, no orderbook, no trades tape.
- [ ] Live prices update during market hours for all 14 assets (2 metals, 1 commodity, 10 stocks + 1 XAU, 1 XAG, 1 WTI display).
- [ ] Twelve Data usage stays under 70% of the 800/day cap over a full trading day.
- [ ] During closed hours (e.g. Saturday for stocks), no polling occurs — logs go quiet. Charts still render last-available data.
- [ ] Backfill completes for all 10 stocks + 3 commodities (~30 days of 1m candles each).
- [ ] Aggregation cron runs on the hour without errors; higher timeframes query quickly.
- [ ] Placing a paper order on XAU/USD creates an `orders` row against GLD (proxy resolved).
- [ ] Placing a paper order on AAPL creates an `orders` row directly on AAPL.
- [ ] Yahoo fallback kicks in correctly when we disable Twelve Data (simulate by temporarily revoking the key) — UI still shows prices with a "FALLBACK" indicator.
- [ ] No 429 responses from Twelve Data over a 24h soak test.
- [ ] Commit: `Phase 3: non-crypto trading tabs`. Tag `v3.0`.
- [ ] `STATUS.md` updated.

### 3.10 — Phase 3 pitfalls

- **Twelve Data symbol formatting.** Forex pairs use `/` (`XAU/USD`); stocks are bare (`AAPL`); commodities are ticker-like (`WTI/USD`). Normalizer must handle both URL-encoding and display.
- **Holiday calendar drift.** The hardcoded US holidays calendar must be updated yearly. Add an alert in `STATUS.md` notes or a Phase 8 alert rule to remind you each December.
- **Free-tier quota reset.** Twelve Data resets at UTC 00:00. Your dashboard may appear dead at that exact time if you burned your daily budget. Spread: don't poll all 14 assets at exactly `:00`; stagger (`:00`, `:05`, `:10`, ...) with a per-asset offset.
- **Alpaca paper "real" API calls.** Even though we're not using Alpaca execution until Phase 9, if you test `probe-alpaca.ts` repeatedly you can burn paper-account rate limits. Throttle.
- **Weekend data for forex.** Forex gaps over weekends. Chart UI should handle missing-data gaps gracefully — TradingView Lightweight does by default if you don't insert phantom rows.
- **Currency inconsistency.** `XAU/USD` is gold price in USD/oz, `GLD` ETF is ~1/10 of spot. Never compute PnL across the two as if they're the same instrument.
- **Extended hours.** US equities have pre-market (4:00–9:30 ET) and after-hours (16:00–20:00 ET). Default to RTH-only (9:30–16:00) for simplicity; revisit if user asks.

---

## Handoff to Part 3

When all Phase 3 exit criteria are green, open [IMPL-3-INTELLIGENCE.md](IMPL-3-INTELLIGENCE.md). Part 3 assumes:

- All 4 trading tabs functional with live charts, paper orders working.
- Historical candles populated across timeframes for every asset.
- `PriceCandleEvent`, `TradeTickEvent`, `OrderbookEvent` types in `@cockpit/shared`.
- Event bus carrying candle events; SSE delivering them to frontend.
- Scheduler running; aggregation cron in place — Part 3 adds more cron jobs on the same scheduler.
- Finnhub already configured; Part 3 uses it for news.
- Settings page functional for adding keys — Part 3 lights up Etherscan, Helius, CryptoPanic, FRED.
- `ignore_addresses` table exists (empty); Part 3 populates the seed in Phase 4.

**Commit `STATUS.md` with Part 2 marked done** before moving on.

---

**End of Part 2.**
