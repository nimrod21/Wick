/**
 * Intel API (IMPL-3b) — read-only views over the three source tables the
 * IMPL-3a collectors fill, plus the notification history.
 *
 *   GET /api/intel/news?asset&source&limit    news_items + filter options
 *   GET /api/intel/whales?minUsd&limit        whale_moves
 *   GET /api/intel/macro?points               macro tiles + fear & greed
 *   GET /api/notifications?limit&hours        trigger_log, one row per event
 *
 * Nothing here computes: the indicators already read the same tables through
 * their own helpers, and duplicating that logic in the API would give the
 * page a second opinion. Live prices come from the collector's
 * last-known-good cache (`getMacroQuotes`), history from `macro_quotes`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { getLatestFearGreed } from '../collectors/macro/fear-greed.js';
import { getMacroQuotes, MACRO_SYMBOLS } from '../collectors/macro/yahoo-macro.js';
import { TRIGGER_PRIORITY } from '../market/trigger-engine.js';
import { nowMs } from '../util/time.js';

const HOUR_MS = 3_600_000;

const newsQuerySchema = z.object({
  asset: z.string().min(1).max(12).optional(),
  source: z.string().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const whalesQuerySchema = z.object({
  minUsd: z.coerce.number().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const macroQuerySchema = z.object({
  points: z.coerce.number().int().min(2).max(1000).default(200),
});

const notificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  hours: z.coerce.number().int().min(1).max(24 * 30).default(48),
});

interface NewsRow {
  id: number;
  ts: number;
  source: string;
  title: string;
  url: string;
  assets_json: string;
  sentiment: number | null;
}

function parseAssets(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export async function registerIntelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/news', async (req, reply) => {
    const parsed = newsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const { asset, source, limit } = parsed.data;

    const where: string[] = [];
    const args: Array<string | number> = [];
    if (asset) {
      // assets_json is a JSON array of base tickers; quoting the needle keeps
      // the substring match exact ("BTC" never matches "BTCB").
      where.push('assets_json LIKE ?');
      args.push(`%"${asset.toUpperCase()}"%`);
    }
    if (source) {
      where.push('source = ?');
      args.push(source);
    }
    const rows = db
      .prepare(
        `SELECT id, ts, source, title, url, assets_json, sentiment FROM news_items
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(...args, limit) as NewsRow[];

    // Filter options come from the UNFILTERED table, otherwise picking one
    // source would erase every other option from the dropdown.
    const sources = (
      db.prepare('SELECT DISTINCT source FROM news_items ORDER BY source').all() as Array<{
        source: string;
      }>
    ).map((r) => r.source);
    const assetSet = new Set<string>();
    for (const r of db
      .prepare('SELECT assets_json FROM news_items ORDER BY ts DESC LIMIT 1000')
      .all() as Array<{ assets_json: string }>) {
      for (const a of parseAssets(r.assets_json)) assetSet.add(a);
    }

    return {
      items: rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        source: r.source,
        title: r.title,
        url: r.url,
        assets: parseAssets(r.assets_json),
        sentiment: r.sentiment,
      })),
      sources,
      assets: [...assetSet].sort(),
    };
  });

  app.get('/whales', async (req, reply) => {
    const parsed = whalesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const { minUsd, limit } = parsed.data;
    const rows = db
      .prepare(
        `SELECT id, ts, chain, amount, usd, direction, tx, address_tag FROM whale_moves
          WHERE (? = 0 OR (usd IS NOT NULL AND usd >= ?))
          ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(minUsd, minUsd, limit) as Array<{
      id: number;
      ts: number;
      chain: string;
      amount: number;
      usd: number | null;
      direction: string;
      tx: string;
      address_tag: string | null;
    }>;
    return {
      moves: rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        chain: r.chain,
        amount: r.amount,
        usd: r.usd,
        direction: r.direction,
        tx: r.tx,
        addressTag: r.address_tag,
      })),
    };
  });

  app.get('/macro', async (req, reply) => {
    const parsed = macroQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const cached = getMacroQuotes();
    const historyStmt = db.prepare(
      'SELECT ts, price FROM macro_quotes WHERE symbol = ? ORDER BY ts DESC LIMIT ?',
    );

    const tiles = Object.entries(MACRO_SYMBOLS).map(([name, symbol]) => {
      const history = (
        historyStmt.all(symbol, parsed.data.points) as Array<{ ts: number; price: number }>
      ).reverse();
      const quote = cached[name];
      // Before the first poll of a fresh process the cache is empty — the
      // table still knows the last price, it just cannot know the day change.
      const last = history[history.length - 1];
      return {
        name,
        symbol,
        price: quote?.price ?? last?.price ?? null,
        changePct: quote?.changePct ?? null,
        ts: quote?.ts ?? last?.ts ?? null,
        stale: quote === undefined,
        history,
      };
    });

    const fg = getLatestFearGreed();
    return {
      tiles,
      fearGreed: fg ? { value: fg.value, classification: fg.classification, ts: fg.ts } : null,
    };
  });
}

/**
 * Notification history: `trigger_log` collapsed to one row per real-world
 * event. The engine writes one row PER BOT per evaluation (and appends the
 * gate reason to `detail`), which is exactly right for the bot trigger tab
 * and exactly wrong for a bell — so the gate suffix is stripped and the rows
 * are grouped back into the event that produced them.
 */
export async function registerNotificationsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const parsed = notificationsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const since = nowMs() - parsed.data.hours * HOUR_MS;
    const rows = db
      .prepare(
        `SELECT MAX(id) AS id, MAX(ts) AS ts, type, base_detail AS detail,
                MAX(fired) AS fired, COUNT(*) AS n
           FROM (
             SELECT id, ts, type, fired,
                    CASE WHEN instr(detail, ' [') > 0
                         THEN substr(detail, 1, instr(detail, ' [') - 1)
                         ELSE detail END AS base_detail
               FROM trigger_log WHERE ts >= ?
           )
          GROUP BY type, base_detail
          ORDER BY ts DESC LIMIT ?`,
      )
      .all(since, parsed.data.limit) as Array<{
      id: number;
      ts: number;
      type: string;
      detail: string | null;
      fired: number;
      n: number;
    }>;

    return {
      notifications: rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        type: r.type,
        detail: r.detail,
        priority: TRIGGER_PRIORITY[r.type] ?? 3,
        fired: r.fired === 1,
        botRows: r.n,
      })),
    };
  });
}
