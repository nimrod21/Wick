# IMPL Part 3 — Intelligence Layer (Phases 4 + 5 + 6)

> **Prerequisite:** Read [PLAN.md](PLAN.md) first. Parts 1 + 2 ([IMPL-1-FOUNDATION.md](IMPL-1-FOUNDATION.md), [IMPL-2-TRADING.md](IMPL-2-TRADING.md)) must be complete and committed — backbone + all trading tabs live.

**Covers:**
- **Phase 4** — Whale Tracker (~2 weeks)
- **Phase 5** — News (~1–2 weeks)
- **Phase 6** — Indicators (~1–2 weeks)

**At the end of this part you will have:**
- 30–50 seeded whale addresses monitored across ETH, SOL, BTC, with exchange-noise filtered out.
- `/whales` page with chain subtabs, address manager, live tx stream.
- RSS + CryptoPanic + Finnhub news aggregated, deduplicated, tagged by ticker, basic sentiment scored.
- `/news` page with filters, detail drawer.
- Fear & Greed, DXY, VIX, funding rates, open interest, BTC dominance, FRED series all collecting.
- `/indicators` page with one panel per indicator showing current value + history chart.
- `events_price_snapshots` populating automatically — brain data accumulating in the background for future bots.

**Handoff to Part 4** at the bottom.

---

## Ground rules for this part

