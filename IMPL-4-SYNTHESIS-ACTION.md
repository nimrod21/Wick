# IMPL Part 4 — Synthesis & Action (Phases 7 + 8 + 9 + 10)

> **Prerequisite:** Read [PLAN.md](PLAN.md) first. Parts 1 + 2 + 3 must be complete and committed — backbone, trading tabs, and full intelligence layer (whales + news + indicators) all live.

**Covers:**
- **Phase 7** — Dashboard + Probability Engine (~2 weeks)
- **Phase 8** — Alerts (~1–2 weeks)
- **Phase 9** — Execution (Paper) (~2 weeks)
- **Phase 10** — Execution (Live Crypto, optional) (~1 week)

**At the end of this part you will have:**
- Dashboard `/` page unifying macro strip + probability scores + event firehose + mini-chart grid.
- Rule-based probability engine producing per-asset bullish% scores for 1h/4h/24h, with recorded history.
- Alert engine with DSL-based rules, browser notifications, firing history.
- Real order-manager + risk-guards enforcing policies from [PLAN.md §13](PLAN.md#13-execution-module-design).
- Paper execution fully functional for all asset types via ccxt (crypto) and Alpaca paper (stocks/ETFs).
- Optional live-crypto toggle with double-confirmation workflow.
- A complete, demonstrable Trading Cockpit that the future bots can plug into.

---

## Ground rules for this part

- **Phase 7 retires the Phase 2/3 stub** `POST /api/orders` implementation and replaces it with the full order-manager path from Phase 9. Phase 7–8 can continue using the stub; Phase 9 is when it's cut over.
- **Live keys are NEVER added in code.** Only via `/settings` page after the user manually creates them.
- **Phase 10 is optional** — if the user doesn't want live trading ever, skip cleanly. The paper stack is production-complete on its own.

---

## Phase 7 — Dashboard + Probability Engine

### Goal

Unified `/` page with macro strip, per-asset probability scores, live event firehose, mini-chart grid. Rule-based probability engine writing history that future bots will train on.

### 7.1 — Probability engine core

**File:** `apps/server/src/core/probability-engine.ts`

**Signals (starting set):**

| Signal | Source | Normalization |
|---|---|---|
| `fear_greed_level` | `indicator_readings.fng_crypto` latest | `(50 - value) / 50` — extreme fear = +1 (contrarian bullish), extreme greed = -1 |
| `fear_greed_delta` | FNG change over 24h | `tanh(delta / 10)` |
| `dxy_trend` | 7-day slope of `dxy` | `-tanh(slope / 0.5)` — rising dollar = bearish for risk assets |
| `vix_level` | `vix` latest | `-(value - 20) / 20` clamped to -1..+1 — high VIX = bearish |
| `funding_rate` | `funding_{ASSET}` | `-tanh(value * 10000)` — positive funding = overheated = bearish |
| `open_interest_delta` | 1h change in `oi_{ASSET}` | `tanh(delta_pct / 10)` |
| `btc_dominance_trend` | 24h slope of `btc_dominance` | per-asset: for BTC +tanh, for alts -tanh |
| `whale_netflow_to_exchanges` | Sum of last 24h whale_tx where counterpart ∈ ignore_addresses | `-tanh(netflowUsd / 10_000_000)` — outflow from whales to exchanges = bearish |
| `news_sentiment_aggregate` | Avg sentiment of news events tagged with asset in last 6h | raw `-1..+1`, weighted by recency |
| `price_momentum_1h` | `(c_now - c_1h_ago) / c_1h_ago` | `tanh(change_pct * 5)` |
| `price_momentum_24h` | Same over 24h | `tanh(change_pct * 2)` |

**Weights config:** `apps/server/src/seed/probability_weights.json`
```json
{
  "fear_greed_level":            0.8,
  "fear_greed_delta":            0.5,
  "dxy_trend":                   0.6,
  "vix_level":                   0.5,
  "funding_rate":                0.7,
  "open_interest_delta":         0.4,
  "btc_dominance_trend":         0.5,
  "whale_netflow_to_exchanges":  0.9,
  "news_sentiment_aggregate":    0.7,
  "price_momentum_1h":           0.6,
  "price_momentum_24h":          0.4
}
```

Hot-reload on file change via `fs.watch`; log "weights reloaded" on change. Avoid requiring server restart.

**Algorithm per asset:**
```ts
function computeScore(assetId, horizon) {
  const signals = readAllSignals(assetId, horizon);   // -1..+1 each
  const weightedSum = sum(s.value * s.weight for s in signals) / sum(s.weight for s in signals);
  const bullishProb = sigmoid(weightedSum * 2);        // map weightedSum to 0..1
  const confidence = computeConfidence(signals);       // 0..1 based on agreement + freshness
  return { assetId, horizon, bullishProb, confidence, contributingSignals: signals };
}
```

Confidence formula:
- Staleness penalty: each signal older than X minutes drops confidence.
- Agreement bonus: if signals all point same direction, confidence high; conflicting signals drop it.
- `confidence = stalenessFactor × agreementFactor` where both are 0..1.

**Cron:** `* * * * *` (every 1 min). For each enabled watchlist asset × `['1h','4h','24h']`, run `computeScore`, insert into `probability_history`, insert per-signal rows into `signal_readings`. Emit a custom event on the bus (`kind: 'probability'`) so the UI can subscribe.

**Extend Event type:**
```ts
export type ProbabilityEvent = BaseEvent & {
  kind: 'probability';
  assetId: AssetId;
  horizon: '1h' | '4h' | '24h';
  bullishProb: number;
  confidence: number;
  contributingSignals: SignalReading[];
};
```

Add to the `Event` union.

### 7.2 — Backend API for probability

**`apps/server/src/api/probability.ts`:**

- `GET /api/probability?assetId&horizon` — latest score.
- `GET /api/probability/history?assetId&horizon&from&to&limit` — history.
- `GET /api/probability/signals?assetId&horizon` — signals breakdown with raw values.
- `GET /api/probability/weights` — current weights JSON.
- `PUT /api/probability/weights` — update weights (validated; writes to `seed/probability_weights.json`; hot reloads).

### 7.3 — Dashboard page UI

Layout (full width, scanlines overlay, pixel 80s throughout):

```
┌───────────────────────────────────────────────────────────────────────┐
│  MACRO STRIP                                                           │
│  [F&G: 64 GREED]  [DXY: 103.2 ↓]  [VIX: 18.5 ↓]  [BTC.D: 52.1% →]     │
├────────────────────────────────────────────────┬──────────────────────┤
│                                                 │                       │
│  PROBABILITY GRID                               │  EVENT FIREHOSE       │
│  ─────────────────                              │  ─────────────        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐         │  [ALL] [WHALES]       │
│  │ BTC      │ │ ETH      │ │ SOL      │         │  [NEWS] [PROB]        │
│  │ 1h:  58% │ │ 1h:  52% │ │ 1h:  61% │         │  ───────────          │
│  │ 4h:  55% │ │ 4h:  49% │ │ 4h:  57% │         │  ● 2m    whale out    │
│  │ 24h: 60% │ │ 24h: 51% │ │ 24h: 55% │         │    vitalik → Kraken   │
│  │ ▓▓▓▓░░   │ │ ▓▓▓▓▓░   │ │ ▓▓▓▓▓▓   │         │    100 ETH $370K      │
│  │ conf: 72%│ │ conf: 61%│ │ conf: 80%│         │                        │
│  └──────────┘ └──────────┘ └──────────┘         │  ● 5m    news +0.6     │
│  ...                                            │    Bitcoin surges...   │
│                                                 │                        │
│  MINI CHART GRID                                │  ● 8m    prob BTC↑     │
│  ───────────────                                │    1h 58% (conf 72%)   │
│  [BTC]  [ETH]  [SOL]  [BNB]  ← 24h sparklines   │                        │
│  [XRP]  [ADA]  [LTC]                            │                        │
│  [GLD]  [SLV]  [USO]                            │                        │
│  [SPY?] [NVDA] ...                              │                        │
└────────────────────────────────────────────────┴──────────────────────┘
```

**Components:**
- `components/dashboard/MacroStrip.tsx` — reads latest from `/api/indicators`. 4–6 key indicators with arrow direction, color-coded.
- `components/dashboard/ProbabilityCard.tsx` — one per asset. Shows bullish% bars for 1h/4h/24h, confidence, click → modal with contributing signals breakdown and small chart of probability history.
- `components/dashboard/EventFirehose.tsx` — subscribes `useEventStream(['whale_tx','news','indicator','probability','alert'])`. Filter pills. Color-coded rows. Virtualized list.
- `components/dashboard/MiniChartGrid.tsx` — sparkline per asset (24h of `candles_1h.c`). Click → navigate to that asset's trading tab.
- `components/dashboard/WeightsEditor.tsx` — modal on the Probability card, letting user tune weights with sliders. Saves to `/api/probability/weights`.

### 7.4 — Phase 7 exit criteria

- [ ] Probability engine runs every minute; `probability_history` grows.
- [ ] Each asset has scores for all three horizons.
- [ ] `signal_readings` rows indicate why scores moved.
- [ ] Dashboard `/` renders all sections with real data.
- [ ] Clicking a ProbabilityCard shows signal breakdown.
- [ ] Event firehose flows with real events from all sources, filterable.
- [ ] Mini chart grid links correctly to trading tabs.
- [ ] WeightsEditor updates weights; scores recompute within a minute with new weights.
- [ ] Probability engine survives restart cleanly.
- [ ] Commit: `Phase 7: dashboard + probability engine`. Tag `v7.0`.
- [ ] `STATUS.md` updated.

### 7.5 — Phase 7 pitfalls

- **Signal staleness.** If a signal hasn't updated in >1 hour (e.g. F&G fetched every 30 min but API was down), confidence should reflect that. Don't silently use stale data with full weight.
- **Sigmoid sensitivity.** With 11 signals, raw weighted sum can swing hard. `sigmoid(sum * 2)` is a good default; adjust the `2` multiplier if probabilities cluster at 0.5 or at extremes. Start conservative.
- **Asset-specific signals.** `btc_dominance_trend` is bullish for BTC but bearish for alts. Don't apply the same sign universally — implement per-asset signal mapping.
- **Missing signals.** Not every asset has every signal (e.g. GLD doesn't have funding rates). Skip missing signals; don't default to 0 (which would drag toward neutral).
- **Weights file races.** If user edits weights while the cron is running, a partial-read could produce garbage. Read atomically: read-once at start of each cron tick, don't re-read mid-computation.
- **UI re-render storms.** Every 1 min, 20+ assets emit probability events. Batch UI updates with Zustand's `shallow` compare, avoid re-rendering unchanged cards.

---

## Phase 8 — Alerts

### Goal

User-defined alert rules firing on event-bus activity. Browser notification delivery, firing history, cooldown respected.

### 8.1 — Alert engine core

**File:** `apps/server/src/core/alert-engine.ts`

Subscribes to event bus. On each event, iterates **enabled** rules, tests condition match.

**Condition evaluators:**

```ts
function matchesCondition(rule: AlertRule, event: Event): boolean {
  const c = rule.condition;
  switch (c.type) {
    case 'price_move': {
      if (event.kind !== 'candle' || event.assetId !== c.assetId) return false;
      const priceNowVsWindow = computePriceMoveOver(c.assetId, c.windowSeconds);
      return matchDirectional(priceNowVsWindow, c.pctChange, c.direction);
    }
    case 'price_level': {
      if (event.kind !== 'candle' || event.assetId !== c.assetId) return false;
      return compareOp(event.c, c.operator, c.value);
    }
    case 'whale_tx': {
      if (event.kind !== 'whale_tx') return false;
      if (c.chain && event.chain !== c.chain) return false;
      if (event.usdValue < c.minUsd) return false;
      if (c.direction && c.direction !== 'either' && event.direction !== c.direction) return false;
      if (c.addressFilter?.length && !c.addressFilter.includes(event.address)) return false;
      return true;
    }
    case 'news': {
      if (event.kind !== 'news') return false;
      if (c.tickers?.length && !event.tickers.some(t => c.tickers!.includes(t))) return false;
      if (c.minSentimentAbs != null && Math.abs(event.sentiment ?? 0) < c.minSentimentAbs) return false;
      if (c.keywordsAny?.length && !c.keywordsAny.some(k => event.title.toLowerCase().includes(k.toLowerCase()))) return false;
      if (c.keywordsAll?.length && !c.keywordsAll.every(k => event.title.toLowerCase().includes(k.toLowerCase()))) return false;
      return true;
    }
    case 'indicator_level': {
      if (event.kind !== 'indicator' || event.name !== c.name) return false;
      return compareOp(event.value, c.operator, c.value);
    }
    case 'indicator_cross': {
      if (event.kind !== 'indicator' || event.name !== c.name) return false;
      const prev = event.previous;
      if (prev == null) return false;
      return (c.direction === 'up'   && prev < c.threshold && event.value >= c.threshold)
          || (c.direction === 'down' && prev > c.threshold && event.value <= c.threshold);
    }
    case 'probability': {
      if (event.kind !== 'probability' || event.assetId !== c.assetId) return false;
      if (event.horizon !== c.horizon) return false;
      return compareOp(event.bullishProb, c.operator, c.value);
    }
  }
}
```

**Cooldown:** before firing, check `rule.last_fired_ts + rule.cooldown_seconds >= now`. If so, skip.

**On fire:**
1. Emit `AlertEvent` onto bus (which SSE pushes to frontend).
2. Insert row into `alert_firings`.
3. Update `alert_rules.last_fired_ts`.
4. If `channels` includes `telegram` — defer (Phase 8.5 is later; browser only for MVP).

### 8.2 — Backend API for alerts

**`apps/server/src/api/alerts.ts`:**

- `GET /api/alerts` — list all rules.
- `POST /api/alerts` — create: `{ name, condition, channels, cooldown_seconds }`. Validate with Zod (condition DSL from [PLAN.md §14](PLAN.md#14-alert-system-design)).
- `PATCH /api/alerts/:id` — update, toggle enabled.
- `DELETE /api/alerts/:id`.
- `GET /api/alerts/firings?ruleId=&limit=&before=` — history.

### 8.3 — `/alerts` page UI

Layout:
```
┌───────────────────────────────────────────────────────────────┐
│  ALERTS                          [+ NEW RULE]                   │
├───────────────────────────────┬───────────────────────────────┤
│  Rules                         │  Firing History                │
│  ─────                         │  ──────────────                │
│  [ENABLED] BTC 5% drop 1h ✏️   │  ● 3m   BTC 5% drop 1h         │
│  [ENABLED] Whale >$1M          │    BTC -5.2% in 58m            │
│  [DISABLED] News: hack         │                                 │
│  ...                           │  ● 12m  Whale >$1M              │
│                                │    Binance 14 → exchange        │
│                                │    $3.2M USDT out               │
│                                │                                 │
│                                │  ...                            │
└───────────────────────────────┴───────────────────────────────┘
```

**Components:**
- `components/alerts/RuleList.tsx` — list, each row has toggle, edit, delete. Row color: enabled = neon cyan border; disabled = dim.
- `components/alerts/RuleBuilder.tsx` — modal for create/edit. Form fields depend on condition type selection. Per-type sub-forms:
  - `price_move`: asset select, pct input, window select (5m/15m/1h/4h), direction.
  - `price_level`: asset select, operator, value.
  - `whale_tx`: chain select, min USD, direction, optional address filter (multiselect from whale watchlist).
  - `news`: keywords any/all, tickers multiselect, min sentiment abs.
  - `indicator_level` / `indicator_cross`: indicator name select, value, direction.
  - `probability`: asset select, horizon, operator, value.
- `components/alerts/FiringHistory.tsx` — paginated feed of `alert_firings` with filter by rule. Click → detail drawer.

### 8.4 — Browser notifications

**`apps/web/lib/notifications.ts`:**

```ts
export function initNotifications() {
  if ('Notification' in window && Notification.permission === 'default') {
    // Prompt on first alert page visit, not page load
  }
}

export function notify(title: string, body: string, icon?: string) {
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon, tag: 'cockpit-alert', silent: false });
  }
}
```

Hook in dashboard + alerts page: `useEventStream(['alert'])` → on each alert event, call `notify(ruleName, summary)`.

Permission prompt UI: first visit to `/alerts`, show a banner "Enable browser notifications?" with a button. Don't auto-prompt on page load (annoying).

### 8.5 — Telegram (deferred, skeleton only)

Leave structural room: `channels_json` array already includes `telegram`. Telegram delivery implementation is postponed per Luka's decision — don't build now. Add a TODO note in `STATUS.md`.

### 8.6 — Phase 8 exit criteria

- [ ] Create 5 test rules covering different condition types.
- [ ] Each fires reliably when its condition is triggered (verify with synthetic data — send a mock event via a test endpoint if needed).
- [ ] Cooldown respected — fire once, then no refire within cooldown window.
- [ ] `alert_firings` table accumulates rows.
- [ ] Browser notification appears on each fire (after permission granted).
- [ ] `/alerts` page: create, edit, toggle, delete rules all work.
- [ ] Firing history displays correctly.
- [ ] Commit: `Phase 8: alerts`. Tag `v8.0`.
- [ ] `STATUS.md` updated.

### 8.7 — Phase 8 pitfalls

- **Condition evaluation hot path.** Alert engine runs on **every** event. For 1000+ events/hour and 50+ rules, that's 50k+ evaluations/hour. Keep matchers branchless and avoid SQL queries in matchers — precompute `price_move` windows separately.
- **`price_move` windowing.** To compute "BTC dropped 5% in 1h", don't query the DB on every candle event. Maintain an in-memory rolling window of last N candles per asset, updated on each candle event, queried by matchers.
- **Stale `previous` for `indicator_cross`.** When the server restarts, `previous` is lost. Either hydrate from `indicator_readings` at startup, or skip `indicator_cross` matching for the first event after restart.
- **Notification spam.** Even with cooldowns, firing 20 alerts at once (e.g. market crash triggers many rules) floods the user. Add a global rate limit (max 10 notifications/min) client-side.
- **Timezone in firing history.** UTC in DB, local time in UI. Don't forget.
- **Permissions denied.** If user denies notifications, gracefully degrade — show in-app toast instead, don't keep asking.

---

## Phase 9 — Execution (Paper)

### Goal

Robust order-manager replaces Phase 2's stub. Same interface as future live. Risk guards enforced on every order. ccxt (Binance, shimmed to paper) and Alpaca paper adapters functional.

### 9.1 — Broker interface + paper-mode broker

**File:** `apps/server/src/execution/paper-mode.ts`

Implements the `Broker` interface from [PLAN.md §13](PLAN.md#13-execution-module-design):

```ts
class PaperBroker implements Broker {
  placeOrder(req: PlaceOrderRequest): Promise<Order> {
    // 1. Generate clientOrderId (UUID v7 or `${assetId}-${ts}-${rand}`)
    // 2. Insert orders row status='pending'
    // 3. Simulate fill:
    //    - market: instant at latest candles_1m.c for asset
    //    - limit:  leave pending; fill loop scans candles_1m for crossings
    //    - stop:   leave pending until stop triggers then market-fill
    // 4. Fee simulation: 0.1% crypto taker, 0% stocks
    // 5. Update positions row (create or adjust qty + avg_entry_price)
    // 6. Emit a synthetic fill_tick event
  }
  cancelOrder, getOrder, listOpenOrders, getPositions, getAccountBalance
}
```

**Fill-scan loop:** cron `*/5 * * * * *` (every 5s). For each `status='pending'` limit/stop order:
- Load asset's most recent `candles_1m.c`, `.h`, `.l`.
- Limit buy: fill if `.l <= limit_price`.
- Limit sell: fill if `.h >= limit_price`.
- Stop buy: if `.h >= stop_price`, mark triggered → convert to market fill at next candle.
- Stop sell: if `.l <= stop_price`, same.

**Starting balance:** paper accounts start with $100,000 cash (per broker). Stored in `kv['paper_balance_crypto']` and `kv['paper_balance_stocks']`.

### 9.2 — ccxt crypto adapter

**File:** `apps/server/src/execution/crypto-ccxt.ts`

Initially in **shimmed paper mode** — verifies that keys work (read-only calls like `fetchBalance` go to Binance), but all `placeOrder` calls route to `PaperBroker`. This lets us test key management and connection without risking any money.

When `kv['trading_mode'] === 'live'`, `placeOrder` actually calls `binance.createOrder(...)` via ccxt. Reserve that path for Phase 10.

Essential methods wrapped around ccxt's Binance client:
- `fetchBalance()` — verify keys.
- `fetchOpenOrders(symbol)` — reconcile local state.
- `createOrder(symbol, type, side, amount, price?)` — only if `trading_mode === 'live'`.
- `cancelOrder(id, symbol)`.

### 9.3 — Alpaca adapter

**File:** `apps/server/src/execution/stocks-alpaca.ts`

Uses `@alpacahq/alpaca-trade-api`. Points to paper endpoint (`https://paper-api.alpaca.markets`).

Methods:
- `getAccount()` — verify keys.
- `createOrder({ symbol, qty, side, type, time_in_force: 'day', limit_price? })` — real paper orders against Alpaca's paper exchange.
- `listOrders({ status: 'open' })`.
- `cancelOrder(orderId)`.
- `getPositions()`.

WebSocket fills: subscribe to Alpaca's `trade_updates` stream for real-time fill notifications on paper orders. On `fill` event, update local `orders` + `positions`.

### 9.4 — Order manager

**File:** `apps/server/src/execution/order-manager.ts`

Central coordinator. Routes requests to the right broker per asset type:
- `asset.tradeable_via === 'ccxt'` → ccxt adapter (paper-shimmed or live).
- `asset.tradeable_via === 'alpaca'` → Alpaca paper.
- `asset.tradeable_via === null` → reject ("display-only asset").

Responsibilities:
1. Validate request (Zod).
2. Resolve asset + tradeable proxy (as in Phase 3.8).
3. Enforce risk guards (§9.5) — reject if any fails.
4. Generate idempotent `clientOrderId`.
5. Delegate to broker.
6. Persist to `orders` table; start watcher for status transitions.
7. Emit `order_created` / `order_filled` / `order_cancelled` events on bus.

Public API: `placeOrder`, `cancelOrder`, `listOrders`, `getOrder`, `getPositions`. Consumed by `api/orders.ts` endpoint and (future) trading bot.

### 9.5 — Risk guards

**File:** `apps/server/src/execution/risk-guards.ts`

Enforces all 6 policies from [PLAN.md §13](PLAN.md#13-execution-module-design):

```ts
async function guard(req: PlaceOrderRequest): Promise<GuardResult> {
  // 1. Kill switch
  if (getKv('kill_switch') === 'true') return fail('kill_switch_active');

  // 2. Per-order max notional
  const maxNotional = Number(getKv('max_order_notional') ?? '500');
  const notional = req.qty * await lastClose(req.assetId);
  if (notional > maxNotional) return fail('notional_exceeds_max', { notional, maxNotional });

  // 3. Max open positions per asset
  const openPositions = await countOpenPositions(req.assetId);
  const maxOpen = Number(getKv('max_open_positions_per_asset') ?? '1');
  if (req.side === 'buy' && openPositions >= maxOpen) return fail('max_positions_exceeded');

  // 4. Daily loss cap
  const todaysPnL = await todaysRealizedAndUnrealizedPnL();
  const cap = Number(getKv('daily_loss_cap') ?? '-1000');
  if (todaysPnL <= cap) return fail('daily_loss_cap_reached', { todaysPnL, cap });

  // 5. Order cooldown per asset
  const lastOrder = await lastOrderForAsset(req.assetId);
  const cooldown = Number(getKv('order_cooldown_seconds') ?? '10');
  if (lastOrder && (Date.now() / 1000 - lastOrder.created_at) < cooldown) return fail('cooldown_active');

  // 6. Confirmation flag (set by frontend modal)
  if (!req.confirmed) return fail('confirmation_required');

  return { ok: true };
}
```

Settings page surfaces all these knobs: kill switch (toggle), max notional (input), max open positions, daily loss cap, cooldown seconds.

### 9.6 — Order-entry UI upgrades

**`components/trading/OrderEntry.tsx`** extends Phase 2's version:
- Confirmation modal: shows full request (asset, side, qty, notional, broker route), warnings from risk guards, "CONFIRM" button with 2-second disable on open.
- On guard failure, surfaces which guard blocked (e.g. "BLOCKED: notional $650 exceeds max $500").
- Open orders panel: list with cancel button per order.
- Positions panel: list with current unrealized PnL.
- Account balance header: "Paper Crypto: $99,450 · Paper Stocks: $100,200".

### 9.7 — Cut over Phase 2 stub

Replace `apps/server/src/api/orders.ts` implementation (the Phase 2 shortcut) with delegation to `OrderManager`. Ensure no tests or UI paths still hit the stub directly.

### 9.8 — Phase 9 exit criteria

- [ ] Paper orders place & fill correctly for all asset types (crypto, stock, metal proxy, commodity proxy).
- [ ] Each risk guard demonstrably blocks an order when tripped:
  - Kill switch: toggle on → order rejected with `kill_switch_active`.
  - Max notional: $600 order with $500 max → rejected.
  - Daily loss cap: artificially set cap to $0, take a loss, next order rejected.
  - Cooldown: fire two orders 5s apart → second rejected.
  - Confirmation: direct API call without `confirmed: true` → rejected.
- [ ] Open orders + positions UI reflects real state.
- [ ] Unrealized PnL updates in real time as prices move.
- [ ] Cancelling a pending limit order works.
- [ ] Alpaca paper: place an order, see it appear in Alpaca's web dashboard, see fill via WS, local state synced.
- [ ] ccxt paper-shim: key verification works against Binance without any real trading.
- [ ] Server restart: open orders resume tracking, positions intact.
- [ ] Commit: `Phase 9: execution paper`. Tag `v9.0`.
- [ ] `STATUS.md` updated.

### 9.9 — Phase 9 pitfalls

- **Fill-price accuracy.** Paper market orders should fill at *next* 1m candle's close, not current (current is still forming). For test usability, fill at latest closed candle's close is acceptable — document the choice.
- **Partial fills not supported in paper mode.** Keep it simple. Alpaca paper may return partial fills — handle them by updating `filled_qty` incrementally.
- **Position accounting with multiple fills.** Weighted average entry price when adding to a position; realized PnL computed on closing fills only.
- **Fee simulation.** 0.1% maker/taker for crypto is Binance retail rate. Alpaca is commission-free for stocks in reality. Match reality.
- **Idempotent `clientOrderId`.** UUID v7 is ideal. If you retry a submission, the same ID means Alpaca/Binance reject duplicates — which is what you want.
- **Race on kill switch.** Check kill switch inside the transaction that inserts the order, not just at start of request handler.
- **Balance not enforced in paper.** Skipping balance checks makes testing easy. If desired, enforce a simple rule: reject if notional > balance * 2 (crude leverage limit).
- **Alpaca fractional shares.** Alpaca supports fractional for most stocks. Allow `qty` as float. But some ETFs don't support fractional — handle the API's rejection.
- **ccxt keys verified once.** Don't re-verify every order. Cache `last_verified_ok` in `api_keys` table; re-verify only on a daily cron or manual "Test" button.

---

## Phase 10 — Execution (Live Crypto, optional)

### Goal

Real crypto orders via Binance, behind a double-toggle. Complete all paper-mode guarantees carry over. If user doesn't want live trading ever, skip this phase cleanly.

### 10.1 — Live-mode toggle in Settings

**`/settings` page** gets a new section: **LIVE TRADING — DANGER ZONE**, styled in neon amber.

UI flow:
1. Initial state: "LIVE TRADING: DISABLED" with explainer text.
2. Click "ENABLE" → modal: "Type `ACTIVATE LIVE` below to confirm" + 5-second countdown before button enables.
3. On confirm: writes `kv['trading_mode'] = 'live'`.
4. Navbar changes: kill-switch button flashes red; mode indicator shows "LIVE" in bold amber.
5. Disable toggle always available, immediate.

### 10.2 — Binance live flow

In `crypto-ccxt.ts`, switch on `trading_mode`:
```ts
async placeOrder(req) {
  if (getKv('trading_mode') === 'live') {
    return await this.binance.createOrder(req.symbol, req.type, req.side, req.qty, req.price);
  } else {
    return await this.paperBroker.placeOrder(req);  // shimmed path
  }
}
```

### 10.3 — Key permissions verification

Before allowing live mode to activate, run a comprehensive check against Binance:
- `GET /sapi/v1/account/apiRestrictions` — confirm `enableSpotAndMarginTrading: true`, `enableWithdrawals: false`, IP restriction active.
- Refuse to activate live mode if any check fails. Show exact remediation ("Disable withdrawals on your API key and try again").

Stored in `api_keys.permissions_json`.

### 10.4 — Order status reconciliation

Poll loop: every 2s, for each `orders` row with status in `('submitted','partial')` on the ccxt broker, fetch status via `binance.fetchOrder(id, symbol)`. Update local row. Emit events on status changes.

On startup: fetch all open orders from Binance, merge with local DB (detect orphans in either direction).

### 10.5 — Additional guards for live

Live mode adds:
- **Maximum daily order count** (default 20) — prevents runaway bot in future.
- **Minimum time-between-live-orders-across-all-assets** (default 30s) — global cooldown on top of per-asset cooldown.
- **First-live-order requires per-asset re-confirmation** — even if user enabled live globally, first order on any given asset during a session requires another confirm click.

### 10.6 — Phase 10 exit criteria

- [ ] "Activate Live" workflow requires typed confirmation + 5s countdown.
- [ ] Key permissions check rejects keys with withdrawals enabled or no IP restriction.
- [ ] Small-notional live test order (e.g. $20 BTC buy) places on Binance, fills, appears in Binance's order history, local state matches.
- [ ] Kill switch immediately halts new live orders.
- [ ] Daily order count limit enforced.
- [ ] Global 30s cooldown enforced.
- [ ] First-per-asset confirm modal appears.
- [ ] Disabling live mode returns ccxt to paper shim; existing live positions remain tracked as positions.
- [ ] Server restart while in live mode: reconnects, reconciles open orders, continues.
- [ ] Commit: `Phase 10: execution live crypto`. Tag `v10.0`.
- [ ] `STATUS.md` updated — project COMPLETE.

### 10.7 — Phase 10 pitfalls

- **Real money real bugs.** Run on smallest-notional Binance allows for at least a week before trusting.
- **Binance min-notional.** Each pair has a minimum (e.g. $10 BTC). Reject orders below it with a clear error, not a cryptic API rejection.
- **Order status ambiguity.** Binance status codes: `NEW`, `PARTIALLY_FILLED`, `FILLED`, `CANCELED`, `EXPIRED`, `REJECTED`. Map cleanly to our enum.
- **Rate limits on trading API.** Different from data API. Binance spot: 50 orders/10s per user. Don't spam.
- **IP whitelisting.** If user's residential IP changes, orders start failing. Detect 401/403 on first order, warn clearly.
- **Time sync.** ccxt will reject orders with timestamps drifted more than 1 second from server. Use NTP-synced system time; if Windows clock is off, live trading will fail mysteriously.
- **Partial fills on limits.** Binance may partially fill and cancel (via `timeInForce: 'IOC'`). Handle the trailing status.
- **Cancel during fill.** A cancel request racing with a fill may return "order not found" — treat as success if our local status is `filled`, else retry.

---

## Handoff — Project Complete

At this point the Trading Cockpit fully realizes the scope in [PLAN.md §1](PLAN.md#1-mission--scope).

**What's live:**
- Real-time data for crypto, stocks, metals (proxies), commodities (proxies).
- Whale tracking on ETH/SOL/BTC.
- News aggregation with sentiment tagging.
- 11 macro/crypto indicators.
- Unified dashboard with rule-based probability engine.
- Full alert system with browser notifications.
- Paper execution for all asset types.
- Optional live crypto execution with hard guards.
- PM2-managed Windows service running 24/7.

**What's ready for future bots:**
- `packages/shared` exports all event types — bots subscribe to the same bus.
- `probability_history` + `signal_readings` tables accumulating ML training data.
- `events_price_snapshots` with 8 horizons per significant event — event-study-ready.
- `order-manager` interface stable — bots call `placeOrder` with the same contract as UI.
- Risk guards enforce the same rules for bots as for manual entry.

**Next steps when the AI-API budget arrives:**
1. **Analysis bot:** reads `events_price_snapshots` + `signal_readings`. Trains to replace the rule-based weights with learned weights. Writes back into `probability_history` under a different "model" tag for A/B comparison.
2. **Trading bot:** subscribes to probability events. On threshold crossings, calls `orderManager.placeOrder` with paper mode first. Gradually earns trust through paper performance metrics stored in `order_performance` (new table to add then).

**Final commits:**
- `STATUS.md`: all phases marked done.
- `project_cockpit_progress.md` in global memory: updated to "COMPLETE — bot-ready".
- Tag `v1.0.0-complete`.

---

**End of Part 4 — End of planning documents.**
