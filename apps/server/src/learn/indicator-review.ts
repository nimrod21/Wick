/**
 * Bot indicator agency (IMPL-7) — "each bot is his own guy".
 *
 * Ownership of an indicator's on/off belongs to the BOT. Once per cadence
 * (weekly by default, per-bot `review_days`) he gets ONE extra LLM call: his
 * whole stats table (on AND off — off ones keep accruing shadow votes), his
 * lessons, his recent P&L, and the system's advisories. He replies with
 * {enable, disable, reasoning}; code guards protect the frame and NEVER edit
 * his wish silently — a wish outside the frame is refused and logged as
 * `guard_veto` so the record shows what he wanted, not just what he got.
 *
 * LEAVE IT OPEN (IMPL-7): nothing here counts to 15. The stats table, the
 * guards, the log and the UI all read `INDICATOR_DEFS`, and the guards are
 * proportions/config — min active is max(floor, ceil(registered × fraction)).
 * Registering a new indicator requires zero changes to this file.
 *
 * QUOTA: exactly one `complete()` call per bot per review, staggered across a
 * window so N bots never burst. No repair retry — a malformed reply changes
 * nothing and he tries again next cadence. The optional drawdown trigger is
 * OFF by default (`review.config.drawdown_trigger_pct: null`).
 */

import { z } from 'zod';
import { db } from '../db/client.js';
import { logger } from '../util/logger.js';
import { nowMs } from '../util/time.js';
import { complete, extractJson, type DecideOptions } from '../llm/router.js';
import { buildReviewPrompt, type ReviewIndicatorRow } from '../llm/prompt.js';
import { getBot, listRunningBots, parseConfig } from '../bots/bot-store.js';
import { hashString } from '../bots/snapshot.js';
import { getDrawdown, equity as botEquity, type BotRow } from '../paper/engine.js';
import { INDICATOR_DEFS, listIndicatorDefs } from '../market/indicator-engine.js';
import {
  SAMPLE_FLOOR,
  getIndicatorStats,
  indicatorAdvisories,
  setIndicatorEnabled,
} from './indicator-stats.js';
import { getLessons, writeIndicatorChangeReflection } from './journal.js';

const DAY_MS = 86_400_000;

/** P&L window shown in the review prompt. */
const PNL_WINDOW_DAYS = 30;
/** How many prior changes he is reminded of. */
const RECENT_CHANGES_IN_PROMPT = 8;
/** Review calls are staggered across this window so N bots don't burst. */
export const REVIEW_STAGGER_MS = 30 * 60_000;
/** Rule text for an orphan stats row whose indicator left the registry. */
const RETIRED_RULE = 'retired — no longer registered';

// ── config (data, not code — settings row `review.config`) ─────────────

export interface ReviewConfig {
  /** Default cadence when a bot has no `review_days` of its own. */
  cadence_days: number;
  max_changes_per_review: number;
  cooldown_days: number;
  /** Absolute floor on active indicators. */
  min_active_floor: number;
  /** …and a proportion of the REGISTERED count; the larger of the two wins. */
  min_active_fraction: number;
  /** Extra review when drawdown since the last one exceeds this. null = off. */
  drawdown_trigger_pct: number | null;
}

export const REVIEW_DEFAULTS: ReviewConfig = {
  cadence_days: 7,
  max_changes_per_review: 3,
  cooldown_days: 7,
  min_active_floor: 5,
  min_active_fraction: 1 / 3,
  drawdown_trigger_pct: null,
};

export function getReviewConfig(): ReviewConfig {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('review.config') as
    | { value: string }
    | undefined;
  if (!row) return REVIEW_DEFAULTS;
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object') return REVIEW_DEFAULTS;
    return { ...REVIEW_DEFAULTS, ...(parsed as Partial<ReviewConfig>) };
  } catch {
    return REVIEW_DEFAULTS;
  }
}

/** max(floor, ceil(registered × fraction)) — never a hard-coded count. */
export function minActiveIndicators(cfg: ReviewConfig = getReviewConfig()): number {
  const registered = Object.keys(INDICATOR_DEFS).length;
  return Math.max(cfg.min_active_floor, Math.ceil(registered * cfg.min_active_fraction));
}

// ── the change log ─────────────────────────────────────────────────────

export type ChangeSource = 'bot' | 'user' | 'guard_veto';

export interface IndicatorChangeRow {
  id: number;
  bot_id: number;
  ts: number;
  indicator: string;
  action: 'on' | 'off';
  reasoning: string | null;
  source: ChangeSource;
}

