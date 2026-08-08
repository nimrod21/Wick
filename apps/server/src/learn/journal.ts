/**
 * Journal & standing lessons (IMPL-3 §5.3, PLAN §11.3) — the bot's memory of
 * its own behaviour.
 *
 * Two very different writers:
 *
 *  1. REFLECTIONS — pure code, no LLM. One line per executed trade decision
 *     the moment its 4h outcome lands: what it did, why it woke, how it went,
 *     and which indicator votes were right. Vote names are the indicator names
 *     verbatim so `journal` text and `indicator_stats` rows join 1:1
 *     (IMPL-3 pitfall #5).
 *
 *  2. LESSONS — one LLM call per bot per day, the ONLY non-decision LLM spend
 *     in Wick. It compresses the last 7 days of reflections + the current
 *     stats table + the previous lessons into <= 10 standing bullets, which
 *     ride along in every prompt. It REPLACES `lessons_current` (a bounded
 *     artifact, IMPL-3 pitfall #4) and on failure changes nothing at all —
 *     yesterday's lessons simply stand for another day.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { OutcomeEvent } from '@wick/shared';
import { db } from '../db/client.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';
import { nowMs } from '../util/time.js';
import { complete, type DecideOptions } from '../llm/router.js';
import { hashString } from '../bots/snapshot.js';
import { getBot, listRunningBots, parseConfig } from '../bots/bot-store.js';
import { listIndicatorStats, voteHit } from './indicator-stats.js';

const DAY_MS = 86_400_000;

/** Hard ceilings on the standing-lessons artifact (PLAN §11.3). */
export const MAX_LESSONS = 10;
export const MAX_LESSONS_CHARS = 1000;
const MAX_LESSON_CHARS = 200;

/** How much history the daily compression looks at. */
const LESSON_WINDOW_DAYS = 7;
const MAX_REFLECTIONS_IN_PROMPT = 60;

/** Lesson calls are staggered across this window so N bots don't burst. */
const LESSON_STAGGER_MS = 10 * 60_000;

// ── 1. reflections (code template, no LLM) ─────────────────────────────

interface DecisionForReflection {
  id: number;
  bot_id: number;
  ts: number;
  trigger_type: string | null;
  action: string;
  symbol: string | null;
  confidence: number | null;
  status: string;
  snapshot_json: string | null;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function votesOf(snapshotJson: string | null): Array<{ name: string; vote: string | null }> {
  if (!snapshotJson) return [];
  try {
    const parsed = JSON.parse(snapshotJson) as { indicators?: Array<{ name?: unknown; vote?: unknown }> };
    if (!Array.isArray(parsed.indicators)) return [];
    return parsed.indicators
      .filter((i): i is { name: string; vote: unknown } => typeof i?.name === 'string')
      .map((i) => ({ name: i.name, vote: typeof i.vote === 'string' ? i.vote : null }));
  } catch {
    return [];
  }
}

/**
 * The reflection line. Example:
 *   "Bought SOLUSDT on volume_spike at conf 72 → -1.80% @4h (score -1.03).
 *    Votes right: macd. Wrong: rsi14, ema_trend."
 */
export function reflectionText(d: DecisionForReflection, fwdRetPct: number, score: number): string {
  const verb = d.action === 'buy' ? 'Bought' : d.action === 'sell' ? 'Sold' : 'Waited on';
  const symbol = d.symbol ?? 'BTCUSDT';
  const conf = d.confidence === null ? 'n/a' : String(Math.round(d.confidence));
  const trigger = d.trigger_type ?? 'unknown';

  const right: string[] = [];
  const wrong: string[] = [];
  for (const v of votesOf(d.snapshot_json)) {
    const hit = voteHit(v.vote, fwdRetPct);
    if (hit === null) continue;
    (hit ? right : wrong).push(v.name);
  }

  const head = `${verb} ${symbol} on ${trigger} at conf ${conf} → ${fmtPct(fwdRetPct)} @4h (score ${score.toFixed(2)}).`;
  if (right.length === 0 && wrong.length === 0) return `${head} No directional votes to judge.`;
  const parts: string[] = [];
  if (right.length > 0) parts.push(`Votes right: ${right.join(', ')}.`);
  if (wrong.length > 0) parts.push(`Wrong: ${wrong.join(', ')}.`);
  return `${head} ${parts.join(' ')}`;
}

/**
 * Write the reflection for one evaluated decision. Only EXECUTED trades get
 * one (IMPL-3 §5.3) — waits and vetoes are already visible in the last-5
 * decisions block and would drown the journal. Returns the journal row id, or
 * null when the decision does not qualify.
 */
export function writeReflection(
  decisionId: number,
  fwdRetPct: number,
  score: number,
  ts: number = nowMs(),
): number | null {
  const d = db
    .prepare(
      `SELECT id, bot_id, ts, trigger_type, action, symbol, confidence, status, snapshot_json
         FROM decisions WHERE id = ?`,
    )
    .get(decisionId) as DecisionForReflection | undefined;
  if (!d) return null;
  if (d.status !== 'executed') return null;
  if (d.action !== 'buy' && d.action !== 'sell') return null;

  const info = db
    .prepare("INSERT INTO journal (bot_id, ts, kind, text) VALUES (?, ?, 'reflection', ?)")
    .run(d.bot_id, ts, reflectionText(d, fwdRetPct, score));
  return Number(info.lastInsertRowid);
}

// ── 2. daily lesson compression (one LLM call per bot per day) ─────────

export interface LessonsRow {
  text: string;
  updatedTs: number;
}

export function getLessons(botId: number): LessonsRow | null {
  const row = db.prepare('SELECT text, updated_ts FROM lessons_current WHERE bot_id = ?').get(botId) as
    | { text: string; updated_ts: number }
    | undefined;
  return row ? { text: row.text, updatedTs: row.updated_ts } : null;
}

/**
 * Pull bullets out of whatever the model replied with. Accepts "- ", "* ",
 * "• " and bare numbered lines; anything else is treated as a bullet only if
 * the reply contained no bullets at all. Enforces <= 10 bullets and the
 * 1000-char ceiling by dropping from the end.
 */
export function parseLessons(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const bulletish = lines.filter((l) => /^([-*•]|\d+[.)])\s+/.test(l));
  const source = bulletish.length > 0 ? bulletish : lines;