- **All three phases share the same event bus.** Whale txs, news items, and indicator changes all become `Event`s on the same stream, reducing the Dashboard work in Part 4 to a consumer problem.
- **Significance filtering for brain data** (from [PLAN.md §12](PLAN.md#12-brain-ready-data-plumbing)) must be active from Phase 4 forward. Every qualifying event schedules its 8 forward-price snapshots.
- **Commit per milestone** — at minimum: ignore-list seeded, each chain's collector working, tab UI rendering, and each indicator independently.

---

## Phase 4 — Whale Tracker

### Goal

Track ~30–50 curated whale addresses across ETH, SOL, BTC. Filter out exchange hot-wallet and contract noise. Display live tx stream per chain. Allow user to add/remove/label addresses via the `/whales` tab.

### 4.1 — Seed the whale + ignore address lists

**`apps/server/src/seed/whale_addresses.json`** — hand-curate. Mix of sources:
- Arkham public entity labels (https://platform.arkhamintelligence.com/explorer/entities)
- DefiLlama's known wallets
- Public Twitter spreadsheets (e.g. lookonchain, whale_alert)

Shape:
```json
[
  { "chain": "eth", "address": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045", "label": "vitalik.eth",         "tags": ["public","founder"] },
  { "chain": "eth", "address": "0x...",                                          "label": "Punk6529",          "tags": ["collector"] },
  { "chain": "sol", "address": "...",                                            "label": "Known SOL whale #1", "tags": ["trader"] },
  { "chain": "btc", "address": "bc1q...",                                        "label": "Satoshi candidate",  "tags": ["historic"] }
]
```

Target 15–20 per chain.

**`apps/server/src/seed/ignore_addresses.json`** — exchange hot wallets + bridges + large protocol contracts. This is **load-bearing** — skip it and every whale alert is garbage. Minimum viable set:

```json
[
  { "chain": "eth", "address": "0x28c6c06298d514db089934071355e5743bf21d60", "label": "Binance 14" },
  { "chain": "eth", "address": "0xdfd5293d8e347dfe59e90efd55b2956a1343963d", "label": "Binance 16" },
  { "chain": "eth", "address": "0x71660c4005ba85c37ccec55d0c4493e66fe775d3", "label": "Coinbase 1" },
  { "chain": "eth", "address": "0x503828976d22510aad0201ac7ec88293211d23da", "label": "Coinbase 2" },
  { "chain": "eth", "address": "0x2faf487a4414fe77e2327f0bf4ae2a264a776ad2", "label": "FTX (historical)" },
  { "chain": "eth", "address": "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43", "label": "Coinbase 10" },
  { "chain": "eth", "address": "0xdac17f958d2ee523a2206206994597c13d831ec7", "label": "Tether USDT contract" },
  { "chain": "eth", "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "label": "Circle USDC contract" }
]
```

Expand as the tracker observes noise. Make this editable via Settings (`ignore_addresses` CRUD REST endpoints).

### 4.2 — ETH whale collector (Etherscan)

**File:** `apps/server/src/collectors/onchain/eth-etherscan.ts`

Behavior:
1. Every 60s, for each enabled ETH whale:
   - `GET /api?module=account&action=txlist&address={addr}&startblock={lastCheckedBlock}&endblock=latest&sort=desc`
   - `GET /api?module=account&action=tokentx&address={addr}&startblock={lastCheckedBlock}`
   - Advance `whale_addresses.last_checked_block` after successful poll.
2. For each new tx:
   - Compute direction (`in` if `to === addr`, `out` if `from === addr`).
   - Resolve `counterpart` (the other side).
   - If counterpart is in `ignore_addresses`, discard.
   - Compute `usdValue`:
     - Native ETH: `amountEth × ethUsdPrice` (use Binance ETHUSDT latest close).
     - ERC-20: need token price — attempt CoinGecko (`/simple/token_price/ethereum?contract_addresses=...&vs_currencies=usd`) with a 10-min cache. If unresolved, skip USD-value and mark the event with `usdValue: null` and `severity: 20` (low, but still logged).
   - Dedup key: transaction hash + log index for ERC-20, just tx hash for native.
   - Insert into `events` with `kind = 'whale_tx'`, emit to bus, schedule snapshots if `usdValue >= 500_000` (the significance threshold from [PLAN.md §12](PLAN.md#12-brain-ready-data-plumbing)).
3. Rate limiter: 4/s (Etherscan free tier is 5/s; leave 20% headroom).
4. Handle Etherscan's rate-limit messages (`"result": "Max rate limit reached"`) — back off 2s and retry once.

### 4.3 — SOL whale collector (Helius)

**File:** `apps/server/src/collectors/onchain/sol-helius.ts`

Helius's **enhanced transactions** endpoint (`/v0/addresses/{address}/transactions?api-key={key}&limit=50&before={signature}`) returns parsed transfer data directly — much easier than raw Solana RPC.

Behavior:
1. Every 60s, for each enabled SOL whale, fetch recent transactions using `before` cursor stored in `last_checked_block` (reuse the column; store signature instead of a block number).
2. For each tx with a native SOL or SPL token transfer > threshold:
   - Compute direction + USD value (SOL price from Binance SOLUSDT; SPL tokens via Helius's parsed `nativeTransfers` and `tokenTransfers` fields + CoinGecko lookup with chain `solana`).
   - Same ignore-list filtering by address.
   - Same event emission + snapshot scheduling.
3. Rate limiter: Helius free tier is 10 req/sec, 100k/day — set limiter to 8/sec.

Fallback: if Helius key is missing, use public RPC `https://api.mainnet-beta.solana.com` with `getSignaturesForAddress` + `getParsedTransaction`. Much slower; mark whales collector as "degraded" in health.

### 4.4 — BTC whale collector (Blockstream)

**File:** `apps/server/src/collectors/onchain/btc-blockstream.ts`

No key required. Endpoints:
- `GET https://blockstream.info/api/address/{addr}/txs` — recent confirmed txs (up to 25 per page)
- `GET https://blockstream.info/api/address/{addr}/txs/mempool` — mempool txs
- `GET https://blockstream.info/api/tx/{txid}` — detail

Behavior:
1. Every 60s, for each enabled BTC whale, pull recent confirmed + mempool.
2. Parse vin/vout: compute net change for the address (sum outputs to addr − sum inputs from addr). Positive = incoming, negative = outgoing.
3. USD value: `btcAmount × btcUsdPrice` (Binance BTCUSDT latest).
4. Dedup by txid + address.
5. Rate limiter: 10/s (their servers are forgiving but be polite).

Note: Bitcoin's UTXO model makes "counterpart" ambiguous. For simplicity, list the top non-change output address as counterpart (or `null` for coinbase/consolidation txs).

### 4.5 — Backend API for whales

**`apps/server/src/api/whales.ts`:**

- `GET /api/whales` — list all whale addresses with labels, tags, chain, enabled status.
- `POST /api/whales` — add new address: `{ chain, address, label?, tags? }`. Validate chain-specific format.
- `PATCH /api/whales/:id` — update label/tags/enabled.
- `DELETE /api/whales/:id` — remove.
- `GET /api/whales/ignore` — list ignore addresses.
- `POST /api/whales/ignore`, `DELETE /api/whales/ignore/:chain/:address` — manage.
- `GET /api/whales/events?chain=&limit=&before=` — fetch recent `whale_tx` events with filters.

### 4.6 — `/whales` page UI

Layout:
```
┌───────────────────────────────────────────────────────────────┐
│  WHALE TRACKER         [ ETH | SOL | BTC ]    🔴 LIVE           │
├───────────────────────────────────────────────────────────────┤
│  Address Manager (left)         │  Live Tx Stream (right)      │
│  ───────────────────            │  ─────────────────            │
│  [+ ADD ADDRESS]                │  [ALL] [>$500K] [>$1M]       │
│  vitalik.eth      ✏️ 🗑️          │  ┌──────────────────────┐   │
│  Punk6529         ✏️ 🗑️          │  │ vitalik.eth          │   │
│  ...                            │  │ OUT 100 ETH → 0x123... │  │
│                                 │  │ ≈ $370,000  [+2m]      │  │
│  [MANAGE IGNORE LIST]           │  └──────────────────────┘   │
│                                 │  ...                         │
└───────────────────────────────────────────────────────────────┘
```

Components:
- **`components/whales/ChainTabs.tsx`** — ETH / SOL / BTC subnav, sticky.
- **`components/whales/AddressManager.tsx`** — list + add modal (chain, address, label, tags). Inline edit/delete. "Manage Ignore List" opens a similar modal.
- **`components/whales/LiveTxStream.tsx`** — subscribes via `useEventStream(['whale_tx'])` filtered to current chain. Renders rows with: label (or masked address if none), direction icon (↗️ / ↘️), token, amount, USD value (VT323 neon), counterpart (clickable, opens block explorer in new tab), relative time.
- **`components/whales/TxDetailDrawer.tsx`** — click a row → drawer with full payload JSON (pretty-printed), block explorer link, snapshots scheduled if any.

Threshold filter pills: ALL / >$100K / >$500K / >$1M / >$5M.

### 4.7 — Snapshot job activation

**File:** `apps/server/src/core/snapshot-job.ts`

Should already exist as a stub from Part 1; flesh it out here:

1. On normalizer insert of any significant event (§4.2, §4.3, §4.4 all call `maybeScheduleSnapshot`), insert 8 rows into `events_price_snapshots` — one per horizon from [PLAN.md §12](PLAN.md#12-brain-ready-data-plumbing) — with `captured_ts = NULL`.
2. Per-asset-snapshot is scoped to the event's `asset_id`; if the whale tx doesn't map to a specific asset, map it to a **chain-representative asset** (ETH tx → ETH asset, SOL tx → SOL, BTC tx → BTC). Document this convention in a code comment.
3. Cron `*/30 * * * * *` (every 30s): find snapshots where `captured_ts IS NULL AND (event_ts + horizon_seconds) <= now`. For each, read the latest `candles_1m.c` for the asset. Write `captured_ts`, `price`, and `pct_change = (price - event_price) / event_price`.
4. `event_price` = the asset's `candles_1m.c` at the moment the event was emitted — capture this eagerly when scheduling (store in a new column or in `payload_json`). Cleaner: add a column `event_price REAL` to `events_price_snapshots`.

**Migration to add if not already present:**
```sql
ALTER TABLE events_price_snapshots ADD COLUMN event_price REAL;
```

### 4.8 — Phase 4 exit criteria

- [ ] 30+ seeded addresses distributed across ETH/SOL/BTC, each collected at least once.
- [ ] `SELECT COUNT(*) FROM events WHERE kind='whale_tx'` grows over time (at least some events/hour during active periods).
- [ ] Ignore filter demonstrably reduces noise: run collector with vs. without the filter, compare event counts (expect ~70%+ drop).
- [ ] `/whales` tab: can add, edit, delete an address and see it reflected in next poll cycle.
- [ ] Live tx stream updates in real time without reload.
- [ ] Threshold filter pills work.
- [ ] Clicking a tx opens detail drawer with full payload; block-explorer link opens correct tx.
- [ ] Every significant whale_tx schedules 8 rows in `events_price_snapshots`.
- [ ] After the first 5 minutes elapse, at least some snapshots have `captured_ts IS NOT NULL`.
- [ ] Commit: `Phase 4: whale tracker`. Tag `v4.0`.
- [ ] `STATUS.md` updated.

### 4.9 — Phase 4 pitfalls

- **Address checksumming.** ETH addresses are case-insensitive but common display is EIP-55 checksummed. Normalize to lowercase in DB, display checksummed in UI.
- **ERC-20 token metadata.** `tokentx` returns token symbol, but for obscure tokens the CoinGecko price lookup will fail. Cache negative lookups (`null` for 24h) to avoid repeated failed API calls.
- **Solana versioned transactions.** Helius's parsed endpoint handles this; if you fall back to raw RPC, you'll need `getParsedTransaction` with `maxSupportedTransactionVersion: 0`.
- **BTC coinbase txs.** First output of a block has no input (block reward). Detect with `vin[0].is_coinbase === true` and mark as mining rather than discarding.
- **Counterpart heuristic is fuzzy.** Consolidation txs (10 inputs → 1 output for the same owner) show as "outgoing" to themselves. Filter where counterpart === address.
- **First poll floods events.** On first run, `startblock` defaults to 0 — you'd ingest years of history. On add-address, seed `last_checked_block` to "current block − 100" so you only capture going forward (display-only; avoid retroactive noise).
- **Token price drift.** Caching token prices for 10 min is fine for rough USD value. Don't treat these as accurate P&L — they're for alerting threshold only.
- **Snapshot cron missed fires.** If the server was down when a horizon elapsed, the job should still capture when it comes back (the query `event_ts + horizon <= now` will be true). But very old missed horizons (e.g. the 3-week snapshot when server was down for 2 months) are meaningless — add a safeguard: skip if `now - (event_ts + horizon) > 2 × horizon` and mark `captured_ts = -1` (sentinel for "missed").

---

## Phase 5 — News

### Goal

Aggregate news from RSS + CryptoPanic + Finnhub, dedupe, tag by ticker, score simple sentiment, display on `/news` with filters. Significant news events schedule brain snapshots.

### 5.1 — RSS collector

**File:** `apps/server/src/collectors/news/rss.ts`

Seed `apps/server/src/seed/rss_feeds.json`:
```json
[
  { "source": "CoinDesk",     "url": "https://www.coindesk.com/arc/outboundfeeds/rss/", "category": "crypto" },
  { "source": "Cointelegraph","url": "https://cointelegraph.com/rss",                    "category": "crypto" },
  { "source": "The Block",    "url": "https://www.theblock.co/rss.xml",                  "category": "crypto" },
  { "source": "Decrypt",      "url": "https://decrypt.co/feed",                          "category": "crypto" },
  { "source": "Bloomberg Markets","url": "https://feeds.bloomberg.com/markets/news.rss", "category": "markets" },
  { "source": "Reuters Markets",  "url": "https://feeds.reuters.com/reuters/businessNews", "category": "markets" },
  { "source": "WSJ Markets",      "url": "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",  "category": "markets" }
]
```

Behavior:
1. Every 5 minutes, fetch each feed with `rss-parser`.
2. Normalize each item: `{ source, title, url, pubDate, summary, content? }`.
3. Dedup key: canonical URL (strip query strings, fragments; lowercase host).
4. Tag tickers (§5.4) — attach to event.
5. Sentiment score (§5.5) — attach.
6. Emit `NewsEvent` to bus, insert into `events`.
7. Significance: if `tickers.length > 0 && abs(sentiment) >= 0.3`, schedule snapshots for the tagged asset(s).

### 5.2 — CryptoPanic collector

**File:** `apps/server/src/collectors/news/cryptopanic.ts`

Endpoint: `https://cryptopanic.com/api/v1/posts/?auth_token={key}&public=true&kind=news`

Every 5 min, fetch posts, normalize to the same shape as RSS, emit. CryptoPanic includes community voting (`votes.positive` vs `votes.negative`) — use as a sentiment signal override when available (it's often better than our keyword-based scorer).

Also use `currencies` field — CryptoPanic pre-tags posts with coin symbols. Trust these tags; don't re-derive with keyword matching.

### 5.3 — Finnhub news (stocks-specific)

**File:** `apps/server/src/collectors/stocks/finnhub.ts` — already created in Phase 3 for scaffolding. Now activate:

Every 15 min during market hours, for each enabled stock asset, fetch `/company-news?symbol={ticker}&from={yesterday}&to={today}`. Normalize + emit. Tag automatically with the stock ticker (no keyword matching needed).

### 5.4 — Ticker tagging

**File:** `apps/server/src/collectors/news/ticker-tagger.ts`

Load a mapping from `apps/server/src/data/ticker-aliases.json`:
```json
{
  "BTC":   ["bitcoin", "btc", "xbt"],
  "ETH":   ["ethereum", "ether", "eth", "vitalik"],
  "SOL":   ["solana", "sol"],
  "BNB":   ["bnb", "binance coin", "binance"],
  "XRP":   ["xrp", "ripple"],
  "ADA":   ["cardano", "ada"],
  "LTC":   ["litecoin", "ltc"],
  "AAPL":  ["apple", "aapl", "iphone"],
  "NVDA":  ["nvidia", "nvda", "jensen huang"],
  "MSFT":  ["microsoft", "msft", "azure"],
  "GOOGL": ["google", "alphabet", "googl", "goog"],
  "AMZN":  ["amazon", "amzn", "aws"],
  "META":  ["meta", "facebook", "instagram", "zuckerberg"],
  "TSLA":  ["tesla", "tsla", "musk"],
  "BRK.B": ["berkshire", "buffett"],
  "JPM":   ["jpmorgan", "jpm", "dimon"],
  "V":     ["visa"]
}
```

Algorithm: lowercase title + summary, word-boundary regex search for each alias, collect matches. Return unique tickers.

Gotcha: "apple" might match "apple farming" in a weird context; accept the false-positive rate and refine aliases over time.

### 5.5 — Simple sentiment scoring

**File:** `apps/server/src/collectors/news/sentiment.ts`

A dead-simple lexicon approach is fine for MVP. Load `apps/server/src/data/sentiment-lexicon.json`:
```json
{
  "positive": ["surge","rally","bullish","soar","jump","breakthrough","upgrade","beat","record","approved","launch"],
  "negative": ["crash","plunge","bearish","drop","fall","dump","hack","exploit","banned","lawsuit","downgrade","miss"]
}
```

Score: `(posCount - negCount) / max(posCount + negCount, 1)` → `-1..+1`.

Override with CryptoPanic's community votes when present: `(votes.positive - votes.negative) / max(votes.positive + votes.negative, 1)`.

Mark sentiment as `null` if both counts are zero — UI shows neutral gray instead of pretending precision.

### 5.6 — Backend API for news

**`apps/server/src/api/news.ts`:**

- `GET /api/news?tickers=BTC,ETH&sources=CoinDesk&minSentiment=-1&maxSentiment=1&limit=50&before={ts}` — paginated by `before` cursor.
- `GET /api/news/:id` — single event with full payload.

### 5.7 — `/news` page UI

Layout:
```
┌──────────────────────────────────────────────────────────────┐
│ NEWS FEED                         [FILTERS]                    │
├──────────────────────┬───────────────────────────────────────┤
│ Filters              │  Feed                                  │
│ ─────────            │  ─────                                 │
│ Tickers:             │  ┌────────────────────────────────┐   │
│ [BTC] [ETH] [AAPL]   │  │ [CoinDesk · 2m ago]  [+0.6]    │   │
│ [NVDA] ...           │  │ Bitcoin Surges Past $X on...   │   │
│                      │  │ Tags: BTC                      │   │
│ Sources:             │  └────────────────────────────────┘   │
│ ☑ CoinDesk           │                                        │
│ ☑ Bloomberg          │  ┌────────────────────────────────┐   │
│ ...                  │  │ ...                              │   │
│                      │  └────────────────────────────────┘   │
│ Sentiment: [-1,+1]   │                                        │
│                      │                                        │
│ [CLEAR ALL]          │                                        │
└──────────────────────┴───────────────────────────────────────┘
```

Components:
- `components/news/FilterSidebar.tsx` — ticker pills (toggleable), source checkboxes, sentiment range slider. State in Zustand.
- `components/news/NewsCard.tsx` — source badge, relative time, sentiment chip (green/red/gray by value), title, tags.
- `components/news/NewsDrawer.tsx` — click a card → side drawer with full title, summary, link-out button, raw sentiment breakdown, timestamp, ticker tags.
- Live updates: `useEventStream(['news'])`. New items slide in at top with brief neon-cyan flash animation.

### 5.8 — Phase 5 exit criteria

- [ ] RSS feeds all parse; CoinDesk + Bloomberg at minimum flowing into `events` (`kind = 'news'`).
- [ ] CryptoPanic flowing if key present.
- [ ] Finnhub news flowing for at least 5 stock tickers.
- [ ] Dedup prevents same story from appearing twice across sources with the same URL.
- [ ] Ticker tagging correctly tags at least 80% of crypto-named articles.
- [ ] Sentiment scoring produces sensible values (spot-check 10 articles manually).
- [ ] `/news` tab renders feed, filters work (ticker/source/sentiment).
- [ ] Detail drawer opens with correct data.
- [ ] Live new items slide in without reload.
- [ ] Significant news items (`|sentiment| >= 0.3` + tagged) schedule snapshots.
- [ ] Commit: `Phase 5: news`. Tag `v5.0`.
- [ ] `STATUS.md` updated.

### 5.9 — Phase 5 pitfalls

- **RSS feed encoding.** Some older feeds are ISO-8859-1 or use CDATA oddly. `rss-parser` handles most but try-catch around `parseURL` and log failures without killing the cron.
- **Canonical URL normalization.** Strip tracking params (`utm_*`, `fbclid`, etc.), fragments, trailing slashes, lowercase host. Without this, dedup fails across sources.
- **Near-duplicate titles.** "Bitcoin Hits $X" and "Bitcoin Reaches $X" on two outlets. MVP: accept duplicates across sources (they're still useful signals). Future: fuzzy title similarity (Levenshtein < 10 + same tickers).
- **Finnhub news limits.** Daily cap on the news endpoint. Don't fetch news for all 10 stocks every minute — 15 min is enough.
- **CryptoPanic tag quality.** Sometimes tags are too liberal (tagging BTC when article only mentioned it once). Accept it; filters let user narrow.
- **Blocking `rss-parser` on bad TLS.** Bloomberg's RSS has had intermittent TLS issues historically. Wrap with timeout (10s) and continue on fail.
- **Massive first fetch.** On first run, feeds return ~20–50 items each. All backfill at once can flood events — cap first-fetch to items from the last 24 hours.
- **Sentiment lexicon false positives.** "No surge" is scored positive. MVP ignores negation; document this limitation. Don't over-engineer.

---

## Phase 6 — Indicators

### Goal

Collect and display macro + crypto indicators: Fear & Greed, DXY, VIX, funding rates, open interest, BTC dominance, key FRED series. Each gets a panel on `/indicators` with current value + history chart.

### 6.1 — Fear & Greed (crypto)

**File:** `apps/server/src/collectors/macro/fear-greed.ts`

Endpoint: `GET https://api.alternative.me/fng/?limit=1` (or `?limit=30` for history backfill).

Every 30 min, fetch. Upsert into `indicator_readings` with `name = 'fng_crypto'`. Emit `IndicatorEvent` if value changes.

Classification mapping (for UI):
```
0–24   : Extreme Fear     (neon red)
25–49  : Fear             (amber)
50–74  : Greed            (cyan)
75–100 : Extreme Greed    (neon green)
```

### 6.2 — DXY + VIX (via Yahoo)

**File:** `apps/server/src/collectors/macro/dxy-vix.ts`

Uses `yahoo-finance2` (already installed in Phase 3).

Symbols: `DX-Y.NYB` (DXY), `^VIX`.

Every 5 min during US market hours, fetch last quote. Upsert into `indicator_readings` with names `dxy`, `vix`. Emit `IndicatorEvent`.

Daily history backfill on first run: `queryOptions({ period1: subDays(now, 365), interval: '1d' })` to populate 1 year.

### 6.3 — Funding rates + open interest (Binance)

**File:** `apps/server/src/collectors/macro/funding-oi.ts`

Binance Futures endpoints:
- Funding rate: `GET https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT` (returns current mark price, funding rate, next funding time).
- OI: `GET https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT` (current).
- OI history: `GET https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=500` (for initial backfill).

Every 5 min, for BTC + ETH + SOL (the three we have futures for on Binance), fetch funding + OI. Upsert indicators `funding_{SYMBOL}` and `oi_{SYMBOL}`.

### 6.4 — BTC dominance (CoinGecko)

**File:** `apps/server/src/collectors/macro/btc-dominance.ts`

Endpoint: `GET https://api.coingecko.com/api/v3/global` → `data.market_cap_percentage.btc`.

Every 30 min, fetch. Upsert `indicator_readings` name `btc_dominance`.

Rate limiter: 25/min (CoinGecko free is 30/min; safety margin).

### 6.5 — FRED series (US macro)

**File:** `apps/server/src/collectors/macro/fred.ts`

Endpoint: `GET https://api.stlouisfed.org/fred/series/observations?series_id={id}&api_key={key}&sort_order=desc&limit=1&file_type=json`

Series to poll (once per day, not per 5 min — these move slowly):
- `CPIAUCSL` — Consumer Price Index
- `DGS10` — 10-year Treasury yield
- `DFF` — Fed funds rate
- `UNRATE` — Unemployment rate
- `DCOILWTICO` — WTI crude spot (daily, useful as secondary source)

Cron: `0 5 * * *` (daily at 05:00 UTC — after US data is typically released).

### 6.6 — Backend API for indicators

**`apps/server/src/api/indicators.ts`:**

- `GET /api/indicators` — list all indicator names with their current (latest) reading.
- `GET /api/indicators/:name?from={ts}&to={ts}&limit={n}` — time series.

### 6.7 — `/indicators` page UI

Layout: responsive grid of panels, one per indicator. Crypto grouped left, macro right.

**`components/indicators/IndicatorPanel.tsx`** — reusable:
- Top: indicator name (Press Start 2P, 12px) + category badge
- Big current value (VT323, 48px, glow, color-coded by thresholds or delta direction)
- Small delta since last reading (+X% green, -X% red)
- Mini history chart (Lightweight Charts, line series, 50 points, subtle, no axes labels)
- Clickable → drawer with full history (1d/7d/30d/1y toggle).

**`components/indicators/FearGreedGauge.tsx`** — special panel for F&G:
- Half-circle SVG gauge with 4-color segments per classification thresholds
- Needle at current value
- Classification label in pixel font

**Panels to render:**
- Crypto Fear & Greed (gauge)
- DXY (line chart, big number)
- VIX (line chart, big number)
- BTC Funding Rate (with next-funding countdown)
- ETH Funding Rate
- BTC Open Interest
- BTC Dominance (line chart)
- CPI (YoY %)
- 10Y Treasury yield
- Fed Funds Rate
- Unemployment

### 6.8 — Phase 6 exit criteria

- [ ] All 11 indicators have at least one reading in `indicator_readings`.
- [ ] Polling cron for each respects the right interval (not faster than needed).
- [ ] FRED pulls once per day; verify next-day value lands.
- [ ] `/indicators` page renders all panels with current values.
- [ ] Clicking a panel opens history drawer; time-range toggle works.
- [ ] Fear & Greed gauge renders with correct color segment + needle position.
- [ ] No 429s from CoinGecko over 24h.
- [ ] Commit: `Phase 6: indicators`. Tag `v6.0`.
- [ ] `STATUS.md` updated.

### 6.9 — Phase 6 pitfalls

- **Yahoo symbol quirks.** `^VIX` needs the caret; `DX-Y.NYB` needs the dash and suffix. Any typo = silent empty response.
- **CoinGecko IP bans.** They throttle aggressively on free tier; one IP abuse and you're blocked for 30 min. Respect the 30/min ceiling, use Retry-After.
- **Funding rate display.** Binance returns funding as a fraction (e.g. `0.0001` = 0.01%). Multiply by 100 for UI percentage; preserve as fraction in DB.
- **Next funding countdown drift.** `premiumIndex.nextFundingTime` is absolute ms; compute countdown client-side to avoid server-clock reliance.
- **FRED data-release timing.** Series update at different times — CPI monthly on the 2nd Wednesday-ish, DFF daily. Don't alert on "no new data" for a series that hasn't been released yet.
- **VIX out of hours.** VIX quotes only during US equity hours. After-hours shows last close. Don't mistake that for real-time.
- **Indicator delta scope.** "Change since last reading" depends on poll frequency. UI should show absolute + percent, plus a 24h comparison badge.

---

## Handoff to Part 4

When all three phases green, open [IMPL-4-SYNTHESIS-ACTION.md](IMPL-4-SYNTHESIS-ACTION.md). Part 4 assumes:

- `whale_tx`, `news`, `indicator` events flowing in via event bus + SSE.
- `events_price_snapshots` accumulating — first 5m/30m snapshots should have real values by now.
- All three intelligence tabs rendering live data.
- Settings editable: whale addresses, ignore addresses, API keys all manageable via UI.
- `indicator_readings` table populated for all 11 indicators.
- `news` events tagged with tickers — Part 4's probability engine reads `news_sentiment_aggregate` from these.
- `whale_tx` events tagged with `chain` — Part 4's probability engine reads `whale_netflow_to_exchanges` from these (filtered by destination being in `ignore_addresses` = "sent to exchange" = bearish signal).

**Commit `STATUS.md` with Part 3 marked done** before moving on.

---

**End of Part 3.**
