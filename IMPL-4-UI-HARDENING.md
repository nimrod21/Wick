# IMPL-4 — Phase 6 (UI) + Phase 7 (Hardening & Service)

> Read `PLAN.md` fully first — especially §12 (design) and §13 (page map). Requires Phases 0–5.

---

## Phase 6 — UI

**Objective:** the four pages from PLAN §13, live over SSE, in the toned-down pixel-80s
design system. The UI is read-mostly: bots run without it; it must make watching them great.

### Tasks

**6.1 Design system.** `apps/web` foundation:
- `globals.css`: palette tokens from PLAN §12 (already stubbed Phase 0), spacing scale,
  1px-border panel class, tabular-nums utility.
- Fonts self-hosted in `public/fonts` (no CDN): pixel font (Press Start 2P or similar
  free-licensed) — page titles + bot names only, small sizes; JetBrains Mono everywhere else.
- Components: `Panel`, `StatusLed` (green running / amber stopped / red busted, solid — no
  blink), `Stat` (label+value), `Sparkline` (inline SVG, no lib), `ActionBadge`
  (buy green / sell red / wait amber / vetoed gray outline), `OutcomeBadge` (score-colored),
  `PixelTitle`. CRT scanline overlay component, mounted only when settings toggle on
  (default off).
- Dark only — no theme switch. Every color from tokens; accents max 3 per screen (§12).

**6.2 Data layer.** `lib/api.ts` (typed fetchers over `/api/*`, zod-parsed with types from
`@wick/shared`) + `lib/sse.ts` (one EventSource, topic fan-out hook `useLive(topic, cb)`,
auto-reconnect with backoff). SWR or plain fetch+state — whichever the existing web app
already uses; add no state library.

**6.3 Dashboard `/`.**
- Bot cards: name (pixel font), status LED, equity + 24h sparkline, W/L (from outcomes,
  4h horizon), today: trades used / calls made, current position chip. Click → `/bots/[id]`.
- Market strip: 7 symbols — price (tick-flash on update), 24h %, vote summary dots.
- Live feed: last ~30 events (decisions, fills, protector exits, bot-status), newest on top,
  slide-in only (no other motion). Gated triggers excluded here (they live on bot page).

**6.4 Bot page `/bots/[id]`.**
- Header: name, status, controls — start/stop (instant), reset + allowance edit + config
  editor (drawer with the config_json fields as a form, zod-validated).
- Equity curve (lightweight-charts line, run-scoped) with drawdown shading + hwm line.
- Price chart (lightweight-charts candles, symbol picker from bot's symbols, tf switcher):
  markers for buys/sells/SL/TP exits; active position's stop/tp as price lines.
- Decision log: virtualized table — time, trigger, action badge, symbol, size, confidence,
  provider/model, status, outcome badges (1h/4h/24h as they arrive); row expands to full
  reasoning + snapshot summary. Filter by action/status.
- Indicator stats table: indicator, samples, hit-rate, weight bar, enabled/disabled/shadow.
- Journal tab: current lessons (pinned) + reflections stream.
- Trigger tab: recent `trigger_log` for this bot's symbols, gated ones dimmed.

**6.5 Market `/market`.** Per-symbol: full candle chart + tf switcher, indicator panel
(latest values + votes), funding + F&G tiles. Nothing bot-specific.

**6.6 Settings `/settings`.**
- Providers: per provider — key input (masked, vault-backed via existing settings API),
  enabled toggle, rpm/rpd fields, today's usage bar (used/limit), "test" button (1 cheap
  call, shows model + latency).
- Watchlist editor (add/remove symbols; server validates against Binance exchangeInfo).
- Guard defaults + trigger thresholds (advanced section, collapsible).
- CRT toggle.

