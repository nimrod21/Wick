/**
 * Trigger engine (IMPL-3 §4.4) — PLAN §9, pure code, zero LLM.
 *
 * Subscribes to the bus (tick, candle, indicator, funding, fill), keeps a
 * small per-symbol rolling state, and wakes bots when a §9 condition
 * matches. Every match is written to `trigger_log` with fired 0/1 — gating
 * must be visible — and mirrored onto the bus as a `trigger` event so the UI
 * can dim the gated ones.
 *
 * Gates, in order: market warm → per (type × symbol) cooldown (15m) →
 * per-bot wake floor (10m) → LLM budget (P1 keeps a 30% reserve; P2 needs
 * >50% pool or an open position in the symbol; P3 yields under the reserve).
 *
 * The protector is NOT a trigger: SL/TP exits execute in code on the tick
 * (paper/protector.ts). A P1 `position_event` may also fire so the bot can
 * reassess, but no exit ever waits for it.
 */

import type {
  CandleEvent,
  FundingEvent,
  IndicatorEvent,
  MacroEvent,
  NewsEvent,
  TickEvent,
  TriggerEvent,
  WhaleEvent,
} from '@wick/shared';
import { db } from '../db/client.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';
import { nowMs } from '../util/time.js';
import { isMarketWarm } from './market-state.js';
import { INDICATOR_TF } from './indicator-engine.js';
import { getProviders } from '../llm/providers.js';
import { poolRemaining } from '../llm/quota.js';
import { setVolatilityWindow } from '../paper/engine.js';
import { listRunningBots, parseConfig } from '../bots/bot-store.js';
import { requestWake, lastDecisionTs, type WakePriority } from '../bots/bot-runner.js';
import { getIntelThresholds } from '../collectors/intel-settings.js';
import { newsBurstRatio } from '../collectors/news/rss.js';
import { MACRO_SYMBOLS } from '../collectors/macro/yahoo-macro.js';

/**
 * Priority per trigger type (PLAN §9 table + the IMPL-3b intel triggers).
 * The engine passes the priority in-line; this map exists so read-only
 * consumers (the notifications API) can colour a `trigger_log` row without
 * a schema change.
 */
export const TRIGGER_PRIORITY: Record<string, WakePriority> = {
  position_event: 1,
  price_velocity: 1,
  whale_big_move: 1,
  rsi_cross: 2,
  macd_cross: 2,
  bb_breakout: 2,
  volume_spike: 2,
  funding_flip: 2,
  news_burst: 2,
  macro_shock: 2,
  scheduled: 3,
};

// ── thresholds (settings row `triggers.thresholds`, seeded at migrate) ──

export interface TriggerThresholds {
  price_velocity_atr_mult: number;
  rsi_low: number;
  rsi_high: number;
  bb_period: number;
  bb_stddev: number;
  volume_spike_mult: number;
  funding_flip: boolean;
  per_trigger_symbol_cooldown_min: number;
  per_bot_wake_floor_min: number;
  p1_reserve_pct: number;
  p2_pool_min_pct: number;
}

export const THRESHOLD_DEFAULTS: TriggerThresholds = {
  price_velocity_atr_mult: 2,
  rsi_low: 30,
  rsi_high: 70,
  bb_period: 20,
  bb_stddev: 2,
  volume_spike_mult: 3,
  funding_flip: true,
  per_trigger_symbol_cooldown_min: 15,
  per_bot_wake_floor_min: 10,
  p1_reserve_pct: 30,
  p2_pool_min_pct: 50,
};

export function getThresholds(): TriggerThresholds {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('triggers.thresholds') as
    | { value: string }
    | undefined;
  if (!row) return { ...THRESHOLD_DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object') return { ...THRESHOLD_DEFAULTS };
    return { ...THRESHOLD_DEFAULTS, ...(parsed as Partial<TriggerThresholds>) };
  } catch {
    return { ...THRESHOLD_DEFAULTS };
  }
}

/** Velocity trigger doubles paper slippage for this long (PLAN §10). */
export const VOLATILITY_WINDOW_MS = 15 * 60_000;
const PRICE_WINDOW_MS = 15 * 60_000;
const POSITION_ARM_PCT = 0.5; // IMPL-3 pitfall: arm position_event only after a 0.5% move
const POSITION_REFRESH_MS = 5_000;

// ── budget gate (PLAN §9) ──────────────────────────────────────────────

export interface BudgetInfo {
  pool: number;
  poolTotal: number;
  reserve: number;
}

