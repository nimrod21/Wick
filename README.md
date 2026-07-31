# Trading Cockpit

A self-hosted trading intelligence platform — one dashboard for market data,
news, on-chain whale tracking, indicators, and (eventually) paper/live
execution. TypeScript monorepo: Next.js web app + Node server.

> **Status: work in progress.** Foundation and dashboard backbone are done
> (Phases 0–1 of 10); trading tabs, whale tracker, news, indicators, and the
> probability engine are planned. See [PLAN.md](PLAN.md) and
> [STATUS.md](STATUS.md).

## Architecture

- `apps/web` — Next.js dashboard (digest + firehose layout, charting, settings)
- `apps/server` — Node data backbone: provider integrations (Binance,
  TwelveData, Finnhub, Etherscan, Helius, CryptoPanic, FRED, Alpaca),
  key management, caching
- `packages/` — shared types and utilities

API keys are configured at runtime via the UI settings (encrypted with a
master key) — nothing is hardcoded. `.env.example` lists optional fallbacks.

## Run

```bash
pnpm install
pnpm dev   # or: start.bat / pm2 via ecosystem.config.cjs
```