### Acceptance (Phase 6 exit)
- [ ] Fresh `pnpm dev`: dashboard shows both seeded bots + live market strip within 2s; a decision appears in the feed ≤1s after its SSE event.
- [ ] Bot page: markers align with fills on the chart; expanding a decision shows reasoning; outcome badges appear after evaluator runs.
- [ ] Stop/start from UI takes effect on next wake (verify via trigger_log).
- [ ] Settings: paste a key → server can use it (test button); usage bars match `llm_usage`.
- [ ] No external font/CDN requests (check network tab — local-only rule).
- [ ] Design pass vs §12: max 3 accents/screen, pixel font only titles/names, no decorative motion, CRT off by default. Screenshot review with Luka before calling it done.
- [ ] Commit: `Phase 6 — UI`.

### Pitfalls
- lightweight-charts is client-only — dynamic import, no SSR.
- One EventSource for the whole app (browser connection limit); fan out internally.
- Virtualize the decision log — thousands of rows after a few weeks.
- Equity sparkline from `equity_snapshots`, not recomputed client-side.

---

## Phase 7 — Hardening & Service

**Objective:** Wick runs unattended for weeks on the Windows box: service autostart,
restart-safe, quota-safe, self-healing data, documented.

### Tasks

**7.1 Service.** `ecosystem.config.cjs`: `wick-server` (built dist, not tsx) + `wick-web`
(next start), Node 22 path in env, `max_restarts` + exponential backoff, log rotation
(pm2-logrotate, 10MB×5). `pm2 save` + `pm2-startup` for boot autostart. Update root
scripts (`pm2:start|stop|logs|status`).

**7.2 Crash-only design audit.** Kill -9 the server in each hot state (mid-fill, mid-LLM
call, mid-evaluation) → restart → verify: no half-written fills (transactions), in-flight
LLM call's decision either absent or `llm_failed` (never phantom-executed), evaluator
re-picks unevaluated decisions, protector re-arms, wake queues empty-start. Fix what fails.

**7.3 Data hygiene.** Nightly cron: prune `candles` 1m older than 14d (higher tfs keep),
`trigger_log` older than 30d, SSE client GC; VACUUM weekly; `data/` backup copy rotated ×3
(it's all paper, but the decision history is the product — losing it loses the learning).

**7.4 Ops surface.** `GET /health` extended: ws connected, marketWarm, per-provider headroom,
bots running, last evaluator run. `pnpm doctor` script prints the same + versions. STATUS.md
final update: how to run, how to add a provider key, known limits table snapshot.

**7.5 Smoke checklist + soak.** Scripted `pnpm smoke`: boots server against real Binance,
waits for marketWarm, seeds a throwaway bot, forces one scheduled wake with a stubbed
provider (deterministic decision), asserts fill+decision+SSE, tears down. Then the real
gate: **72h unattended soak** with 2 bots on free tiers — zero crashes, zero quota
violations, candle gaps self-healed, memory flat.

**7.6 README.** Rewrite for Wick proper: what it is, screenshot, architecture sketch, run
instructions (Node 22 note), provider setup, "paper only, $0 by design" statement.

### Acceptance (Phase 7 exit)
- [ ] Reboot Windows → both processes auto-start, bots resume, dashboard live without touching anything.
- [ ] All 7.2 kill scenarios pass.
- [ ] `pnpm smoke` green in CI-like run (fresh clone → install → smoke).
- [ ] 72h soak report in STATUS.md (uptime, calls/day per provider, decisions, any anomalies).
- [ ] README done; STATUS.md marks all phases complete.
- [ ] Commit: `Phase 7 — hardening`; tag `v1.0`.

### Pitfalls
- pm2 on Windows: use `pm2-startup` (or Task Scheduler fallback) — plain `pm2 startup` is Unix-only.
- `next start` needs `next build` in the pm2 pre-step or CI — don't serve dev mode as a service.
- VACUUM locks the DB — schedule inside the nightly window, skip if a fill happened in the last minute.
- Windows sleep/hibernate kills the WS silently — either disable sleep on the box or rely on reconnect+self-heal (verify the self-heal covers multi-hour gaps).

---

## After v1.0 (parking lot — do not build without asking)

Backtesting harness over the decision log · shorts via simulated perps + funding P&L ·
more bots/personality presets · per-regime stats (bull/bear/chop splits) · Telegram
notifications · multi-exchange data.
