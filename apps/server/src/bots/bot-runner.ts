/**
 * Bot runner (IMPL-3 §4.2) — executes wakes, one at a time per bot.
 *
 * Queue: per-bot pending depth is 1. A wake arriving while another is
 * pending ABSORBS it (latest trigger reason wins) — a volatile hour that
 * fires five triggers must produce one decision with the freshest reason,
 * not five decisions. Global concurrency is capped at 3 LLM calls in flight
 * so one slow free endpoint can't stall the others (PLAN §16.7).
 *
 * A wake is PLAN §8 steps 1–6, in order:
 *   1. gates (status, per-bot floor, trades left, LLM pool) — BEFORE any
 *      snapshot work (IMPL-3 pitfall: no wasted DB reads on gated wakes)
 *   2. snapshot   3. prompt   4. router   5. risk-guards   6. execute + row + SSE
 *
 * Nothing in here throws into the event loop: the router never throws, the
 * engine returns typed rejections, and runWake wraps everything.
 */

import type { DecisionEvent } from '@wick/shared';
import { db } from '../db/client.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';
import { nowMs } from '../util/time.js';
import { decide } from '../llm/router.js';
import { poolRemaining } from '../llm/quota.js';
import { getProviders } from '../llm/providers.js';
import { SnapshotDataError } from '../llm/snapshot.js';
import type { PromptBotConfig, Snapshot } from '../llm/prompt.js';
import {
  BASE_SLIP_RATE,
  FEE_RATE,
  buildGuardState,
  buy,
  getPositions,
  sell,
  type BotRow,
} from '../paper/engine.js';
import { checkAndClamp, resolveGuardConfig } from '../paper/risk-guards.js';
import { checkBusted, getBot, parseConfig, type BotConfig } from './bot-store.js';
import { buildBotSnapshot, pickSymbol } from './snapshot.js';

export type WakePriority = 1 | 2 | 3;

export interface WakeRequest {
  botId: number;
  /** trigger_type column: 'scheduled' | 'rsi_cross' | 'position_event' | … */
  triggerType: string;
  /** trigger_detail column: machine-ish detail, e.g. 'rsi_cross:SOLUSDT 68→72'. */
  triggerDetail: string;
  /** Prompt line: "Woken by: RSI(1h) crossed 70 on SOL". */
  reason: string;
  symbol: string | null;
  priority: WakePriority;
}

export type WakeOutcome =
  | { status: 'decided'; decisionId: number; action: string; decisionStatus: string }
  | { status: 'skipped'; reason: string };

/** Global cap on concurrent LLM calls (PLAN §16.7). */
export const MAX_IN_FLIGHT = 3;

const pending = new Map<number, WakeRequest>();
const busy = new Set<number>();
let inFlight = 0;
let idleWaiters: Array<() => void> = [];

export interface RunnerStats {
  queued: number;
  absorbed: number;
  executed: number;
  skipped: number;
}

const stats: RunnerStats = { queued: 0, absorbed: 0, executed: 0, skipped: 0 };

export function runnerStats(): RunnerStats {
  return { ...stats };
}

export function resetRunner(): void {
  pending.clear();
  busy.clear();
  inFlight = 0;
  idleWaiters = [];
  stats.queued = 0;
  stats.absorbed = 0;
  stats.executed = 0;
  stats.skipped = 0;
}

export function queueDepth(botId: number): number {
  return pending.has(botId) ? 1 : 0;
}

export function isIdle(): boolean {
  return inFlight === 0 && pending.size === 0;
}

/** Resolves once every queued wake has finished (tests / shutdown). */
export function waitForIdle(): Promise<void> {
  if (isIdle()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    idleWaiters.push(resolve);
  });
}

function settleIdle(): void {
  if (!isIdle()) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const w of waiters) w();
}

/**
 * Enqueue a wake. Depth stays 1 per bot: a second request while one is
 * pending replaces it ('absorbed') so the bot decides once on the freshest
 * reason.
 */
