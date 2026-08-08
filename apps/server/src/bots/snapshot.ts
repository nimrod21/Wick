/**
 * Bot snapshot assembly (IMPL-3 §4.2) — pure assembly from DB + live caches.
 *
 * `llm/snapshot.ts` owns the market half (candles, indicators, funding, F&G);
 * this module owns the bot half (position + uPnL, cash/equity/drawdown, 7d
 * fee drag, last 5 decisions with their 4h outcomes, standing lessons,
 * trigger reason, guard-state sentence) and the symbol-in-focus choice.
 *
 * Weights/hit-rates come from this bot's `indicator_stats` (Phase 5) — the
 * bot id is threaded into `buildSnapshot` for exactly that. Built ONLY after
 * the runner's gates pass (IMPL-3 pitfall: no wasted DB work on gated wakes).
 */

import { db } from '../db/client.js';
import { buildSnapshot, type BotSnapshotState } from '../llm/snapshot.js';
import type { Snapshot, SnapshotPastDecision } from '../llm/prompt.js';
import {
  equity,
  getDrawdown,
  getPosition,
  getPositions,
  midPrice,
  type BotRow,
} from '../paper/engine.js';
import { nowMs } from '../util/time.js';
import type { BotConfig } from './bot-store.js';

const DAY_MS = 86_400_000;

/** Deterministic 32-bit string hash (no Math.random anywhere in bot paths). */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Which symbol a wake looks at. Trigger wakes name their symbol; a scheduled
 * wake focuses the oldest open position, else rotates deterministically over
 * the bot's watchlist (hash of bot id + candle index — no randomness, no
 * two bots locked to the same symbol).
 */
export function pickSymbol(
  bot: BotRow,
  cfg: BotConfig,
  triggerSymbol: string | null,
  ts: number = nowMs(),
): string {
  const symbols = cfg.symbols.length > 0 ? cfg.symbols : ['BTCUSDT'];
  if (triggerSymbol && symbols.includes(triggerSymbol.toUpperCase())) {
    return triggerSymbol.toUpperCase();
  }
  const open = getPositions(bot.id).filter((p) => symbols.includes(p.symbol));
  if (open.length > 0) return open[0]!.symbol; // getPositions() orders by opened_ts
  const slot = Math.floor(ts / 3_600_000) + hashString(`bot:${bot.id}`);
  return symbols[slot % symbols.length]!;
}