export function budgetInfo(ts: number = nowMs()): BudgetInfo {
  const providers = getProviders();
  const poolTotal = providers.reduce((sum, p) => sum + (p.enabled ? p.rpd : 0), 0);
  const pool = poolRemaining(providers, ts);
  const reserve = (poolTotal * getThresholds().p1_reserve_pct) / 100;
  return { pool, poolTotal, reserve };
}

/**
 * PLAN §9 budget rules. Pure — the caller supplies the pool numbers and
 * whether this bot holds the trigger's symbol.
 */
export function budgetGate(
  priority: WakePriority,
  info: BudgetInfo,
  hasOpenPosition: boolean,
  th: TriggerThresholds = getThresholds(),
): { ok: true } | { ok: false; reason: string } {
  if (info.pool <= 0) return { ok: false, reason: 'budget_pool_exhausted' };
  if (priority === 1) return { ok: true }; // P1 draws on the reserve
  if (info.pool <= info.reserve) {
    return { ok: false, reason: `budget_p1_reserve(${info.pool.toFixed(0)}<=${info.reserve.toFixed(0)})` };
  }
  if (priority === 2) {
    const half = (info.poolTotal * th.p2_pool_min_pct) / 100;
    if (info.pool > half || hasOpenPosition) return { ok: true };
    return { ok: false, reason: `budget_p2_pool(${info.pool.toFixed(0)}<=${half.toFixed(0)})` };
  }
  return { ok: true }; // P3 above the reserve line
}

// ── trigger_log + bus ──────────────────────────────────────────────────

let triggerEventSeq = 1;

function logTrigger(
  botId: number | null,
  type: string,
  priority: WakePriority,
  symbol: string | null,
  detail: string,
  fired: boolean,
  gateReason: string | null,
): void {
  const ts = nowMs();
  db.prepare('INSERT INTO trigger_log (ts, bot_id, type, detail, fired) VALUES (?, ?, ?, ?, ?)').run(
    ts,
    botId,
    type,
    gateReason ? `${detail} [${gateReason}]` : detail,
    fired ? 1 : 0,
  );
  const evt: TriggerEvent = {
    id: triggerEventSeq++,
    ts,
    source: 'trigger-engine',
    kind: 'trigger',
    botId,
    type,
    priority,
    symbol,
    detail,
    fired,
    gateReason,
  };
  eventBus.emit(evt);
}

// ── cooldowns ──────────────────────────────────────────────────────────

const cooldowns = new Map<string, number>(); // `${type}:${symbol}` → last fired ts

function cooldownKey(type: string, symbol: string | null): string {
  return `${type}:${symbol ?? '*'}`;
}

export function resetCooldowns(): void {
  cooldowns.clear();
}

// ── firing ─────────────────────────────────────────────────────────────

export interface TriggerMatch {
  type: string;
  priority: WakePriority;
  symbol: string | null;
  /** trigger_log detail + decision.trigger_detail. */
  detail: string;
  /** Prompt line: "Woken by: …". */
  reason: string;
  /** position_event: only the owning bot. */
  onlyBotIds?: number[];
  /**
   * Cooldown bucket for symbol-less (global) triggers that still need to be
   * kept apart — e.g. `macro_shock` on gold must not silence oil. Ignored
   * when `symbol` is set.
   */
  scopeKey?: string;
  /**
   * `scheduled` wakes skip the per (type × symbol) cooldown — the bot's
   * cadence IS the discipline, and the candle-close dedupe already prevents
   * repeats. The per-bot 10-min floor and the budget gate still apply.
   */
  skipTypeCooldown?: boolean;
}

/**
 * Apply cooldown → per-bot floor → budget, log every evaluation, wake the
 * bots that pass. Returns how many bots were actually woken.
 */
