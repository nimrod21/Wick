/**
 * Bot lifecycle store (IMPL-3 §4.1) — the `bots` table is the bot; this
 * module owns its config shape, CRUD, start/stop/reset and the busted check.
 *
 * Config defaults come from PLAN §8/§10 via the `guards.defaults` settings
 * row (data, not code); symbols default to the core of the active watchlist
 * (see DEFAULT_BOT_SYMBOLS) and provider_order to the live registry order.
 *
 * All SQL is prepared inside functions (module-level prepare crashes on a
 * fresh DB before migrations run). All ts values are UTC ms.
 */

import type { BotStatusEvent } from '@wick/shared';
import { db } from '../db/client.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';
import { nowMs } from '../util/time.js';
import { getProviders } from '../llm/providers.js';
import { equity, getBot, getDrawdown, getPositions, midPrice, type BotRow } from '../paper/engine.js';
import { GUARD_DEFAULTS } from '../paper/risk-guards.js';

export type BotStatus = 'running' | 'stopped' | 'busted';

/** PLAN §6 `config_json` shape (+ `run`, the reset counter). */
export interface BotConfig {
  cadence_tf: string;
  symbols: string[];
  provider_order: string[];
  model_prefs: string[];
  personality: string;
  min_confidence: number;
  max_trades_day: number;
  cooldown_min: number;
  min_hold_min: number;
  max_pos_pct: number;
  drawdown_kill_pct: number;
  default_sl_pct: number;
  default_tp_pct: number;
  /** Incremented by reset; stamped into every decision's snapshot_json meta. */
  run: number;
}

export const DEFAULT_DRAWDOWN_KILL_PCT = 50;

/**
 * How many watchlist symbols a NEW bot watches by default. Since IMPL-6B the
 * watchlist is ~50 symbols and every symbol is a block in the LLM prompt, so
 * the default is the core of the list (oldest-added first = the seeded
 * majors), not all of it. Existing bots keep whatever they were configured
 * with; the picker still offers the whole watchlist.
 */
const DEFAULT_BOT_SYMBOLS = 8;

interface GuardDefaultsRow {
  min_confidence?: number;
  cooldown_min?: number;
  min_hold_min?: number;
  max_trades_day?: number;
  max_pos_pct?: number;
  default_sl_pct?: number;
  default_tp_pct?: number;
  drawdown_kill_pct?: number;
}

function readGuardDefaults(): GuardDefaultsRow {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('guards.defaults') as
    | { value: string }
    | undefined;
  if (!row) return {};
  try {
    const parsed: unknown = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? (parsed as GuardDefaultsRow) : {};
  } catch {
    return {};
  }
}

/** Full config with every field populated (settings → PLAN defaults). */
export function defaultConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const g = readGuardDefaults();
  const symbols = (
    db
      .prepare('SELECT symbol FROM assets WHERE active = 1 ORDER BY added_ts, symbol LIMIT ?')
      .all(DEFAULT_BOT_SYMBOLS) as Array<{ symbol: string }>
  ).map((r) => r.symbol);
  return {
    cadence_tf: '1h',
    symbols: symbols.length > 0 ? symbols : ['BTCUSDT'],
    provider_order: getProviders().map((p) => p.id),
    model_prefs: [],
    personality: 'Balanced, evidence-driven crypto trader.',
    min_confidence: g.min_confidence ?? GUARD_DEFAULTS.minConfidence,
    max_trades_day: g.max_trades_day ?? GUARD_DEFAULTS.maxTradesDay,
    cooldown_min: g.cooldown_min ?? GUARD_DEFAULTS.cooldownMin,
    min_hold_min: g.min_hold_min ?? GUARD_DEFAULTS.minHoldMin,
    max_pos_pct: g.max_pos_pct ?? GUARD_DEFAULTS.maxPosPct,
    drawdown_kill_pct: g.drawdown_kill_pct ?? DEFAULT_DRAWDOWN_KILL_PCT,
    default_sl_pct: g.default_sl_pct ?? GUARD_DEFAULTS.defaultSlPct,
    default_tp_pct: g.default_tp_pct ?? GUARD_DEFAULTS.defaultTpPct,
    run: 1,
    ...overrides,
  };
}

/**
 * Parse a bot row's config_json, filling any missing field with defaults.
 *
 * Keys that are not part of `BotConfig` ride along untouched — `updateBot` and
 * `resetBot` serialize this object straight back into `config_json`, so
 * dropping an unknown key here would silently erase it (that is exactly how a
 * deposit used to wipe the human account's `kind:'human'` marker and make the
 * next boot mint a second account).
 */
