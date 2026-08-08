# WSSKill state — Wick build (wsskill-20260808-wick)

Branch: wsskill-20260808-wick off f77e624. Plan docs swapped in (commit 1400144).

## Wave log
- W0 / Phase 0 reset: DONE, committed "Phase 0 — reset to Wick" (149 files, −21k lines).
  Vault keys live in settings as apikey.<provider>; assets/candles APIs adapted to new schema.
- W1 / Phase 1 market data: DONE, committed. Backfill 15.4s, 8 indicators live on boot
  (computeAll after marketWarm), SSE at /api/sse, htf via 5-min REST refresh, gap heal :07.
  Key APIs: getLastPrice(symbol) binance-ws; isMarketWarm() market/market-state.
  Convention: SQL prepared inside functions; ts in UTC ms (nowMs).
- W2 / Phases 2+3 parallel: WS-2 paper/** + scripts/paper.ts + api/bots-read.ts;
  WS-3 llm/** + scripts/ask.ts|keys.ts + shared/decision.ts. IN PROGRESS.
- W3 / Phase 4, W4 / Phase 5, W5 / Phase 6 (3 agents), W6 / Phase 7: pending.

## Constraints
- No provider keys yet → LLM live tests via stub adapter (+ollama if present). Luka adds keys in Settings later.
- Node 22 portable: export PATH="/d/Claude/Tools/node-v22:$PATH" for every node/pnpm call.
- Orchestrator commits; agents never git add/commit. No AI attribution in commits.
- data/ is untracked runtime state — never git add it.
