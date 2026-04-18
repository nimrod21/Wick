# Probe Findings — Phase 0

Run: 2026-04-18T14:43:31Z
Runner: Node v24.13.1 on Windows 11 (bash/MSYS2)

## Summary

| Probe | Status | Elapsed | Notes |
|---|---|---|---|
| probe-binance-ws | FAIL | 16491ms | 6 klines in 15s; probe requires 10 within 15s timeout. Feed itself is healthy. |
| probe-binance-rest | OK | 426ms | 100 klines BTCUSDT 1m, latest close=2026-04-18T14:41:00Z |
| probe-rss | OK | 1341ms | CoinDesk=25 items, Bloomberg=30 items; Reuters "fetch failed" (known) |
| probe-fng | OK | 549ms | 10 values; latest=26 "Fear" (2026-04-18) |
| probe-blockstream | OK | 889ms | addr=1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF, 25 txs, block 944038 |
| probe-coingecko | OK | 602ms | BTC dominance=57.45%, 17566 active cryptos, btc_usd=76252 |
| probe-yahoo | FAIL | 3206ms | HTTP 429 "Too Many Requests" on ^VIX (rate limit from shared IP) |
| probe-twelvedata | BLOCKED | 1118ms | No TWELVEDATA_API_KEY |
| probe-finnhub | BLOCKED | 1078ms | No FINNHUB_API_KEY |
| probe-alpaca | BLOCKED | 1083ms | No ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY |
| probe-etherscan | BLOCKED | 1062ms | No ETHERSCAN_API_KEY |
| probe-helius | BLOCKED | 1071ms | No HELIUS_API_KEY |
| probe-cryptopanic | BLOCKED | 1063ms | No CRYPTOPANIC_API_KEY |
| probe-fred | BLOCKED | 1062ms | No FRED_API_KEY |

Totals: 5 OK, 2 FAIL, 7 BLOCKED (expected).

## Tier 0 — Passes

### probe-binance-rest
- Status: OK
- Elapsed: 426ms
- URL: `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=100`
- Observations: 100 klines returned. earliestTs=1776517320000 (2026-04-18T13:02:00Z), latestTs=1776523260000 (2026-04-18T14:41:00Z). Continuous minute coverage across ~1h40m window.
- Quirks: none — response is a plain JSON array of arrays, no auth required.

### probe-rss
- Status: OK
- Elapsed: 1341ms
- Observations:
  - `coindesk`: 25 items; latest title "Zondacrypto under fire as Poland's prime minister links exchange to legislative interference", pubDate "Sat, 18 Apr 2026 14:00:00 +0000".
  - `bloomberg-markets`: 30 items; latest title "Iran Claims 'Strict Control' of Strait of Hormuz", pubDate "Sat, 18 Apr 2026 14:25:44 GMT".
  - `reuters-business`: "fetch failed" (upstream unreachable; expected per design).
- Quirks: Reuters feed is flaky/blocked — not blocking (CoinDesk + Bloomberg cover the role).

### probe-fng
- Status: OK
- Elapsed: 549ms
- URL: `https://api.alternative.me/fng/?limit=10`
- Observations: 10 daily values, spanning 2026-04-09 to 2026-04-18. Latest=26 "Fear" (2026-04-18). Prior 9 days all "Extreme Fear" (12–23). Timestamps are unix seconds.
- Quirks: classification is localized string ("Fear", "Extreme Fear") — keep a value-based mapping in code, not string matching.

### probe-blockstream
- Status: OK
- Elapsed: 889ms
- Observations: Genesis-era address `1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF` has tx_count=25, latest txid `66d92287eba61525cd5f88e8aff965a336423fc76012c97f620dd7450d8a41e1`, current tip block height=944038.
- Quirks: none — Esplora REST is stable and keyless.

### probe-coingecko
- Status: OK
- Elapsed: 602ms
- Observations: BTC dominance=57.4473%, active_cryptocurrencies=17566, btc_usd=76252.
- Quirks: Free public CoinGecko endpoint — watch 429s at higher call volume; upgrade to Demo/Pro API key if sustained usage is needed.

## Tier 1 — Blocked (keys needed)

### probe-twelvedata
- Status: BLOCKED
- Signup: https://twelvedata.com/register
- Free tier: 800 req/day, 8 req/min.
- What breaks without key: `/trading/metals`, `/trading/commodities`, `/trading/stocks` (Phase 3). Yahoo fallback available but also rate-limited (see Failures).