export function parseConfig(bot: BotRow): BotConfig {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(bot.config_json);
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    /* defaults */
  }
  const base = defaultConfig();
  const out: BotConfig = { ...raw, ...base };
  for (const key of Object.keys(base) as Array<keyof BotConfig>) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (Array.isArray(base[key]) && Array.isArray(v)) {
      (out[key] as unknown) = v;
    } else if (typeof base[key] === typeof v) {
      (out[key] as unknown) = v;
    }
  }
  return out;
}

// ── reads ──────────────────────────────────────────────────────────────

export function listBots(): BotRow[] {
  return db.prepare('SELECT * FROM bots ORDER BY id').all() as BotRow[];
}

export function listRunningBots(): BotRow[] {
  return db.prepare("SELECT * FROM bots WHERE status = 'running' ORDER BY id").all() as BotRow[];
}

export { getBot };

/** Bot + derived numbers, the shape the API returns. */
export function botView(bot: BotRow): Record<string, unknown> {
  const dd = getDrawdown(bot.id);
  return {
    id: bot.id,
    name: bot.name,
    status: bot.status,
    bankrollStart: bot.bankroll_start,
    cash: bot.cash,
    equity: dd?.equity ?? equity(bot.id),
    highWaterMark: dd?.highWaterMark ?? null,
    drawdownPct: dd?.drawdownPct ?? null,
    config: parseConfig(bot),
    createdTs: bot.created_ts,
    stoppedTs: bot.stopped_ts,
    positions: getPositions(bot.id).length,
  };
}

// ── writes ─────────────────────────────────────────────────────────────

function publishStatus(bot: BotRow, status: BotStatus, reason: string): void {
  const evt: BotStatusEvent = {
    id: bot.id,
    ts: nowMs(),
    source: 'bot-store',
    kind: 'bot_status',
    botId: bot.id,
    status,
    reason,
    equity: equity(bot.id),
  };
  eventBus.emit(evt);
}

export interface CreateBotInput {
  name: string;
  bankroll: number;
  status?: BotStatus;
  config?: Partial<BotConfig>;
}