export function fireTrigger(match: TriggerMatch, ts: number = nowMs()): number {
  const th = getThresholds();
  const symbol = match.symbol ? match.symbol.toUpperCase() : null;

  // Which bots care about this trigger?
  const candidates = listRunningBots().filter((bot) => {
    if (match.onlyBotIds && !match.onlyBotIds.includes(bot.id)) return false;
    if (!symbol) return true;
    return parseConfig(bot).symbols.includes(symbol);
  });

  if (candidates.length === 0) {
    logTrigger(null, match.type, match.priority, symbol, match.detail, false, 'no_matching_bots');
    return 0;
  }

  // Per (type × symbol) cooldown — global, so it gates the whole evaluation.
  const key = cooldownKey(match.type, symbol ?? match.scopeKey ?? null);
  const last = match.skipTypeCooldown ? undefined : cooldowns.get(key);
  const cooldownMs = th.per_trigger_symbol_cooldown_min * 60_000;
  if (last !== undefined && ts - last < cooldownMs) {
    const left = ((cooldownMs - (ts - last)) / 60_000).toFixed(1);
    for (const bot of candidates) {
      logTrigger(bot.id, match.type, match.priority, symbol, match.detail, false, `cooldown_${left}min_left`);
    }
    return 0;
  }

  const info = budgetInfo(ts);
  let fired = 0;
  for (const bot of candidates) {
    const floorMs = th.per_bot_wake_floor_min * 60_000;
    const lastDecision = lastDecisionTs(bot.id);
    if (lastDecision !== null && ts - lastDecision < floorMs) {
      logTrigger(bot.id, match.type, match.priority, symbol, match.detail, false, 'bot_floor');
      continue;
    }
    const hasPosition =
      symbol !== null &&
      (db.prepare('SELECT 1 AS x FROM positions WHERE bot_id = ? AND symbol = ?').get(bot.id, symbol) !==
        undefined);
    const budget = budgetGate(match.priority, info, hasPosition, th);
    if (!budget.ok) {
      logTrigger(bot.id, match.type, match.priority, symbol, match.detail, false, budget.reason);
      continue;
    }
    logTrigger(bot.id, match.type, match.priority, symbol, match.detail, true, null);
    requestWake({
      botId: bot.id,
      triggerType: match.type,
      triggerDetail: match.detail,
      reason: match.reason,
      symbol,
      priority: match.priority,
    });
    fired += 1;
  }
  if (fired > 0 && !match.skipTypeCooldown) cooldowns.set(key, ts);
  return fired;
}

// ── per-symbol rolling state ───────────────────────────────────────────

interface SymbolState {
  prices: Array<{ ts: number; price: number }>;
  atr: number | null;
  rsi: number | null;
  bbOutside: boolean;
  fundingSign: number | null;
}

const state = new Map<string, SymbolState>();

function symState(symbol: string): SymbolState {
  let s = state.get(symbol);
  if (!s) {
    s = { prices: [], atr: null, rsi: null, bbOutside: false, fundingSign: null };
    state.set(symbol, s);
  }
  return s;
}

export function resetTriggerState(): void {
  state.clear();
  cooldowns.clear();
  positions.clear();
  armed.clear();
  newsBurstOn = false;
  macroShockOn.clear();
}

/** Seed rsi/atr/bb state from the newest persisted indicator row per symbol. */
function primeState(): void {
  const rows = db
    .prepare(
      `SELECT iv.symbol, iv.name, iv.value FROM indicator_values iv
        JOIN (SELECT symbol, MAX(ts) AS ts FROM indicator_values WHERE tf = ? GROUP BY symbol) m
          ON m.symbol = iv.symbol AND m.ts = iv.ts
       WHERE iv.tf = ?`,
    )
    .all(INDICATOR_TF, INDICATOR_TF) as Array<{ symbol: string; name: string; value: number | null }>;
  for (const r of rows) {
    if (r.value === null) continue;
    const s = symState(r.symbol);
    if (r.name === 'atr14') s.atr = r.value;
    else if (r.name === 'rsi14') s.rsi = r.value;
    else if (r.name === 'bollinger') s.bbOutside = r.value < 0 || r.value > 1;
  }
}

// ── open-position index (position_event) ───────────────────────────────

interface PosEntry {
  botId: number;
  symbol: string;
  avgEntry: number;
  stop: number | null;
  tp: number | null;
}

const positions = new Map<string, PosEntry[]>();
const armed = new Set<string>(); // `${botId}:${symbol}` — 0.5% away from entry

function refreshPositions(): void {
  positions.clear();
  const rows = db
    .prepare('SELECT bot_id, symbol, avg_entry, stop_price, tp_price FROM positions WHERE qty > 1e-12')
    .all() as Array<{
    bot_id: number;
    symbol: string;
    avg_entry: number;
    stop_price: number | null;
    tp_price: number | null;
  }>;
  const live = new Set<string>();
  for (const r of rows) {
    const list = positions.get(r.symbol) ?? [];
    list.push({
      botId: r.bot_id,
      symbol: r.symbol,
      avgEntry: r.avg_entry,
      stop: r.stop_price,
      tp: r.tp_price,
    });
    positions.set(r.symbol, list);
    live.add(`${r.bot_id}:${r.symbol}`);
  }
  for (const k of [...armed]) if (!live.has(k)) armed.delete(k);
}