### probe-finnhub
- Status: BLOCKED
- Signup: https://finnhub.io/register
- Free tier: 60 calls/min.
- What breaks without key: equities fundamentals, news sentiment, earnings calendar (Phase 3 enrichment). Not on Phase 1 critical path.

### probe-alpaca
- Status: BLOCKED
- Signup: https://alpaca.markets/paper
- Free tier: paper trading account includes market data.
- What breaks without key: US equities real-time/historical bars (Phase 3). Twelvedata and Yahoo partially cover.

### probe-etherscan
- Status: BLOCKED
- Signup: https://etherscan.io/register
- Free tier: 5 calls/sec, 100k/day.
- What breaks without key: Ethereum on-chain queries (Phase 2 enrichment). Not on Phase 1 critical path.

### probe-helius
- Status: BLOCKED
- Signup: https://helius.dev
- Free tier: 100k credits/mo, RPC + enhanced APIs.
- What breaks without key: Solana RPC + DAS queries (Phase 2 SOL coverage). Not on Phase 1 critical path.

### probe-cryptopanic
- Status: BLOCKED
- Signup: https://cryptopanic.com/developers/api
- Free tier: aggregated crypto news with sentiment tags.
- What breaks without key: crypto news sentiment stream (Phase 2 news). RSS feeds cover baseline.

### probe-fred
- Status: BLOCKED
- Signup: https://fred.stlouisfed.org/docs/api/api_key.html
- Free tier: keyed but effectively unlimited for personal use.
- What breaks without key: macro series (CPI, DGS10, UNRATE, etc.) for Phase 3 macro overlay. Not on Phase 1 critical path.

## Failures

### probe-binance-ws — FAIL (probe threshold, not feed)
- Error: `timeout after 15000ms, received=6`
- Elapsed: 16491ms
- Root cause: The probe demands 10 messages in 15s, but a `btcusdt@kline_1m` stream only emits an update when the aggregated kline changes (partial-candle pushes are batched ~1/sec on quiet ticks and coalesced by the server). During the run we received 6 messages including one `x=true` (final-candle close) — proving the stream, payload shape, and close-boundary flag all work.
- Payload shape confirmed: `{ e, E, s, k: { t, T, s, i, o, c, x, ... } }` with `k.t`=openTime(ms), `k.T`=closeTime(ms), `k.x`=final boolean flipping true on minute boundary (observed at msg 6, openTime=1776523200000 → closeTime=1776523259999).
- Assessment: **does NOT block Phase 0 exit.** The underlying Binance WS feed is fully functional. The probe script's 10-msg-in-15s threshold is tight for a 1m kline stream on a quiet market minute. Consider relaxing to 5 msgs or 30s in a follow-up, but not required here (probe scripts are frozen per Wave 3 rules).

### probe-yahoo — FAIL (rate limit)
- Error: `Unexpected token 'T', "Too Many Requests" is not valid JSON` on `^VIX`
- Elapsed: 3206ms
- Root cause: Yahoo's `query1.finance.yahoo.com` returned HTTP 429 on the first quote call. `yahoo-finance2` did successfully fetch a crumb + cookie (`xJekpTwsZzP`), so the anti-bot handshake works — the shared egress IP is just hot. The library also prints a deprecation notice ("v2 is no longer maintained — migrate to v3") which is worth tracking separately.
- Assessment: **does NOT hard-block Phase 0 exit**, but degrades coverage for indices/equities until Tier 1 keys (Twelvedata, Alpaca) land. Mitigations:
  1. Add exponential backoff + longer User-Agent rotation in the Yahoo adapter.
  2. Upgrade `yahoo-finance2` to v3 per the deprecation notice.
  3. Treat Yahoo as best-effort fallback behind Twelvedata/Alpaca once keys are provisioned.

## Next actions
- User to register Tier 1 accounts when ready (URLs above) — none are on Phase 1 critical path.
- Yahoo 429 should be re-tested from a different IP / after cooldown; if persistent, prioritize Twelvedata signup to unblock indices coverage.
- Binance WS probe threshold (10 msgs / 15s) is tight — consider loosening in a future revision, but the underlying feed is healthy.
- Wave 3 completion permits Phase 0 exit. Phase 1 (backbone) can begin without Tier 1 keys; Binance REST + WS, CoinGecko, Blockstream, FNG, and CoinDesk/Bloomberg RSS provide sufficient signal.