export function requestWake(req: WakeRequest): 'queued' | 'absorbed' {
  const absorbed = pending.has(req.botId);
  pending.set(req.botId, req);
  if (absorbed) {
    stats.absorbed += 1;
    logger.debug({ bot: req.botId, trigger: req.triggerType }, 'wake absorbed into pending wake');
  } else {
    stats.queued += 1;
  }
  // Deferred to a microtask so several triggers fired in the SAME tick (a
  // volatile candle close) coalesce into one wake instead of one execution
  // plus a queued leftover.
  queueMicrotask(() => {
    void pump();
  });
  return absorbed ? 'absorbed' : 'queued';
}

async function pump(): Promise<void> {
  while (inFlight < MAX_IN_FLIGHT) {
    let next: WakeRequest | null = null;
    for (const [botId, req] of pending) {
      if (busy.has(botId)) continue;
      next = req;
      pending.delete(botId);
      break;
    }
    if (!next) break;
    const req = next;
    busy.add(req.botId);
    inFlight += 1;
    void runWake(req)
      .catch((err: unknown) => {
        logger.error({ bot: req.botId, err }, 'bot wake crashed (should be impossible)');
      })
      .finally(() => {
        busy.delete(req.botId);
        inFlight -= 1;
        settleIdle();
        void pump();
      });
  }
  settleIdle();
}

// ── gates (PLAN §8 step 1) ─────────────────────────────────────────────

function perBotFloorMin(): number {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('triggers.thresholds') as
    | { value: string }
    | undefined;
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as { per_bot_wake_floor_min?: number };
      if (typeof parsed.per_bot_wake_floor_min === 'number') return parsed.per_bot_wake_floor_min;
    } catch {
      /* default */
    }
  }
  return 10;
}

/** Newest non-protector decision ts (protector exits must not block wakes). */
export function lastDecisionTs(botId: number): number | null {
  const row = db
    .prepare(
      "SELECT MAX(ts) AS m FROM decisions WHERE bot_id = ? AND COALESCE(trigger_type,'') != 'protector'",
    )
    .get(botId) as { m: number | null };
  return row.m;
}

function tradesToday(botId: number, ts: number): number {
  const dayStart = ts - (ts % 86_400_000);
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM fills WHERE bot_id = ? AND ts >= ?')
    .get(botId, dayStart) as { n: number };
  return row.n;
}

/**
 * PLAN §8 step 1. Returns null when the wake may proceed, else the skip
 * reason. Cheap queries only — no snapshot work happens before this passes.
 */
export function checkGates(bot: BotRow, cfg: BotConfig, ts: number): string | null {
  if (bot.status !== 'running') return `bot_${bot.status}`;
  const last = lastDecisionTs(bot.id);
  const floorMin = perBotFloorMin();
  if (last !== null && ts - last < floorMin * 60_000) {
    return `bot_floor_${((ts - last) / 60_000).toFixed(1)}min<${floorMin}min`;
  }
  // Trades-left gate: only when the bot is FLAT. Out of trades with a
  // position open it can still be woken to reassess — the guards then veto
  // any trade with `max_trades_day` (audit trail keeps the intent).
  if (tradesToday(bot.id, ts) >= cfg.max_trades_day && getPositions(bot.id).length === 0) {
    return `no_trades_left_today_${cfg.max_trades_day}`;
  }
  if (poolRemaining(getProviders(), ts) <= 0) return 'llm_pool_exhausted';
  return null;
}

// ── decision row + event ───────────────────────────────────────────────

interface DecisionRowInput {
  botId: number;
  ts: number;
  triggerType: string;
  triggerDetail: string;
  snapshotJson: string | null;
  action: 'buy' | 'sell' | 'wait';
  symbol: string | null;
  sizePct: number | null;
  confidence: number | null;
  reasoning: string | null;
  slPct: number | null;
  tpPct: number | null;
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
  status: 'executed' | 'vetoed' | 'llm_failed';
  vetoReason: string | null;
}