// ── condition handlers ─────────────────────────────────────────────────

function crossed(prev: number, cur: number, level: number): boolean {
  return (prev < level && cur >= level) || (prev >= level && cur < level);
}

function checkPriceVelocity(symbol: string, s: SymbolState, price: number, th: TriggerThresholds): void {
  const oldest = s.prices[0];
  if (!oldest || s.atr === null || s.atr <= 0) return;
  // Need a meaningful window before judging velocity.
  if (price === oldest.price) return;
  const span = s.prices[s.prices.length - 1]!.ts - oldest.ts;
  if (span < PRICE_WINDOW_MS / 3) return;
  const delta = Math.abs(price - oldest.price);
  const limit = th.price_velocity_atr_mult * s.atr;
  if (delta <= limit) return;

  const dir = price > oldest.price ? 'up' : 'down';
  const pct = ((price - oldest.price) / oldest.price) * 100;
  setVolatilityWindow(symbol, nowMs() + VOLATILITY_WINDOW_MS);
  fireTrigger({
    type: 'price_velocity',
    priority: 1,
    symbol,
    detail: `price_velocity:${symbol} ${dir} ${delta.toFixed(4)} > ${limit.toFixed(4)} (2xATR) in ${(span / 60_000).toFixed(0)}m`,
    reason: `Woken by: price moved ${pct.toFixed(2)}% ${dir} on ${symbol} in the last ${(span / 60_000).toFixed(0)} minutes (more than ${th.price_velocity_atr_mult}× ATR(1h)).`,
  });
}

function checkPositionEvents(symbol: string, price: number): void {
  const list = positions.get(symbol);
  if (!list || list.length === 0) return;
  for (const p of list) {
    const key = `${p.botId}:${p.symbol}`;
    const movePct = Math.abs((price - p.avgEntry) / p.avgEntry) * 100;
    if (!armed.has(key)) {
      if (movePct >= POSITION_ARM_PCT) armed.add(key);
      continue; // never fire on the entry tick itself
    }
    let hit: string | null = null;
    if (p.stop !== null && price <= p.avgEntry + (p.stop - p.avgEntry) / 2) hit = 'half-way to stop';
    else if (p.tp !== null && price >= p.avgEntry + (p.tp - p.avgEntry) / 2) hit = 'half-way to take-profit';
    if (!hit) continue;
    const uPnl = ((price - p.avgEntry) / p.avgEntry) * 100;
    fireTrigger({
      type: 'position_event',
      priority: 1,
      symbol,
      detail: `position_event:${symbol} bot=${p.botId} ${hit} @${price} entry=${p.avgEntry}`,
      reason: `Woken by: your ${symbol} position is ${hit} (unrealized ${uPnl.toFixed(2)}%).`,
      onlyBotIds: [p.botId],
    });
  }
}

function onTick(e: TickEvent): void {
  if (!isMarketWarm()) return;
  const s = symState(e.symbol);
  s.prices.push({ ts: e.ts, price: e.price });
  const cutoff = e.ts - PRICE_WINDOW_MS;
  while (s.prices.length > 0 && s.prices[0]!.ts < cutoff) s.prices.shift();
  try {
    checkPriceVelocity(e.symbol, s, e.price, getThresholds());
    checkPositionEvents(e.symbol, e.price);
  } catch (err) {
    logger.error({ err, symbol: e.symbol }, 'trigger-engine: tick handler failed');
  }
}