/** 7d fee drag: fees paid vs gross (pre-fee) realized P&L over the same window. */
function feeDrag7d(botId: number, ts: number): { fees7d: number; grossPnl7d: number } {
  const since = ts - 7 * DAY_MS;
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(fee), 0) AS fees,
         COALESCE(SUM(CASE WHEN side = 'sell' THEN qty * price ELSE -qty * price END), 0) AS gross
       FROM fills WHERE bot_id = ? AND ts >= ?`,
    )
    .get(botId, since) as { fees: number; gross: number };
  return { fees7d: row.fees, grossPnl7d: row.gross };
}

/** Last 5 decisions with their 4h outcome (PLAN §11 primary horizon). */
export function lastDecisions(botId: number, limit = 5): SnapshotPastDecision[] {
  const rows = db
    .prepare(
      `SELECT d.ts, d.action, d.symbol, d.size_pct, d.confidence, d.status,
              o.fwd_ret_pct, o.score
         FROM decisions d
         LEFT JOIN outcomes o ON o.decision_id = d.id AND o.horizon = '4h'
        WHERE d.bot_id = ?
        ORDER BY d.ts DESC LIMIT ?`,
    )
    .all(botId, limit) as Array<{
    ts: number;
    action: string;
    symbol: string | null;
    size_pct: number | null;
    confidence: number | null;
    status: string;
    fwd_ret_pct: number | null;
    score: number | null;
  }>;
  return rows.map((r) => ({
    ts: r.ts,
    action: r.action,
    symbol: r.symbol,
    sizePct: r.size_pct,
    confidence: r.confidence,
    status: r.status,
    fwdRet4hPct: r.fwd_ret_pct,
    score4h: r.score,
  }));
}

function currentLessons(botId: number): string[] {
  const row = db.prepare('SELECT text FROM lessons_current WHERE bot_id = ?').get(botId) as
    | { text: string }
    | undefined;
  if (!row) return [];
  return row.text
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 10);
}

/** "3 trades left today, cooldown 12min remaining." (PLAN §8 step 2). */
export function guardStateSentence(
  botId: number,
  cfg: BotConfig,
  symbol: string,
  ts: number = nowMs(),
): string {
  const dayStart = ts - (ts % DAY_MS);
  const today = db
    .prepare('SELECT COUNT(*) AS n FROM fills WHERE bot_id = ? AND ts >= ?')
    .get(botId, dayStart) as { n: number };
  const last = db.prepare('SELECT MAX(ts) AS m FROM fills WHERE bot_id = ?').get(botId) as {
    m: number | null;
  };
  const left = Math.max(0, cfg.max_trades_day - today.n);
  const parts = [`${left} trade${left === 1 ? '' : 's'} left today`];

  const cooldownLeft =
    last.m === null ? 0 : Math.max(0, cfg.cooldown_min - (ts - last.m) / 60_000);
  parts.push(cooldownLeft > 0 ? `cooldown ${Math.ceil(cooldownLeft)}min remaining` : 'no cooldown active');

  const pos = getPosition(botId, symbol);
  if (pos) {
    const heldMin = (ts - pos.opened_ts) / 60_000;
    const holdLeft = Math.max(0, cfg.min_hold_min - heldMin);
    parts.push(
      holdLeft > 0
        ? `min-hold ${Math.ceil(holdLeft)}min remaining before you may sell ${symbol}`
        : `${symbol} is past its min-hold, you may sell`,
    );
  } else {
    parts.push(`no open ${symbol} position`);
  }
  parts.push(`min confidence to trade ${cfg.min_confidence}`);
  return `${parts.join(', ')}.`;
}

/** The bot half of the snapshot (position, account, history, guard sentence). */
export function buildBotState(
  bot: BotRow,
  cfg: BotConfig,
  symbol: string,
  triggerReason: string,
  ts: number = nowMs(),
): BotSnapshotState {
  const pos = getPosition(bot.id, symbol);
  const mid = midPrice(symbol);
  const dd = getDrawdown(bot.id);
  const drag = feeDrag7d(bot.id, ts);

  return {
    position:
      pos && pos.qty > 0
        ? {
            qty: pos.qty,
            avgEntry: pos.avg_entry,
            uPnlPct: mid !== null ? ((mid - pos.avg_entry) / pos.avg_entry) * 100 : 0,
            stopPrice: pos.stop_price,
            tpPrice: pos.tp_price,
          }
        : null,
    account: {
      cash: bot.cash,
      equity: dd?.equity ?? equity(bot.id) ?? bot.cash,
      drawdownPct: dd?.drawdownPct ?? 0,
      fees7d: drag.fees7d,
      grossPnl7d: drag.grossPnl7d,
    },
    lastDecisions: lastDecisions(bot.id),
    lessons: currentLessons(bot.id),
    triggerReason,
    guardState: guardStateSentence(bot.id, cfg, symbol, ts),
  };
}

/**
 * Full snapshot for one wake. Throws `SnapshotDataError` (from llm/snapshot)
 * when the market tables have no data for `symbol` — the runner catches it.
 */
export function buildBotSnapshot(
  bot: BotRow,
  cfg: BotConfig,
  symbol: string,
  triggerReason: string,
  ts: number = nowMs(),
): Snapshot {
  return buildSnapshot(symbol, buildBotState(bot, cfg, symbol, triggerReason, ts), bot.id);
}
