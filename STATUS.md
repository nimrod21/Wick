# Wick — Status

**Current phase:** 0 — Reset & carve-out (in progress)

## Phase checklist

- [x] Phase 0 — Reset & carve-out (this wave)
- [ ] Phase 1 — Market data & indicators
- [ ] Phase 2 — Paper trading engine
- [ ] Phase 3 — LLM provider layer
- [ ] Phase 4 — Bots + trigger engine
- [ ] Phase 5 — Learning & memory
- [ ] Phase 6 — UI
- [ ] Phase 7 — Hardening & service

## Environment notes

- Node 22 LTS required (better-sqlite3 breaks on Node 24). Portable install:
  `D:/Claude/Tools/node-v22` — `export PATH="/d/Claude/Tools/node-v22:$PATH"`.
- Server binds `127.0.0.1:3001`; web dev on `127.0.0.1:3000`.
- DB: `apps/server/data/wick.db` (WAL). Fresh schema `001_wick.sql`; migrate seeds
  the 7-symbol watchlist + default settings (guards, trigger thresholds, provider registry).
- Master key env var: `WICK_MASTER_KEY` (auto-generated into `.env` on first boot).

## Phase 0 notes / decisions

- Collectors (Binance WS/REST, fear-greed, funding-oi, scheduler, indicator cron) are
  kept but NOT started from `index.ts` — Phase 1 re-enables them against the new schema.
- `paper-mode.ts` / `order-manager.ts` / `risk-guards.ts` kept as adaptation bases;
  they still reference legacy tables (kv, orders, candles_1m, positions-by-asset_id)
  and are not exercised at runtime — Phase 2 rewires them.
- Vault keys now live in the `settings` table (`apikey.<provider>` rows, same AES-GCM
  format); the old `api_keys` table is gone.
- Web app gutted to a shell: `/` WICK placeholder, `/settings` placeholder, palette
  tokens in `globals.css`. Phase 6 rebuilds all pages.

## Blockers

- None.