function onIndicator(e: IndicatorEvent): void {
  if (!isMarketWarm() || e.tf !== INDICATOR_TF || e.value === null) return;
  const s = symState(e.symbol);
  const th = getThresholds();
  try {
    switch (e.name) {
      case 'atr14':
        s.atr = e.value;
        break;
      case 'rsi14': {
        const prev = s.rsi;
        s.rsi = e.value;
        if (prev === null) break;
        const level = crossed(prev, e.value, th.rsi_high)
          ? th.rsi_high
          : crossed(prev, e.value, th.rsi_low)
            ? th.rsi_low
            : null;
        if (level === null) break;
        fireTrigger({
          type: 'rsi_cross',
          priority: 2,
          symbol: e.symbol,
          detail: `rsi_cross:${e.symbol} ${prev.toFixed(1)}→${e.value.toFixed(1)} level=${level}`,
          reason: `Woken by: RSI(14,1h) crossed ${level} on ${e.symbol} (${prev.toFixed(1)} → ${e.value.toFixed(1)}).`,
        });
        break;
      }
      case 'macd': {
        if (e.vote !== 'bull' && e.vote !== 'bear') break;
        fireTrigger({
          type: 'macd_cross',
          priority: 2,
          symbol: e.symbol,
          detail: `macd_cross:${e.symbol} hist=${e.value.toFixed(4)} vote=${e.vote}`,
          reason: `Woken by: MACD crossed its signal line ${e.vote === 'bull' ? 'upward' : 'downward'} on ${e.symbol} (1h).`,
        });
        break;
      }
      case 'bollinger': {
        const outside = e.value < 0 || e.value > 1;
        const wasOutside = s.bbOutside;
        s.bbOutside = outside;
        if (!outside || wasOutside) break;
        fireTrigger({
          type: 'bb_breakout',
          priority: 2,
          symbol: e.symbol,
          detail: `bb_breakout:${e.symbol} %B=${e.value.toFixed(3)} band=${e.value > 1 ? 'upper' : 'lower'}`,
          reason: `Woken by: ${e.symbol} closed outside its ${th.bb_period},${th.bb_stddev} Bollinger band (${e.value > 1 ? 'above upper' : 'below lower'}, 1h).`,
        });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    logger.error({ err, symbol: e.symbol, name: e.name }, 'trigger-engine: indicator handler failed');
  }
}

/** volume_spike straight from PLAN §9: candle volume > 3 × 20-candle average. */
function onCandle(e: CandleEvent): void {
  if (!isMarketWarm() || !e.closed || e.tf !== INDICATOR_TF) return;
  try {
    const th = getThresholds();
    const row = db
      .prepare(
        `SELECT AVG(v) AS avg FROM (
           SELECT v FROM candles WHERE symbol = ? AND tf = ? AND ts < ? ORDER BY ts DESC LIMIT 20
         )`,
      )
      .get(e.symbol, e.tf, e.ts) as { avg: number | null };
    if (row.avg === null || row.avg <= 0) return;
    const ratio = e.v / row.avg;
    if (ratio <= th.volume_spike_mult) return;
    fireTrigger({
      type: 'volume_spike',
      priority: 2,
      symbol: e.symbol,
      detail: `volume_spike:${e.symbol} vol=${e.v.toFixed(1)} ratio=${ratio.toFixed(2)}x avg20`,
      reason: `Woken by: ${e.symbol} 1h volume was ${ratio.toFixed(1)}× its 20-candle average (candle closed ${e.c >= e.o ? 'green' : 'red'}).`,
    });
  } catch (err) {
    logger.error({ err, symbol: e.symbol }, 'trigger-engine: candle handler failed');
  }
}

function onFunding(e: FundingEvent): void {
  if (!isMarketWarm()) return;
  const th = getThresholds();
  if (!th.funding_flip) return;
  const s = symState(e.symbol);
  const sign = e.rate > 0 ? 1 : e.rate < 0 ? -1 : 0;
  const prev = s.fundingSign;
  s.fundingSign = sign;
  if (prev === null || sign === 0 || prev === 0 || prev === sign) return;
  fireTrigger({
    type: 'funding_flip',
    priority: 2,
    symbol: e.symbol,
    detail: `funding_flip:${e.symbol} ${prev > 0 ? '+' : '-'}→${sign > 0 ? '+' : '-'} rate=${e.rate}`,
    reason: `Woken by: funding rate on ${e.symbol} flipped ${prev > 0 ? 'positive → negative' : 'negative → positive'} (${(e.rate * 100).toFixed(4)}%).`,
  });
}

// ── intel triggers (IMPL-3b) ───────────────────────────────────────────
//
// News/whale/macro are GLOBAL: they carry no tradable symbol, so they wake
// every running bot (symbol = null in fireTrigger). `news_burst` and
// `macro_shock` are latched — the underlying reading stays above its
// threshold for hours, and a level is not an event: only the crossing is.

/** Yahoo symbol → indicator name ('GC=F' → 'gold'). */
const MACRO_NAME_BY_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.entries(MACRO_SYMBOLS).map(([name, sym]) => [sym, name]),
);

let newsBurstOn = false;
const macroShockOn = new Set<string>();

function usdText(usd: number): string {
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

function onWhale(e: WhaleEvent): void {
  if (!isMarketWarm()) return;
  try {
    const intel = getIntelThresholds();
    if (!intel.notify.whale_big_move) return;
    if (e.usd === null || e.usd <= intel.whale_big_move_usd) return;
    const where =
      e.direction === 'inflow'
        ? 'INTO an exchange wallet'
        : e.direction === 'outflow'
          ? 'OUT of an exchange wallet'
          : 'between whale wallets';
    const tag = e.addressTag ? ` (${e.addressTag})` : '';
    fireTrigger({
      type: 'whale_big_move',
      priority: TRIGGER_PRIORITY.whale_big_move ?? 1,
      symbol: null,
      scopeKey: e.chain,
      detail: `whale_big_move:${e.chain} ${e.amount.toFixed(2)} ${usdText(e.usd)} ${e.direction}${tag}`,
      reason: `Woken by: a whale moved ${e.amount.toFixed(2)} ${e.chain.toUpperCase()} (~${usdText(e.usd)}) ${where}${tag}.`,
    });
  } catch (err) {
    logger.error({ err, tx: e.tx }, 'trigger-engine: whale handler failed');
  }
}

function onNews(e: NewsEvent): void {
  if (!isMarketWarm()) return;
  try {
    const intel = getIntelThresholds();
    if (!intel.notify.news_burst) return;
    const ratio = newsBurstRatio(e.ts);
    if (ratio === null) return;
    if (ratio <= intel.news_burst_trigger_ratio) {
      newsBurstOn = false;
      return;
    }
    if (newsBurstOn) return; // already inside this burst
    newsBurstOn = true;
    fireTrigger({
      type: 'news_burst',
      priority: TRIGGER_PRIORITY.news_burst ?? 2,
      symbol: null,
      detail: `news_burst ratio=${ratio.toFixed(2)}x vs 7d hourly baseline · latest: ${e.title.slice(0, 90)}`,
      reason: `Woken by: crypto headline volume is ${ratio.toFixed(1)}× its usual hourly rate. Latest headline: "${e.title}".`,
    });
  } catch (err) {
    logger.error({ err }, 'trigger-engine: news handler failed');
  }
}

function onMacro(e: MacroEvent): void {
  if (!isMarketWarm()) return;
  try {
    const intel = getIntelThresholds();
    if (!intel.notify.macro_shock) return;
    if (e.changePct === null) return;
    const name = MACRO_NAME_BY_SYMBOL[e.symbol];
    if (!name) return;
    const limit = intel.macro_shock_pct[name as keyof typeof intel.macro_shock_pct];
    if (typeof limit !== 'number') return;
    if (Math.abs(e.changePct) <= limit) {
      macroShockOn.delete(name);
      return;
    }
    if (macroShockOn.has(name)) return; // still the same shock
    macroShockOn.add(name);
    const dir = e.changePct >= 0 ? 'up' : 'down';
    fireTrigger({
      type: 'macro_shock',
      priority: TRIGGER_PRIORITY.macro_shock ?? 2,
      symbol: null,
      scopeKey: name,
      detail: `macro_shock:${name} ${e.changePct.toFixed(2)}% (limit ${limit}%) price=${e.price}`,
      reason: `Woken by: ${name.toUpperCase()} moved ${Math.abs(e.changePct).toFixed(2)}% ${dir} on the day (more than the ${limit}% shock threshold).`,
    });
  } catch (err) {
    logger.error({ err, symbol: e.symbol }, 'trigger-engine: macro handler failed');
  }
}

// ── lifecycle ──────────────────────────────────────────────────────────

let started = false;
const unsubs: Array<() => void> = [];
let refreshTimer: NodeJS.Timeout | null = null;

export function startTriggerEngine(): void {
  if (started) return;
  started = true;
  primeState();
  refreshPositions();
  unsubs.push(eventBus.on('tick', onTick));
  unsubs.push(eventBus.on('indicator', onIndicator));
  unsubs.push(eventBus.on('candle', onCandle));
  unsubs.push(eventBus.on('funding', onFunding));
  unsubs.push(eventBus.on('fill', () => refreshPositions()));
  unsubs.push(eventBus.on('whale', onWhale));
  unsubs.push(eventBus.on('news', onNews));
  unsubs.push(eventBus.on('macro', onMacro));
  refreshTimer = setInterval(() => {
    try {
      refreshPositions();
    } catch (err) {
      logger.error({ err }, 'trigger-engine: position refresh failed');
    }
  }, POSITION_REFRESH_MS);
  refreshTimer.unref();
  logger.info('trigger-engine started');
}

export function stopTriggerEngine(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  for (const u of unsubs.splice(0)) u();
  started = false;
}

export function isTriggerEngineRunning(): boolean {
  return started;
}
