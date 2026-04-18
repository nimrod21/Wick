/**
 * Live-mode API — Phase 10.
 *
 * Endpoints:
 *   POST /api/live-mode/verify-permissions
 *     Checks the user's Binance key restrictions. Returns the flags the
 *     UI needs to render its checklist. No side effects.
 *
 *   POST /api/live-mode/activate  { confirmationText: "ACTIVATE LIVE" }
 *     Requires the exact phrase. Re-runs verify-permissions; if that
 *     fails the response mirrors the failure detail so the UI can
 *     display it. On success, sets `kv['trading_mode']='live'`.
 *
 *   POST /api/live-mode/deactivate
 *     Flips back to paper. Also clears the per-asset first-order
 *     confirmation set so a subsequent re-activation starts fresh.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { logger } from '../util/logger.js';
import { nowSec } from '../util/time.js';
import { verifyBinancePermissions } from '../execution/crypto-ccxt.js';
import { resetFirstLiveConfirmed } from '../execution/risk-guards.js';

const activateBodySchema = z.object({
  confirmationText: z.string(),
});

function kvWrite(key: string, value: string): void {
  const ts = nowSec();
  db.prepare(
    `INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
  ).run(key, value, ts);
}

function kvRead(key: string): string | null {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as
    | { v: string }
    | undefined;
  return row?.v ?? null;
}

export async function registerLiveModeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/verify-permissions', async () => {
    const result = await verifyBinancePermissions();
    return result;
  });

  app.post('/activate', async (req, reply) => {
    const parsed = activateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'bad_body', issues: parsed.error.issues });
    }
    if (parsed.data.confirmationText !== 'ACTIVATE LIVE') {
      return reply.code(400).send({
        error: 'confirmation_text_mismatch',
        detail: 'Must exactly type "ACTIVATE LIVE" to proceed.',
      });
    }

    const perms = await verifyBinancePermissions();
    if (!perms.ok) {
      return reply.code(400).send({
        error: 'permissions_check_failed',
        ...perms,
      });
    }

    kvWrite('trading_mode', 'live');
    logger.warn({ who: 'api', perms }, 'live trading mode ACTIVATED');
    return { ok: true, tradingMode: 'live', perms };
  });

  app.post('/deactivate', async () => {
    kvWrite('trading_mode', 'paper');
    resetFirstLiveConfirmed();
    logger.info('live trading mode deactivated');
    return { ok: true, tradingMode: 'paper' };
  });

  // Convenience read — identical to /api/runtime/kv/trading_mode, but
  // lives under /api/live-mode for the dedicated UI flow.
  app.get('/status', async () => {
    return { tradingMode: kvRead('trading_mode') === 'live' ? 'live' : 'paper' };
  });
}