export function createBot(input: CreateBotInput): BotRow {
  const config = defaultConfig(input.config ?? {});
  const ts = nowMs();
  const info = db
    .prepare(
      `INSERT INTO bots (name, status, bankroll_start, cash, config_json, created_ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.name, input.status ?? 'stopped', input.bankroll, input.bankroll, JSON.stringify(config), ts);
  const bot = getBot(Number(info.lastInsertRowid)) as BotRow;
  logger.info({ bot: bot.id, name: bot.name, bankroll: input.bankroll }, 'bot created');
  publishStatus(bot, bot.status as BotStatus, 'created');
  return bot;
}

export interface UpdateBotInput {
  name?: string;
  config?: Partial<BotConfig>;
  /**
   * Bankroll top-up ("give the bot more money"): credited to cash AND added to
   * bankroll_start, so P&L stays measured against capital actually put in
   * (crediting cash alone would read as instant profit). Positive only —
   * withdrawals would have to reconcile against open positions.
   */
  addFunds?: number;
}

/** PATCH: rename, merge config fields, and/or top up the bankroll. */
export function updateBot(botId: number, patch: UpdateBotInput): BotRow | null {
  const bot = getBot(botId);
  if (!bot) return null;
  const merged: BotConfig = { ...parseConfig(bot), ...(patch.config ?? {}) };
  const funds = patch.addFunds !== undefined && patch.addFunds > 0 ? patch.addFunds : 0;
  db.prepare(
    `UPDATE bots SET name = ?, config_json = ?, cash = cash + ?, bankroll_start = bankroll_start + ?
       WHERE id = ?`,
  ).run(patch.name ?? bot.name, JSON.stringify(merged), funds, funds, botId);
  const updated = getBot(botId) as BotRow;
  if (funds > 0) {
    logger.info({ bot: botId, added: funds, cash: updated.cash }, 'bot bankroll topped up');
  }
  return updated;
}

/**
 * Hard delete (no archive): the bot row plus everything keyed to it —
 * decisions (and their outcomes, keyed by decision_id), fills, positions,
 * equity_snapshots, journal, lessons_current, indicator_stats, trigger_log.
 *
 * Delete over archive because none of these tables carry a soft-delete column
 * and every read path (`listBots`, stats, the model scoreboard) would need an
 * "is it a corpse?" filter for data no one asked to keep — `reset` already
 * covers "keep the bot, drop the run". Orphan rows are worse: `outcomes` and
 * `trigger_log` are joined by id, and a recycled bot id would silently inherit
 * a dead bot's history. Refused while `running` — stop it first, so no wake or
 * fill can be mid-flight against rows that are about to vanish.
 */
export function deleteBot(botId: number): 'deleted' | 'not_found' | 'running' {
  const bot = getBot(botId);
  if (!bot) return 'not_found';
  if (bot.status === 'running') return 'running';
  db.transaction(() => {
    db.prepare('DELETE FROM outcomes WHERE decision_id IN (SELECT id FROM decisions WHERE bot_id = ?)').run(botId);
    for (const table of ['decisions', 'fills', 'positions', 'equity_snapshots', 'journal', 'lessons_current', 'indicator_stats', 'trigger_log']) {
      db.prepare(`DELETE FROM ${table} WHERE bot_id = ?`).run(botId);
    }
    db.prepare('DELETE FROM bots WHERE id = ?').run(botId);
  })();
  logger.warn({ bot: botId, name: bot.name }, 'bot deleted');
  return 'deleted';
}

export function startBot(botId: number): BotRow | null {
  const bot = getBot(botId);
  if (!bot) return null;
  if (bot.status === 'busted') return bot; // a corpse must be reset first
  db.prepare("UPDATE bots SET status = 'running', stopped_ts = NULL WHERE id = ?").run(botId);
  const updated = getBot(botId) as BotRow;
  logger.info({ bot: botId }, 'bot started');
  publishStatus(updated, 'running', 'started');
  return updated;
}

export function stopBot(botId: number): BotRow | null {
  const bot = getBot(botId);
  if (!bot) return null;
  db.prepare("UPDATE bots SET status = 'stopped', stopped_ts = ? WHERE id = ?").run(nowMs(), botId);
  const updated = getBot(botId) as BotRow;
  logger.info({ bot: botId }, 'bot stopped');
  publishStatus(updated, 'stopped', 'stopped');
  return updated;
}

/**
 * Liquidate every open position at live mid — no fees, no fill rows (this is
 * bookkeeping, not a trade: reset and bust both use it). Positions with no
 * price are marked at avg entry. Returns USD credited.
 */
function liquidateAtMid(botId: number): number {
  const positions = getPositions(botId);
  if (positions.length === 0) return 0;
  let credit = 0;
  for (const p of positions) credit += p.qty * (midPrice(p.symbol) ?? p.avg_entry);
  db.transaction(() => {
    db.prepare('DELETE FROM positions WHERE bot_id = ?').run(botId);
    db.prepare('UPDATE bots SET cash = cash + ? WHERE id = ?').run(credit, botId);
  })();
  return credit;
}

/**
 * Reset: bump the run counter, liquidate at mid, restore cash = bankroll,
 * clear this bot's equity snapshots (the drawdown high-water mark is derived
 * from them, so an old run's peak would instantly bust the new one).
 * Decisions/fills keep their rows — queries filter by the run id stamped in
 * `snapshot_json.meta`.
 */
export function resetBot(botId: number): BotRow | null {
  const bot = getBot(botId);
  if (!bot) return null;
  const config = parseConfig(bot);
  const nextRun = config.run + 1;
  liquidateAtMid(botId);
  db.transaction(() => {
    db.prepare('DELETE FROM equity_snapshots WHERE bot_id = ?').run(botId);
    db.prepare('UPDATE bots SET cash = bankroll_start, config_json = ?, status = ?, stopped_ts = NULL WHERE id = ?').run(
      JSON.stringify({ ...config, run: nextRun }),
      bot.status === 'busted' ? 'stopped' : bot.status,
      botId,
    );
  })();
  const updated = getBot(botId) as BotRow;
  logger.info({ bot: botId, run: nextRun, cash: updated.cash }, 'bot reset');
  publishStatus(updated, updated.status as BotStatus, `reset to run ${nextRun}`);
  return updated;
}

/**
 * PLAN §8 lifecycle: equity ≤ 0 or drawdown ≥ kill % → `busted` (positions
 * liquidated at mid, bot halts, corpse stays inspectable). Called after every
 * fill and hourly. Returns true when the bot was just busted.
 */
export function checkBusted(botId: number): boolean {
  const bot = getBot(botId);
  if (!bot || bot.status !== 'running') return false;
  const dd = getDrawdown(botId);
  if (!dd) return false;
  const killPct = parseConfig(bot).drawdown_kill_pct;
  if (dd.equity > 0 && dd.drawdownPct < killPct) return false;

  liquidateAtMid(botId);
  db.prepare("UPDATE bots SET status = 'busted', stopped_ts = ? WHERE id = ?").run(nowMs(), botId);
  const updated = getBot(botId) as BotRow;
  const reason =
    dd.equity <= 0 ? 'equity <= 0' : `drawdown ${dd.drawdownPct.toFixed(1)}% >= ${killPct}%`;
  logger.warn({ bot: botId, equity: dd.equity, drawdownPct: dd.drawdownPct }, 'bot busted');
  publishStatus(updated, 'busted', reason);
  return true;
}

export function checkBustedAll(): number {
  let n = 0;
  for (const bot of listRunningBots()) if (checkBusted(bot.id)) n += 1;
  return n;
}

// ── human account (IMPL-4 trade) ───────────────────────────────────────

/** `config_json.kind` marking the one row that is Luka, not a bot. */
export const HUMAN_KIND = 'human';
export const HUMAN_NAME = 'You';
export const HUMAN_START_BANKROLL = 10_000;

/**
 * The manual trader is a normal `bots` row (`kind:'human'`, status permanently
 * `stopped`) so the paper engine, protector, equity cron and the model
 * scoreboard treat it exactly like a bot — nothing had to be re-implemented.
 * Nothing ever wakes it: the scheduler, trigger engine and journal all iterate
 * `listRunningBots()`, and `checkBusted` returns early for non-running rows.
 *
 * `kind` deliberately lives OUTSIDE `BotConfig`: `parseConfig` only keeps keys
 * that exist in the defaults, so the marker is read straight off `config_json`
 * and can never be dropped by a config merge.
 */
export function isHumanBot(bot: BotRow): boolean {
  try {
    const raw: unknown = JSON.parse(bot.config_json);
    return typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === HUMAN_KIND;
  } catch {
    return false;
  }
}

/** The fleet — every bot except the human account (bots page, dashboard). */
export function listTradingBots(): BotRow[] {
  return listBots().filter((b) => !isHumanBot(b));
}

export function getHumanBot(): BotRow | undefined {
  return listBots().find(isHumanBot);
}

/** Idempotent boot step: exactly one human account per install. */
export function ensureHumanAccount(): BotRow {
  const existing = getHumanBot();
  if (existing) return existing;
  const config = {
    ...defaultConfig({ personality: 'Manual trading — no LLM, no wakes.' }),
    kind: HUMAN_KIND,
  };
  const info = db
    .prepare(
      `INSERT INTO bots (name, status, bankroll_start, cash, config_json, created_ts)
       VALUES (?, 'stopped', ?, ?, ?, ?)`,
    )
    .run(HUMAN_NAME, HUMAN_START_BANKROLL, HUMAN_START_BANKROLL, JSON.stringify(config), nowMs());
  const bot = getBot(Number(info.lastInsertRowid)) as BotRow;
  logger.info({ bot: bot.id, bankroll: HUMAN_START_BANKROLL }, 'human trading account created');
  return bot;
}

// ── seed (IMPL-3 §4.1: two bots on first migrate) ──────────────────────

const SEED_BOTS: Array<{ name: string; bankroll: number; config: Partial<BotConfig> }> = [
  {
    name: 'Patience',
    bankroll: 1000,
    config: {
      personality:
        'Patient trend-follower — strongly prefers waiting. Only acts when trend, momentum and volume agree; treats every trade as expensive.',
      cadence_tf: '1h',
    },
  },
  {
    name: 'Contrarian',
    bankroll: 1000,
    config: {
      personality:
        'Contrarian dip-buyer — buys fear, sells greed. Looks for oversold extremes and capitulation volume; distrusts strong green candles.',
      cadence_tf: '1h',
    },
  },
];

/**
 * Insert the two default bots once (idempotent, keyed on name). Different
 * provider_order so the model-vs-model scoreboard has data from day one:
 * bot 2 gets the registry order rotated by one.
 */
export function seedDefaultBots(): number {
  const order = getProviders().map((p) => p.id);
  let created = 0;
  for (const [i, seed] of SEED_BOTS.entries()) {
    const existing = db.prepare('SELECT id FROM bots WHERE name = ?').get(seed.name) as
      | { id: number }
      | undefined;
    if (existing) continue;
    const providerOrder = order.length > 1 ? [...order.slice(i), ...order.slice(0, i)] : order;
    createBot({
      name: seed.name,
      bankroll: seed.bankroll,
      status: 'running',
      config: { ...seed.config, provider_order: providerOrder },
    });
    created += 1;
  }
  if (created > 0) logger.info({ created }, 'seeded default bots');
  return created;
}