  const out: string[] = [];
  let total = 0;
  for (const raw of source) {
    const cleaned = raw.replace(/^([-*•]|\d+[.)])\s+/, '').trim().slice(0, MAX_LESSON_CHARS);
    if (cleaned.length === 0) continue;
    const cost = cleaned.length + 3; // "- " + newline
    if (total + cost > MAX_LESSONS_CHARS) break;
    out.push(cleaned);
    total += cost;
    if (out.length >= MAX_LESSONS) break;
  }
  return out;
}

function buildLessonPrompt(
  botId: number,
  botName: string,
  personality: string,
  ts: number,
): { system: string; user: string } {
  const since = ts - LESSON_WINDOW_DAYS * DAY_MS;
  const reflections = (
    db
      .prepare(
        `SELECT text FROM journal
          WHERE bot_id = ? AND kind = 'reflection' AND ts >= ?
          ORDER BY ts DESC LIMIT ?`,
      )
      .all(botId, since, MAX_REFLECTIONS_IN_PROMPT) as Array<{ text: string }>
  ).map((r) => r.text);

  const stats = listIndicatorStats(botId);
  const previous = getLessons(botId);

  const system = [
    `You are the trading journal of "${botName}", an autonomous crypto paper-trading bot. Personality: ${personality}`,
    ``,
    `Your job: compress the bot's recent record into STANDING LESSONS it should carry into every future decision.`,
    `- Be concrete and specific to what the record actually shows (symbols, indicators, trigger types, confidence levels).`,
    `- Prefer lessons about when NOT to trade; waiting is a valid, rewarded action.`,
    `- Keep a previous lesson only if the record still supports it. Drop what is stale. Never invent evidence.`,
    ``,
    `OUTPUT: at most ${MAX_LESSONS} bullets, one per line, each starting with "- ", each under ${MAX_LESSON_CHARS} characters, ${MAX_LESSONS_CHARS} characters total.`,
    `No preamble, no headings, no closing remarks — bullets only.`,
  ].join('\n');

  const statLines =
    stats.length === 0
      ? ['- none recorded yet']
      : stats.map(
          (s) =>
            `- ${s.indicator}: hit-rate ${s.hitRate === null ? 'n/a' : `${(s.hitRate * 100).toFixed(0)}%`} (n ${s.samples}, weight ${s.weight.toFixed(2)}, ${s.enabled ? 'enabled' : 'DISABLED'})`,
        );

  const user = [
    `Trade reflections from the last ${LESSON_WINDOW_DAYS} days (newest first):`,
    ...(reflections.length === 0 ? ['- none yet'] : reflections.map((r) => `- ${r}`)),
    ``,
    `Current indicator stats:`,
    ...statLines,
    ``,
    `Your previous standing lessons:`,
    ...(previous ? previous.text.split('\n').map((l) => (l.startsWith('-') ? l : `- ${l}`)) : ['- none yet']),
    ``,
    `Write the new standing lessons now. Bullets only.`,
  ].join('\n');

  return { system, user };
}

