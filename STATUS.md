# Cockpit Status

**Current phase:** Phase 1 — Backbone (exit-ready)
**Last commit:** `a083d4b` — Phase 1 Wave 2
**Updated:** 2026-04-18

## Phase checklist
- [x] Phase 0 — Preflight + Spike (via wsskill 3 waves)
- [x] Phase 1 — Backbone (via wsskill 3 waves)  ← just finished, Wave 3 pending commit
- [ ] Phase 2 — Crypto trading tab  ← next
- [ ] Phase 3 — Non-crypto trading tabs
- [ ] Phase 4 — Whale tracker
- [ ] Phase 5 — News
- [ ] Phase 6 — Indicators
- [ ] Phase 7 — Dashboard + probability engine
- [ ] Phase 8 — Alerts
- [ ] Phase 9 — Execution (paper)
- [ ] Phase 10 — Execution (live crypto)

## Active blockers
- None for Phase 2, but see *Environment notes* below.

## Environment notes (IMPORTANT)

- **Node 22 LTS required.** Node 24 was initially installed (v24.13.1) but `better-sqlite3` v12.9.0 prebuilt for Node 24 (`node-v137-win32-x64`) is consistently returning HTTP 504 from GitHub's binary CDN — even though the asset exists. PLAN.md §18 #15 documented this fallback risk.
- **Node 22.22.2 portable** is installed at `D:/Claude/Tools/node-v22/`. Prepend this to `PATH` before running `pnpm` / `node` / `pm2` for this project:
  ```bash
  export PATH="/d/Claude/Tools/node-v22:$PATH"
  ```
- For persistent switching, install `nvm-windows` later (https://github.com/coreybutler/nvm-windows) and do `nvm install 22 && nvm use 22`.
- `better-sqlite3` bumped from `^11.3.0` → `^12.9.0` (only v12 has Node 24 prebuilts; on Node 22 either works fine).
- `@fastify/sse-v2` in PLAN.md §6 is wrong — correct package is `fastify-sse-v2` (community plugin). Fixed in code; plan could be updated later.

## API keys status
Tier 0 (no key needed, already working): Binance public, Yahoo, RSS, alternative.me F&G, Blockstream, public Solana RPC, CoinGecko.

Tier 1 — user to register when convenient (all Settings-page-manageable already):
- [ ] Twelve Data — https://twelvedata.com/register
- [ ] Finnhub — https://finnhub.io/register
- [ ] Etherscan — https://etherscan.io/register
- [ ] Helius (Solana) — https://helius.dev
- [ ] CryptoPanic — https://cryptopanic.com/developers/api
- [ ] FRED — https://fred.stlouisfed.org/docs/api/api_key.html

Tier 2 — deferred to their phases:
- [ ] Alpaca paper (Phase 9) — https://alpaca.markets/paper
- [ ] Binance trading (Phase 10 — only if live trading enabled)

## Smoke test results (Phase 1)

| Check | Result |
|---|---|
| `pnpm install` | ✅ clean under Node 22 |
| `pnpm typecheck` (all 3 packages) | ✅ clean |
| `pnpm --filter @cockpit/server build` | ✅ emits dist/ |
| `pnpm migrate` | ✅ 001_initial.sql applies; idempotent |
| SQLite tables created | ✅ 22 tables (all from PLAN.md §8) |
| Server starts on 127.0.0.1:3001 | ✅ |
| `GET /health` | ✅ 200 `{"ok":true,"ts":...}` |
| `GET /api/assets?type=crypto` | ✅ returns 7 seeded pairs |
| Seed loader | ✅ 23 assets inserted on first run, skipped on restart |
| SSE `/stream` hello frame | ✅ `event: hello` received |
| PM2 installed | ✅ pm2 6.0.14 under Node 22 |

## Notes for next session

1. **Prepend Node 22 to PATH** before running any `pnpm`/`pm2` command: `export PATH="/d/Claude/Tools/node-v22:$PATH"`.
2. **Phase 2 starts next** — open `IMPL-2-TRADING.md`. Phase 2 adds Binance WS collector, historical backfill, trading-tab UI components. Builds on the Phase 1 backbone.
3. **Browser verification still pending** — Phase 1 typecheck is clean but nobody has opened `http://127.0.0.1:3000/` in an actual browser yet. Recommended first step for Phase 2: manual visual smoke test of all tab routes with pixel 80s theme before writing new code.
4. **Heartbeat event verified structurally** but full 10s heartbeat wasn't observed in short smoke tests. Any SSE issue noticed during Phase 2 should re-test this.
5. **data/ folder contains cockpit.db** after migration. Gitignored. Safe to delete for a fresh start (`rm -rf apps/server/data/cockpit.db`).
