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
      const service: Service = parsedService.data;
      const ts = nowSec();

      // Services that short-circuit without an external call.
      if (service === 'binance') {
        db.prepare(
          `UPDATE api_keys SET last_verified_ts = ?, last_verified_ok = 1
             WHERE service = ?`,
        ).run(ts, service);
        return { ok: true, verifiedAt: ts, service };
      }
      if (service === 'cryptopanic') {
        db.prepare(
          `UPDATE api_keys SET last_verified_ts = ?, last_verified_ok = 0
             WHERE service = ?`,
        ).run(ts, service);
        return { ok: false, error: 'tier deprecated', service };
      }
      if (service === 'telegram') {
        db.prepare(
          `UPDATE api_keys SET last_verified_ts = ?, last_verified_ok = 0
             WHERE service = ?`,
        ).run(ts, service);
        return { ok: false, error: 'not implemented', service };
      }

      // All other services require a stored key.
      if (!config.masterKey) {
        return reply.code(500).send({ error: 'master key not initialized' });
      }
      const row = readRow(service);
      if (!row) {
        return reply.code(404).send({ ok: false, error: 'no key stored' });
      }
      let key: string;
      let secret: string | undefined;
      try {
        const plaintext = decrypt({
          ciphertext: row.key_ciphertext,
          iv: row.iv,
          tag: row.tag,
        });
        const sepIdx = plaintext.indexOf('\u0000');
        if (sepIdx >= 0) {
          key = plaintext.slice(0, sepIdx);
          secret = plaintext.slice(sepIdx + 1);
        } else {
          key = plaintext;
        }
      } catch (err) {
        logger.error({ err, service }, 'test: decrypt failed');
        return reply
          .code(500)
          .send({ ok: false, error: 'decrypt failed' });
      }

      const result = await runServiceTest(service, key, secret);

      db.prepare(
        `UPDATE api_keys SET last_verified_ts = ?, last_verified_ok = ?
           WHERE service = ?`,
      ).run(ts, result.ok ? 1 : 0, service);

      if (result.ok) {
        return { ok: true, verifiedAt: ts, service };
      }
      return { ok: false, error: result.error, service };
    },
  );
}

/**
 * Perform a live check for `service` using `key`/`secret`. Returns a
 * discriminated result; never throws. Each request uses a 5s AbortController
 * so a flaky endpoint doesn't wedge the PUT/test UI.
 */
async function runServiceTest(
  service: Service,
  key: string,
  secret: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    switch (service) {
      case 'twelvedata': {
        const url = `https://api.twelvedata.com/api_usage?apikey=${encodeURIComponent(key)}`;
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) return { ok: false, error: `http ${resp.status}` };
        const json = (await resp.json()) as { plan_category?: unknown; message?: string };
        if (json.plan_category === undefined) {
          return { ok: false, error: json.message ?? 'no plan_category in response' };
        }
        return { ok: true };
      }
      case 'etherscan': {
        const url =
          `https://api.etherscan.io/v2/api?chainid=1&module=stats&action=ethsupply&apikey=${encodeURIComponent(key)}`;
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) return { ok: false, error: `http ${resp.status}` };
        const json = (await resp.json()) as { status?: string; message?: string; result?: unknown };
        if (json.status === '1') return { ok: true };
        return {
          ok: false,
          error: json.message ?? (typeof json.result === 'string' ? json.result : 'bad status'),
        };
      }
      case 'helius': {
        const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
          signal: controller.signal,
        });
        if (!resp.ok) return { ok: false, error: `http ${resp.status}` };
        const json = (await resp.json()) as { result?: unknown; error?: { message?: string } };
        if (json.result === 'ok') return { ok: true };
        return { ok: false, error: json.error?.message ?? 'result != "ok"' };
      }
      case 'finnhub': {
        const url = `https://finnhub.io/api/v1/quote?symbol=AAPL&token=${encodeURIComponent(key)}`;
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) return { ok: false, error: `http ${resp.status}` };
        const json = (await resp.json()) as { c?: unknown; error?: string };
        if (typeof json.c === 'number' && Number.isFinite(json.c)) return { ok: true };
        return { ok: false, error: json.error ?? 'no numeric "c" field' };
      }
      case 'alpaca': {
        if (!secret) return { ok: false, error: 'alpaca requires secret' };
        const resp = await fetch('https://paper-api.alpaca.markets/v2/account', {
          headers: {
            'APCA-API-KEY-ID': key,
            'APCA-API-SECRET-KEY': secret,
          },
          signal: controller.signal,
        });
        if (!resp.ok) return { ok: false, error: `http ${resp.status}` };
        const json = (await resp.json()) as { id?: unknown };
        if (typeof json.id === 'string' && json.id.length > 0) return { ok: true };
        return { ok: false, error: 'no id in account response' };
      }
      case 'fred': {
        const url =
          `https://api.stlouisfed.org/fred/series?series_id=GDP` +
          `&api_key=${encodeURIComponent(key)}&file_type=json`;
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) return { ok: false, error: `http ${resp.status}` };
        // FRED returns JSON on success; anything parseable with no error is ok.
        const json = (await resp.json()) as { error_message?: string; seriess?: unknown };
        if (json.error_message) return { ok: false, error: json.error_message };
        return { ok: true };
      }
      default:
        return { ok: false, error: `unsupported service: ${service}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