export function listIndicatorChanges(botId: number, limit = 100): IndicatorChangeRow[] {
  return db
    .prepare(
      'SELECT * FROM bot_indicator_changes WHERE bot_id = ? ORDER BY ts DESC, id DESC LIMIT ?',
    )
    .all(botId, limit) as IndicatorChangeRow[];
}

function logChange(
  botId: number,
  indicator: string,
  action: 'on' | 'off',
  reasoning: string,
  source: ChangeSource,
  ts: number,
): void {
  db.prepare(
    `INSERT INTO bot_indicator_changes (bot_id, ts, indicator, action, reasoning, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(botId, ts, indicator, action, reasoning, source);
}

/** Last APPLIED flip of this indicator (vetoes never start a cooldown). */
function lastAppliedChangeTs(botId: number, indicator: string): number | null {
  const row = db
    .prepare(
      `SELECT MAX(ts) AS ts FROM bot_indicator_changes
        WHERE bot_id = ? AND indicator = ? AND source IN ('bot','user')`,
    )
    .get(botId, indicator) as { ts: number | null };
  return row.ts;
}

// ── guards ─────────────────────────────────────────────────────────────

export type VetoReason =
  | 'unknown_indicator'
  | 'conflicting_wish'
  | 'no_change'
  | 'cooldown'
  | 'max_changes'
  | 'min_active';

export interface ReviewOutcome {
  indicator: string;
  action: 'on' | 'off';
  applied: boolean;
  veto?: VetoReason;
}

export interface ApplyOptions {
  /** 'user' skips the cooldown guard (IMPL-7 §6: Luka's hand). */
  source: 'bot' | 'user';
  ts?: number;
  cfg?: ReviewConfig;
}

/**
 * Apply a set of wishes under the guards. Enables run first: raising the
 * active count before the disables are weighed is the friendlier order and
 * makes the result deterministic. Every refusal is logged as `guard_veto`.
 */
export function applyIndicatorWishes(
  botId: number,
  wishes: Array<{ indicator: string; action: 'on' | 'off' }>,
  reasoning: string,
  opts: ApplyOptions,
): ReviewOutcome[] {
  const ts = opts.ts ?? nowMs();
  const cfg = opts.cfg ?? getReviewConfig();
  const registered = new Set(Object.keys(INDICATOR_DEFS));
  const minActive = minActiveIndicators(cfg);
  const maxChanges = cfg.max_changes_per_review;
  const cooldownMs = cfg.cooldown_days * DAY_MS;

  // Current truth: a registered indicator with no stats row counts as ON.
  const stats = getIndicatorStats(botId);
  const active = new Set(
    [...registered].filter((name) => stats.get(name)?.enabled !== false),
  );

  const asked = new Set<string>();
  const conflicting = new Set<string>();
  for (const w of wishes) {
    if (asked.has(w.indicator)) conflicting.add(w.indicator);
    asked.add(w.indicator);
  }

  const ordered = [...wishes].sort((a, b) => (a.action === b.action ? 0 : a.action === 'on' ? -1 : 1));
  const outcomes: ReviewOutcome[] = [];
  let appliedCount = 0;

  for (const w of ordered) {
    const veto = ((): VetoReason | null => {
      if (!registered.has(w.indicator)) return 'unknown_indicator';
      if (conflicting.has(w.indicator)) return 'conflicting_wish';
      if (active.has(w.indicator) === (w.action === 'on')) return 'no_change';
      if (appliedCount >= maxChanges) return 'max_changes';
      if (opts.source !== 'user') {
        const last = lastAppliedChangeTs(botId, w.indicator);
        if (last !== null && ts - last < cooldownMs) return 'cooldown';
      }
      if (w.action === 'off' && active.size - 1 < minActive) return 'min_active';
      return null;
    })();

    if (veto !== null) {
      logChange(botId, w.indicator, w.action, `guard:${veto} — ${reasoning}`, 'guard_veto', ts);
      outcomes.push({ indicator: w.indicator, action: w.action, applied: false, veto });
      logger.info(
        { bot: botId, indicator: w.indicator, action: w.action, veto },
        'indicator review: guard vetoed a wish',
      );
      continue;
    }

    db.transaction(() => {
      setIndicatorEnabled(botId, w.indicator, w.action === 'on', ts);
      logChange(botId, w.indicator, w.action, reasoning, opts.source, ts);
      writeIndicatorChangeReflection(botId, w.indicator, w.action, reasoning, opts.source, ts);
    })();
    if (w.action === 'on') active.add(w.indicator);
    else active.delete(w.indicator);
    appliedCount += 1;
    outcomes.push({ indicator: w.indicator, action: w.action, applied: true });
    logger.info(
      { bot: botId, indicator: w.indicator, action: w.action, source: opts.source },
      'indicator change applied',
    );
  }

  return outcomes;
}

// ── the review call ────────────────────────────────────────────────────

const ReviewReplySchema = z.object({
  enable: z.array(z.string()).max(50).default([]),
  disable: z.array(z.string()).max(50).default([]),
  reasoning: z.string().max(2000).default(''),
});

/** Last review bookkeeping — a settings row per bot, no schema needed. */
interface LastReview {
  ts: number;
  equity: number;
}

function lastReviewKey(botId: number): string {
  return `review.last.${botId}`;
}

export function getLastReview(botId: number): LastReview | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(lastReviewKey(botId)) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<LastReview>;
    return typeof parsed.ts === 'number' ? { ts: parsed.ts, equity: parsed.equity ?? 0 } : null;
  } catch {
    return null;
  }
}

function setLastReview(botId: number, value: LastReview): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(lastReviewKey(botId), JSON.stringify(value));
}

function pnlBlock(bot: BotRow, ts: number): {
  equity: number;
  bankrollStart: number;
  pnlPct: number;
  drawdownPct: number;
  trades: number;
  meanScore4h: number | null;
  windowDays: number;
} {
  const since = ts - PNL_WINDOW_DAYS * DAY_MS;
  const dd = getDrawdown(bot.id);
  const eq = dd?.equity ?? botEquity(bot.id) ?? bot.cash;
  const trades = (
    db.prepare('SELECT COUNT(*) AS n FROM fills WHERE bot_id = ? AND ts >= ?').get(bot.id, since) as {
      n: number;
    }
  ).n;
  const score = (
    db
      .prepare(
        `SELECT AVG(o.score) AS s
           FROM decisions d JOIN outcomes o ON o.decision_id = d.id AND o.horizon = '4h'
          WHERE d.bot_id = ? AND d.ts >= ?`,
      )
      .get(bot.id, since) as { s: number | null }
  ).s;
  return {
    equity: eq,
    bankrollStart: bot.bankroll_start,
    pnlPct: bot.bankroll_start > 0 ? ((eq - bot.bankroll_start) / bot.bankroll_start) * 100 : 0,
    drawdownPct: dd?.drawdownPct ?? 0,
    trades,
    meanScore4h: score,
    windowDays: PNL_WINDOW_DAYS,
  };
}

/**
 * The stats table the review sees: EVERY registered indicator (with its vote
 * rule, so an unscored one can still be judged) plus any orphan stats row left
 * by a retired indicator — never a hard-coded list.
 */
export function reviewIndicatorRows(botId: number): ReviewIndicatorRow[] {
  const stats = getIndicatorStats(botId);
  const defs = listIndicatorDefs();
  const known = new Set(defs.map((d) => d.name));
  const rows: ReviewIndicatorRow[] = defs.map((d) => {
    const s = stats.get(d.name);
    return {
      name: d.name,
      enabled: s?.enabled ?? true,
      samples: s?.samples ?? 0,
      hits: s?.hits ?? 0,
      hitRate: s?.hitRate ?? null,
      weight: s?.weight ?? 1,
      rule: d.rule,
    };
  });
  for (const [name, s] of stats) {
    if (known.has(name)) continue;
    rows.push({
      name,
      enabled: s.enabled,
      samples: s.samples,
      hits: s.hits,
      hitRate: s.hitRate,
      weight: s.weight,
      rule: RETIRED_RULE,
    });
  }
  return rows;
}

export type ReviewResult =
  | {
      ok: true;
      outcomes: ReviewOutcome[];
      reasoning: string;
      provider: string;
      model: string;
    }
  | { ok: false; reason: string };

/**
 * One portfolio review for one bot. ONE LLM call, no retry. Any failure
 * (router exhausted, unparseable reply, schema mismatch) changes nothing —
 * his current set simply stands until the next cadence.
 */
export async function reviewIndicators(
  botId: number,
  ts: number = nowMs(),
  opts: DecideOptions = {},
): Promise<ReviewResult> {
  const bot = getBot(botId);
  if (!bot) return { ok: false, reason: 'bot_not_found' };
  const botCfg = parseConfig(bot);
  const cfg = getReviewConfig();

  const rows = reviewIndicatorRows(botId);
  const registered = Object.keys(INDICATOR_DEFS).length;
  const activeNow = rows.filter((r) => r.enabled && r.rule !== RETIRED_RULE).length;
  const pnl = pnlBlock(bot, ts);

  const prompt = buildReviewPrompt({
    botName: bot.name,
    personality: botCfg.personality,
    indicators: rows,
    lessons:
      getLessons(botId)
        ?.text.split('\n')
        .map((l) => l.replace(/^[-*•]\s*/, '').trim())
        .filter(Boolean) ?? [],
    advisories: indicatorAdvisories(botId, ts).map((a) => a.text),
    pnl,
    guards: {
      minActive: minActiveIndicators(cfg),
      maxChanges: cfg.max_changes_per_review,
      cooldownDays: cfg.cooldown_days,
      activeNow,
      registered,
      sampleFloor: SAMPLE_FLOOR,
    },
    recentChanges: listIndicatorChanges(botId, RECENT_CHANGES_IN_PROMPT).map(
      (c) =>
        `${new Date(c.ts).toISOString().slice(0, 10)} ${c.indicator} → ${c.action.toUpperCase()}${
          c.source === 'guard_veto' ? ' (refused by the frame)' : c.source === 'user' ? ' (set by Luka)' : ''
        }`,
    ),
  });

  const res = await complete({ botId, providerOrder: botCfg.provider_order }, prompt, opts);
  // The call happened (or was refused by every provider) — either way the
  // cadence advances, so a dead provider list can never queue up reviews.
  setLastReview(botId, { ts, equity: pnl.equity });
  if (res.failed) {
    logger.warn({ bot: botId, reason: res.reason }, 'indicator review failed — set unchanged');
    return { ok: false, reason: res.reason };
  }

  const parsedJson = extractJson(res.text);
  if (parsedJson === null) {
    logger.warn({ bot: botId, provider: res.provider }, 'indicator review reply had no JSON — set unchanged');
    return { ok: false, reason: 'no_json' };
  }
  const validated = ReviewReplySchema.safeParse(parsedJson);
  if (!validated.success) {
    logger.warn(
      { bot: botId, provider: res.provider, issues: validated.error.issues.length },
      'indicator review reply failed schema — set unchanged',
    );
    return { ok: false, reason: 'schema' };
  }

  const reply = validated.data;
  const reasoning = reply.reasoning.slice(0, 500) || 'no reasoning given';
  const wishes = [
    ...reply.enable.map((indicator) => ({ indicator, action: 'on' as const })),
    ...reply.disable.map((indicator) => ({ indicator, action: 'off' as const })),
  ];
  const outcomes = applyIndicatorWishes(botId, wishes, reasoning, { source: 'bot', ts, cfg });

  logger.info(
    {
      bot: botId,
      provider: res.provider,
      wishes: wishes.length,
      applied: outcomes.filter((o) => o.applied).length,
      vetoed: outcomes.filter((o) => !o.applied).length,
    },
    'indicator review complete',
  );
  return { ok: true, outcomes, reasoning, provider: res.provider, model: res.model };
}

// ── cadence ────────────────────────────────────────────────────────────

/** Deterministic 0–30min offset so N bots don't call in the same second. */
export function reviewStaggerMs(botId: number): number {
  return hashString(`review:${botId}`) % REVIEW_STAGGER_MS;
}

/**
 * Is this bot due? Cadence is per-bot (`review_days`, default from settings);
 * the optional drawdown trigger fires an EXTRA review when equity has fallen
 * more than `drawdown_trigger_pct` since the last one — still floored at one
 * day apart so a bad week cannot drain the quota.
 */
export function isReviewDue(bot: BotRow, ts: number = nowMs()): boolean {
  const cfg = getReviewConfig();
  const days = parseConfig(bot).review_days || cfg.cadence_days;
  const last = getLastReview(bot.id);
  if (last === null) return true;
  const age = ts - last.ts;
  if (age >= days * DAY_MS) return true;
  if (cfg.drawdown_trigger_pct === null || age < DAY_MS) return false;
  if (last.equity <= 0) return false;
  const eq = getDrawdown(bot.id)?.equity ?? botEquity(bot.id) ?? last.equity;
  const fallPct = ((last.equity - eq) / last.equity) * 100;
  return fallPct >= cfg.drawdown_trigger_pct;
}

/**
 * One pass over the running fleet. Each due bot costs exactly one LLM call;
 * bots that are not due cost nothing. Failures are per-bot and non-fatal.
 */
export async function runDueReviews(ts: number = nowMs(), opts: DecideOptions = {}): Promise<number> {
  let ok = 0;
  for (const bot of listRunningBots()) {
    if (!isReviewDue(bot, ts)) continue;
    const res = await reviewIndicators(bot.id, ts, opts);
    if (res.ok) ok += 1;
  }
  return ok;
}