function insertDecision(row: DecisionRowInput): number {
  const info = db
    .prepare(
      `INSERT INTO decisions
         (bot_id, ts, trigger_type, trigger_detail, snapshot_json, action, symbol,
          size_pct, confidence, reasoning, sl_pct, tp_pct, provider, model,
          latency_ms, status, veto_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.botId,
      row.ts,
      row.triggerType,
      row.triggerDetail,
      row.snapshotJson,
      row.action,
      row.symbol,
      row.sizePct,
      row.confidence,
      row.reasoning,
      row.slPct,
      row.tpPct,
      row.provider,
      row.model,
      row.latencyMs,
      row.status,
      row.vetoReason,
    );
  return Number(info.lastInsertRowid);
}

function publishDecision(decisionId: number, row: DecisionRowInput): void {
  const evt: DecisionEvent = {
    id: decisionId,
    ts: row.ts,
    source: 'bot-runner',
    kind: 'decision',
    decisionId,
    botId: row.botId,
    action: row.action,
    symbol: row.symbol,
    sizePct: row.sizePct,
    confidence: row.confidence,
    status: row.status,
    triggerType: row.triggerType,
    triggerDetail: row.triggerDetail,
    provider: row.provider,
    model: row.model,
    latencyMs: row.latencyMs,
    vetoReason: row.vetoReason,
    reasoning: row.reasoning,
  };
  eventBus.emit(evt);
}

/** snapshot_json = the snapshot plus a `meta` block (run id lives here). */
function snapshotJson(snapshot: Snapshot, cfg: BotConfig, req: WakeRequest): string {
  return JSON.stringify({
    ...snapshot,
    meta: {
      run: cfg.run,
      botId: req.botId,
      triggerType: req.triggerType,
      triggerDetail: req.triggerDetail,
      priority: req.priority,
      cadenceTf: cfg.cadence_tf,
    },
  });
}

function promptConfig(bot: BotRow, cfg: BotConfig): PromptBotConfig {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('guards.defaults') as
    | { value: string }
    | undefined;
  let fee = FEE_RATE * 100;
  let slip = BASE_SLIP_RATE * 100;
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as { fee_pct_per_side?: number; slippage_pct?: number };
      if (typeof parsed.fee_pct_per_side === 'number') fee = parsed.fee_pct_per_side;
      if (typeof parsed.slippage_pct === 'number') slip = parsed.slippage_pct;
    } catch {
      /* defaults */
    }
  }
  return {
    name: bot.name,
    personality: cfg.personality,
    minConfidence: cfg.min_confidence,
    feePctPerSide: fee,
    slippagePct: slip,
  };
}

// ── the wake itself ────────────────────────────────────────────────────

export async function runWake(req: WakeRequest): Promise<WakeOutcome> {
  const ts = nowMs();
  const bot = getBot(req.botId);
  if (!bot) {
    stats.skipped += 1;
    return { status: 'skipped', reason: 'bot_not_found' };
  }
  const cfg = parseConfig(bot);
  const log = logger.child({ bot: bot.id });

  // 1. gates
  const gate = checkGates(bot, cfg, ts);
  if (gate !== null) {
    stats.skipped += 1;
    log.debug({ trigger: req.triggerType, gate }, 'wake gated');
    return { status: 'skipped', reason: gate };
  }

  // 2. snapshot
  const symbol = pickSymbol(bot, cfg, req.symbol, ts);
  let snapshot: Snapshot;
  try {
    snapshot = buildBotSnapshot(bot, cfg, symbol, req.reason, ts);
  } catch (err) {
    stats.skipped += 1;
    const reason = err instanceof SnapshotDataError ? 'no_market_data' : 'snapshot_failed';
    log.warn({ symbol, err }, 'wake skipped: snapshot unavailable');
    return { status: 'skipped', reason };
  }
  const snapJson = snapshotJson(snapshot, cfg, req);

  const base: DecisionRowInput = {
    botId: bot.id,
    ts,
    triggerType: req.triggerType,
    triggerDetail: req.triggerDetail,
    snapshotJson: snapJson,
    action: 'wait',
    symbol,
    sizePct: null,
    confidence: null,
    reasoning: null,
    slPct: null,
    tpPct: null,
    provider: null,
    model: null,
    latencyMs: null,
    status: 'executed',
    vetoReason: null,
  };

  // 3 + 4. prompt + router (never throws)
  const result = await decide(
    { botId: bot.id, providerOrder: cfg.provider_order, config: promptConfig(bot, cfg) },
    snapshot,
  );

  if (result.failed) {
    const row: DecisionRowInput = {
      ...base,
      symbol: null,
      action: 'wait',
      status: 'llm_failed',
      reasoning: result.reason.slice(0, 400),
      vetoReason: 'llm_failed',
    };
    const id = insertDecision(row);
    publishDecision(id, row);
    stats.executed += 1;
    log.warn({ reason: result.reason }, 'wake: llm failed, recorded as wait');
    return { status: 'decided', decisionId: id, action: 'wait', decisionStatus: 'llm_failed' };
  }

  const d = result.decision;
  const decided: DecisionRowInput = {
    ...base,
    action: d.action,
    symbol: d.symbol ?? (d.action === 'wait' ? symbol : null),
    sizePct: d.size_pct,
    confidence: d.confidence,
    reasoning: d.reasoning,
    slPct: d.sl_pct,
    tpPct: d.tp_pct,
    provider: result.provider,
    model: result.model,
    latencyMs: result.latencyMs,
  };

  // 5. guards
  const guardState = buildGuardState(bot.id, d.symbol);
  if (!guardState) {
    const row: DecisionRowInput = { ...decided, status: 'vetoed', vetoReason: 'no_guard_state' };
    const id = insertDecision(row);
    publishDecision(id, row);
    stats.executed += 1;
    return { status: 'decided', decisionId: id, action: d.action, decisionStatus: 'vetoed' };
  }

  const verdict = checkAndClamp(
    { id: bot.id, config: resolveGuardConfig(bot.config_json) },
    {
      action: d.action,
      symbol: d.symbol,
      size_pct: d.size_pct,
      confidence: d.confidence,
      sl_pct: d.sl_pct,
      tp_pct: d.tp_pct,
    },
    guardState,
  );

  if (verdict.verdict === 'veto') {
    const row: DecisionRowInput = {
      ...decided,
      status: 'vetoed',
      vetoReason: verdict.detail ? `${verdict.reason}: ${verdict.detail}` : verdict.reason,
    };
    const id = insertDecision(row);
    publishDecision(id, row);
    stats.executed += 1;
    log.info({ action: d.action, veto: verdict.reason }, 'decision vetoed by guards');
    return { status: 'decided', decisionId: id, action: d.action, decisionStatus: 'vetoed' };
  }

  // 6. execute
  const c = verdict.clamped;
  if (c.action === 'wait') {
    const row: DecisionRowInput = { ...decided, action: 'wait' };
    const id = insertDecision(row);
    publishDecision(id, row);
    stats.executed += 1;
    log.info({ confidence: d.confidence, provider: result.provider }, 'decision: wait');
    return { status: 'decided', decisionId: id, action: 'wait', decisionStatus: 'executed' };
  }

  const row: DecisionRowInput = {
    ...decided,
    symbol: c.symbol,
    sizePct: c.sizePct,
    slPct: c.slPct,
    tpPct: c.tpPct,
  };
  const id = insertDecision(row);

  const trade =
    c.action === 'buy'
      ? buy(bot.id, c.symbol as string, c.notionalUsd as number, {
          slPct: c.slPct,
          tpPct: c.tpPct,
          decisionId: id,
        })
      : sell(bot.id, c.symbol as string, c.sizePct as number, { decisionId: id });

  if (!trade.ok) {
    const vetoReason = `engine_${trade.reason}${trade.detail ? `: ${trade.detail}` : ''}`;
    db.prepare("UPDATE decisions SET status = 'vetoed', veto_reason = ? WHERE id = ?").run(
      vetoReason,
      id,
    );
    const failed: DecisionRowInput = { ...row, status: 'vetoed', vetoReason };
    publishDecision(id, failed);
    stats.executed += 1;
    log.warn({ action: c.action, reason: trade.reason }, 'decision rejected by paper engine');
    return { status: 'decided', decisionId: id, action: c.action, decisionStatus: 'vetoed' };
  }

  publishDecision(id, row);
  stats.executed += 1;
  log.info(
    { action: c.action, symbol: c.symbol, price: trade.fill.price, provider: result.provider },
    'decision executed',
  );
  checkBusted(bot.id); // PLAN §8: busted check after every fill
  return { status: 'decided', decisionId: id, action: c.action, decisionStatus: 'executed' };
}