export type LessonResult =
  | { ok: true; lessons: string[]; provider: string; model: string }
  | { ok: false; reason: string };

/**
 * One lesson-compression call for one bot. On ANY failure (router exhausted,
 * unparseable reply) the previous `lessons_current` row is left exactly as it
 * was and the bot retries tomorrow — this never blocks trading.
 */
export async function compressLessons(
  botId: number,
  ts: number = nowMs(),
  opts: DecideOptions = {},
): Promise<LessonResult> {
  const bot = getBot(botId);
  if (!bot) return { ok: false, reason: 'bot_not_found' };
  const cfg = parseConfig(bot);

  const prompt = buildLessonPrompt(botId, bot.name, cfg.personality, ts);
  const res = await complete({ botId, providerOrder: cfg.provider_order }, prompt, opts);
  if (res.failed) {
    logger.warn({ bot: botId, reason: res.reason }, 'lesson compression failed — previous lessons stand');
    return { ok: false, reason: res.reason };
  }

  const lessons = parseLessons(res.text);
  if (lessons.length === 0) {
    logger.warn({ bot: botId, provider: res.provider }, 'lesson reply had no bullets — previous lessons stand');
    return { ok: false, reason: 'no_bullets' };
  }

  const text = lessons.map((l) => `- ${l}`).join('\n');
  db.transaction(() => {
    db.prepare("INSERT INTO journal (bot_id, ts, kind, text) VALUES (?, ?, 'lesson', ?)").run(
      botId,
      ts,
      text,
    );
    db.prepare(
      `INSERT INTO lessons_current (bot_id, text, updated_ts) VALUES (?, ?, ?)
       ON CONFLICT(bot_id) DO UPDATE SET text = excluded.text, updated_ts = excluded.updated_ts`,
    ).run(botId, text, ts);
  })();

  logger.info(
    { bot: botId, bullets: lessons.length, provider: res.provider, model: res.model },
    'lessons compressed',
  );
  return { ok: true, lessons, provider: res.provider, model: res.model };
}

/** Deterministic 0–10min offset so N bots don't call in the same second. */
export function lessonStaggerMs(botId: number): number {
  return hashString(`lesson:${botId}`) % LESSON_STAGGER_MS;
}

/** Daily pass over every running bot. Failures are per-bot and non-fatal. */
export async function runDailyLessons(ts: number = nowMs(), opts: DecideOptions = {}): Promise<number> {
  let ok = 0;
  for (const bot of listRunningBots()) {
    const res = await compressLessons(bot.id, ts, opts);
    if (res.ok) ok += 1;
  }
  return ok;
}

// ── lifecycle ──────────────────────────────────────────────────────────

let unsubscribe: (() => void) | null = null;
let task: ScheduledTask | null = null;
const timers = new Set<NodeJS.Timeout>();

export function startJournal(): void {
  if (!unsubscribe) {
    unsubscribe = eventBus.on('outcome', (evt: OutcomeEvent) => {
      if (evt.horizon !== '4h') return;
      try {
        writeReflection(evt.decisionId, evt.fwdRetPct, evt.score, evt.ts);
      } catch (err) {
        logger.error({ err, decision: evt.decisionId }, 'journal: reflection failed');
      }
    });
  }
  if (!task) {
    // Daily at 00:20 UTC — after the 00:05 indicator recompute, so the stats
    // the lesson call sees are the ones the next prompt will use.
    task = cron.schedule('20 0 * * *', () => {
      for (const bot of listRunningBots()) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          void compressLessons(bot.id).catch((err: unknown) => {
            logger.error({ err, bot: bot.id }, 'journal: lesson cron failed');
          });
        }, lessonStaggerMs(bot.id));
        timer.unref();
        timers.add(timer);
      }
    });
  }
  logger.info('journal started (reflections on 4h outcomes + daily lessons)');
}

export function stopJournal(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (task) {
    task.stop();
    task = null;
  }
  for (const t of timers) clearTimeout(t);
  timers.clear();
}
