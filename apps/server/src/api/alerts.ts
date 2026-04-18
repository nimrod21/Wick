/**
 * Alerts API — CRUD over `alert_rules` + paginated read for `alert_firings`.
 *
 * The alert engine (apps/server/src/core/alert-engine.ts) evaluates these
 * rules at runtime; every mutating endpoint calls `reloadRules()` so the
 * in-memory cache catches up without a server restart.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { nowSec } from '../util/time.js';
import { reloadRules } from '../core/alert-engine.js';
import type { AlertCondition, AlertChannel } from '@cockpit/shared';

// ── Zod schemas mirroring AlertCondition ──────────────────────────────

const channelSchema = z.enum(['browser', 'telegram']);
const channelsSchema = z.array(channelSchema).min(1).max(2);

const priceMoveSchema = z.object({
  type: z.literal('price_move'),
  assetId: z.number().int().positive(),
  pctChange: z.number().min(-1000).max(1000),
  windowSeconds: z.number().int().positive().max(7 * 24 * 3600),
  direction: z.enum(['up', 'down', 'either']),
});

const priceLevelSchema = z.object({
  type: z.literal('price_level'),
  assetId: z.number().int().positive(),
  operator: z.enum(['>', '<', '>=', '<=']),
  value: z.number(),
});

const whaleTxSchema = z.object({
  type: z.literal('whale_tx'),
  chain: z.enum(['eth', 'sol', 'btc']).optional(),
  minUsd: z.number().nonnegative(),
  direction: z.enum(['in', 'out', 'either']).optional(),
  addressFilter: z.array(z.string().min(1)).max(200).optional(),
});

const newsSchema = z.object({
  type: z.literal('news'),
  keywordsAny: z.array(z.string().min(1)).max(50).optional(),
  keywordsAll: z.array(z.string().min(1)).max(50).optional(),
  tickers: z.array(z.string().min(1)).max(50).optional(),
  minSentimentAbs: z.number().min(0).max(1).optional(),
});

const indicatorLevelSchema = z.object({
  type: z.literal('indicator_level'),
  name: z.string().min(1).max(100),
  operator: z.enum(['>', '<']),
  value: z.number(),
});

const indicatorCrossSchema = z.object({
  type: z.literal('indicator_cross'),
  name: z.string().min(1).max(100),
  direction: z.enum(['up', 'down']),
  threshold: z.number(),
});

const probabilitySchema = z.object({
  type: z.literal('probability'),
  assetId: z.number().int().positive(),
  horizon: z.enum(['1h', '4h', '24h']),
  operator: z.enum(['>', '<']),
  value: z.number().min(0).max(1),
});

const conditionSchema: z.ZodType<AlertCondition> = z.discriminatedUnion('type', [
  priceMoveSchema,
  priceLevelSchema,
  whaleTxSchema,
  newsSchema,
  indicatorLevelSchema,
  indicatorCrossSchema,
  probabilitySchema,
]);

const postBodySchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().optional(),
  condition: conditionSchema,
  channels: channelsSchema,
  cooldownSeconds: z.number().int().nonnegative().max(30 * 24 * 3600).optional(),
});

const patchBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    condition: conditionSchema.optional(),
    channels: channelsSchema.optional(),
    cooldownSeconds: z.number().int().nonnegative().max(30 * 24 * 3600).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: 'at least one field required',
  });

const firingsQuerySchema = z.object({
  ruleId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  before: z.coerce.number().int().nonnegative().optional(),
});

// ── Row shapes / mappers ──────────────────────────────────────────────

interface RuleRow {
  id: number;
  name: string;
  enabled: number;
  condition_json: string;
  channels_json: string;
  cooldown_seconds: number;
  last_fired_ts: number | null;
  created_at: number;
}

interface FiringRow {
  id: number;
  rule_id: number;
  ts: number;
  payload_json: string;
  delivered_json: string | null;
}

function rowToRule(r: RuleRow): Record<string, unknown> {
  let condition: AlertCondition | null = null;
  let channels: AlertChannel[] = [];
  try {
    condition = JSON.parse(r.condition_json) as AlertCondition;
  } catch {
    condition = null;
  }
  try {
    const parsed = JSON.parse(r.channels_json);
    channels = Array.isArray(parsed)
      ? (parsed.filter((c): c is AlertChannel => c === 'browser' || c === 'telegram'))
      : [];
  } catch {
    channels = [];
  }
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    condition,
    channels,
    cooldownSeconds: r.cooldown_seconds,
    lastFiredTs: r.last_fired_ts,
    createdAt: r.created_at,
  };
}

function rowToFiring(r: FiringRow): Record<string, unknown> {
  let payload: unknown = null;
  let delivered: unknown = null;
  try {
    payload = JSON.parse(r.payload_json);
  } catch {
    payload = null;
  }
  if (r.delivered_json) {
    try {
      delivered = JSON.parse(r.delivered_json);
    } catch {
      delivered = null;
    }
  }
  return {
    id: r.id,
    ruleId: r.rule_id,
    ts: r.ts,
    payload,
    delivered,
  };
}

// ── Routes ────────────────────────────────────────────────────────────

export async function registerAlertsRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/alerts ───────────────────────────────────────────────
  app.get('/', async () => {
    const rows = db
      .prepare(
        `SELECT id, name, enabled, condition_json, channels_json,
                cooldown_seconds, last_fired_ts, created_at
           FROM alert_rules
          ORDER BY created_at DESC`,
      )
      .all() as RuleRow[];
    return { rules: rows.map(rowToRule) };
  });

  // ── GET /api/alerts/firings ───────────────────────────────────────
  // Must be registered before '/:id' so it isn't captured by the param.
  app.get('/firings', async (req, reply) => {
    const parsed = firingsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const limit = parsed.data.limit ?? 50;
    const before = parsed.data.before ?? nowSec();
    const wheres: string[] = ['ts <= ?'];
    const params: Array<string | number> = [before];
    if (parsed.data.ruleId !== undefined) {
      wheres.push('rule_id = ?');
      params.push(parsed.data.ruleId);
    }
    const sql =
      `SELECT id, rule_id, ts, payload_json, delivered_json
         FROM alert_firings
        WHERE ${wheres.join(' AND ')}
        ORDER BY ts DESC
        LIMIT ?`;
    params.push(limit);
    const rows = db.prepare(sql).all(...params) as FiringRow[];
    return { firings: rows.map(rowToFiring) };
  });

  // ── GET /api/alerts/:id ───────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const row = db
      .prepare(
        `SELECT id, name, enabled, condition_json, channels_json,
                cooldown_seconds, last_fired_ts, created_at
           FROM alert_rules
          WHERE id = ?`,
      )
      .get(id) as RuleRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { rule: rowToRule(row) };
  });

  // ── POST /api/alerts ──────────────────────────────────────────────
  app.post('/', async (req, reply) => {
    const parsed = postBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad body', issues: parsed.error.issues });
    }
    const b = parsed.data;
    const enabled = b.enabled === false ? 0 : 1;
    const cooldown = b.cooldownSeconds ?? 300;
    const info = db
      .prepare(
        `INSERT INTO alert_rules
           (name, enabled, condition_json, channels_json,
            cooldown_seconds, last_fired_ts, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        b.name,
        enabled,
        JSON.stringify(b.condition),
        JSON.stringify(b.channels),
        cooldown,
        nowSec(),
      );
    reloadRules();
    const row = db
      .prepare(
        `SELECT id, name, enabled, condition_json, channels_json,
                cooldown_seconds, last_fired_ts, created_at
           FROM alert_rules WHERE id = ?`,
      )
      .get(info.lastInsertRowid) as RuleRow;
    return reply.code(201).send({ ok: true, rule: rowToRule(row) });
  });

  // ── PATCH /api/alerts/:id ─────────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const parsed = patchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad body', issues: parsed.error.issues });
    }
    const existing = db
      .prepare(
        `SELECT id, name, enabled, condition_json, channels_json,
                cooldown_seconds, last_fired_ts, created_at
           FROM alert_rules WHERE id = ?`,
      )
      .get(id) as RuleRow | undefined;
    if (!existing) return reply.code(404).send({ error: 'not found' });

    const next = {
      name: parsed.data.name ?? existing.name,
      enabled:
        parsed.data.enabled === undefined
          ? existing.enabled
          : parsed.data.enabled
            ? 1
            : 0,
      condition_json:
        parsed.data.condition === undefined
          ? existing.condition_json
          : JSON.stringify(parsed.data.condition),
      channels_json:
        parsed.data.channels === undefined
          ? existing.channels_json
          : JSON.stringify(parsed.data.channels),
      cooldown_seconds:
        parsed.data.cooldownSeconds === undefined
          ? existing.cooldown_seconds
          : parsed.data.cooldownSeconds,
    };

    db.prepare(
      `UPDATE alert_rules
          SET name = ?, enabled = ?, condition_json = ?, channels_json = ?,
              cooldown_seconds = ?
        WHERE id = ?`,
    ).run(
      next.name,
      next.enabled,
      next.condition_json,
      next.channels_json,
      next.cooldown_seconds,
      id,
    );
    reloadRules();
    const updated = db
      .prepare(
        `SELECT id, name, enabled, condition_json, channels_json,
                cooldown_seconds, last_fired_ts, created_at
           FROM alert_rules WHERE id = ?`,
      )
      .get(id) as RuleRow;
    return { ok: true, rule: rowToRule(updated) };
  });

  // ── DELETE /api/alerts/:id ────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const info = db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
    reloadRules();
    return { ok: true, removed: info.changes };
  });
}
