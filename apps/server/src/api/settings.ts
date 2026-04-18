import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { encrypt, decrypt, maskKey } from '../util/crypto-vault.js';
import { config } from '../config.js';
import { nowSec } from '../util/time.js';
import { logger } from '../util/logger.js';

const SUPPORTED_SERVICES = [
  'binance',
  'twelvedata',
  'finnhub',
  'etherscan',
  'helius',
  'cryptopanic',
  'fred',
  'alpaca',
  'telegram',
] as const;
type Service = (typeof SUPPORTED_SERVICES)[number];

const serviceSchema = z.enum(SUPPORTED_SERVICES);
const putBodySchema = z.object({
  key: z.string().min(1),
  secret: z.string().min(1).optional(),
});

interface ApiKeyRow {
  service: string;
  key_ciphertext: Buffer;
  secret_ciphertext: Buffer | null;
  iv: Buffer;
  tag: Buffer;
  added_at: number;
  last_verified_ts: number | null;
  last_verified_ok: number | null;
}

function readRow(service: string): ApiKeyRow | undefined {
  return db
    .prepare(
      `SELECT service, key_ciphertext, secret_ciphertext, iv, tag,
              added_at, last_verified_ts, last_verified_ok
         FROM api_keys WHERE service = ?`,
    )
    .get(service) as ApiKeyRow | undefined;
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/keys', async () => {
    const items = SUPPORTED_SERVICES.map((service) => {
      const row = readRow(service);
      if (!row) {
        return { service, present: false, masked: null, addedAt: null };
      }
      if (!config.masterKey) {
        return {
          service,
          present: true,
          masked: null,
          addedAt: row.added_at,
          error: 'master key missing, cannot decrypt',
        };
      }
      try {
        const plaintext = decrypt({
          ciphertext: row.key_ciphertext,
          iv: row.iv,
          tag: row.tag,
        });
        const [keyPart] = plaintext.split('\u0000', 1);
        return {
          service,
          present: true,
          masked: maskKey(keyPart ?? ''),
          addedAt: row.added_at,
          lastVerifiedTs: row.last_verified_ts,
          lastVerifiedOk:
            row.last_verified_ok === null ? null : row.last_verified_ok === 1,
        };
      } catch (err) {
        logger.error({ err, service }, 'failed to decrypt api_keys row');
        return { service, present: true, masked: null, error: 'decrypt failed' };
      }
    });
    return { services: items };
  });

  app.put<{ Params: { service: string } }>('/keys/:service', async (req, reply) => {
    const parsedService = serviceSchema.safeParse(req.params.service);
    if (!parsedService.success) {
      return reply.code(400).send({ error: 'unsupported service' });
    }
    const parsedBody = putBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      return reply
        .code(400)
        .send({ error: 'bad body', issues: parsedBody.error.issues });
    }
    if (!config.masterKey) {
      return reply.code(500).send({ error: 'master key not initialized' });
    }

    const service: Service = parsedService.data;
    const { key, secret } = parsedBody.data;
    const payload = secret ? `${key}\u0000${secret}` : key;
    const sealed = encrypt(payload);

    db.prepare(
      `INSERT INTO api_keys
         (service, key_ciphertext, secret_ciphertext, iv, tag, added_at)
       VALUES (?, ?, NULL, ?, ?, ?)
       ON CONFLICT(service) DO UPDATE SET
         key_ciphertext = excluded.key_ciphertext,
         secret_ciphertext = NULL,
         iv = excluded.iv,
         tag = excluded.tag,
         added_at = excluded.added_at,
         last_verified_ts = NULL,
         last_verified_ok = NULL`,
    ).run(service, sealed.ciphertext, sealed.iv, sealed.tag, nowSec());

    logger.info({ service }, 'api key stored');
    return { ok: true, service };
  });

  app.delete<{ Params: { service: string } }>('/keys/:service', async (req, reply) => {
    const parsedService = serviceSchema.safeParse(req.params.service);
    if (!parsedService.success) {
      return reply.code(400).send({ error: 'unsupported service' });
    }
    const info = db
      .prepare('DELETE FROM api_keys WHERE service = ?')
      .run(parsedService.data);
    return { ok: true, removed: info.changes };
  });

  app.post<{ Params: { service: string } }>(
    '/keys/:service/test',
    async (req, reply) => {
      const parsedService = serviceSchema.safeParse(req.params.service);
      if (!parsedService.success) {
        return reply.code(400).send({ error: 'unsupported service' });
      }
      // Phase 1 stub — real test hooks land alongside each collector in later
      // phases. Persist the mock verification so the UI can display it.
      const ts = nowSec();
      db.prepare(
        `UPDATE api_keys SET last_verified_ts = ?, last_verified_ok = 1
           WHERE service = ?`,
      ).run(ts, parsedService.data);
      return { ok: true, mock: true, service: parsedService.data, ts };
    },
  );
}
