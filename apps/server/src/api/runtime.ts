/**
 * Runtime kv API — Phase 9.
 *
 * Exposes a narrow read/write surface over the `kv` table for the
 * Settings page. Only whitelisted keys are allowed; everything else is
 * rejected so this endpoint can't be used as a generic backdoor into
 * the DB. Values are stored as strings — callers (UI or bots) are
 * responsible for parsing numbers / booleans.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { logger } from '../util/logger.js';
import { nowSec } from '../util/time.js';

const WHITELIST = [
  'kill_switch',
  'max_order_notional',
  'max_open_positions_per_asset',
  'daily_loss_cap',
  'order_cooldown_seconds',
  'trading_mode',
  'live_max_orders_per_day',
  'live_order_global_cooldown_seconds',
] as const;
type AllowedKey = (typeof WHITELIST)[number];

const keySchema = z.enum(WHITELIST);
const putBodySchema = z.object({ value: z.string() });

function isAllowed(key: string): key is AllowedKey {
  return (WHITELIST as readonly string[]).includes(key);
}

function kvRead(key: string): { v: string; updated_at: number } | null {
  const row = db
    .prepare('SELECT v, updated_at FROM kv WHERE k = ?')
    .get(key) as { v: string; updated_at: number } | undefined;
  return row ?? null;
}

function kvWrite(key: string, value: string): void {
  const ts = nowSec();
  db.prepare(
    `INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
  ).run(key, value, ts);
}

export async function registerRuntimeRoutes(app: FastifyInstance): Promise<void> {
  // List — convenient for the Settings page. Returns all whitelisted
  // keys whether or not they've been written yet.
  app.get('/kv', async () => {
    const entries = WHITELIST.map((k) => {
      const row = kvRead(k);
      return {
        key: k,
        value: row?.v ?? null,
        updatedAt: row?.updated_at ?? null,
      };
    });
    return { entries };
  });

  app.get<{ Params: { key: string } }>('/kv/:key', async (req, reply) => {
    const parsedKey = keySchema.safeParse(req.params.key);
    if (!parsedKey.success || !isAllowed(req.params.key)) {
      return reply.code(400).send({ error: 'key not allowed' });
    }
    const row = kvRead(parsedKey.data);
    return {
      key: parsedKey.data,
      value: row?.v ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });

  app.put<{ Params: { key: string } }>('/kv/:key', async (req, reply) => {
    const parsedKey = keySchema.safeParse(req.params.key);
    if (!parsedKey.success || !isAllowed(req.params.key)) {
      return reply.code(400).send({ error: 'key not allowed' });
    }
    const parsedBody = putBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      return reply
        .code(400)
        .send({ error: 'bad body', issues: parsedBody.error.issues });
    }
    kvWrite(parsedKey.data, parsedBody.data.value);
    logger.info({ key: parsedKey.data }, 'runtime kv updated');
    return { ok: true, key: parsedKey.data, value: parsedBody.data.value };
  });
}
