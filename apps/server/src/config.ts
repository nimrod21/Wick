import 'dotenv/config';
import { z } from 'zod';
import { db } from './db/client.js';
import { decrypt } from './util/crypto-vault.js';

const schema = z.object({
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.coerce.number().default(3001),
  }),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  masterKey: z.string().min(32).optional(),
});

const parsed = schema.parse({
  server: {
    host: process.env.SERVER_HOST ?? '127.0.0.1',
    port: process.env.SERVER_PORT ?? 3001,
  },
  logLevel:
    (process.env.LOG_LEVEL as 'trace' | 'debug' | 'info' | 'warn' | 'error' | undefined) ??
    'info',
  masterKey: process.env.COCKPIT_MASTER_KEY || undefined,
});

export const config = parsed;
export type Config = typeof config;

/**
 * Mutate the in-memory masterKey after a first-run generation. The `.env`
 * file append is handled by `src/index.ts`.
 */
export function setMasterKey(k: string): void {
  (config as { masterKey?: string }).masterKey = k;
  process.env.COCKPIT_MASTER_KEY = k;
}

/**
 * Read an API key for `service`. Prefers encrypted row in `api_keys`;
 * falls back to `.env` (`${SERVICE_UPPER}_API_KEY` / `_API_SECRET`).
 * Returns null if neither source has a value.
 *
 * On-disk layout: `key_ciphertext` holds a single ciphertext whose plaintext
 * is either `key` or `key\u0000secret` when a secret exists. `secret_ciphertext`
 * is NULL in that case (flag preserved for legacy/other uses). `iv` and `tag`
 * are the AES-GCM nonce and auth tag for the single ciphertext.
 */
export function getApiKey(service: string): { key: string; secret?: string } | null {
  try {
    const row = db
      .prepare(
        'SELECT key_ciphertext, secret_ciphertext, iv, tag FROM api_keys WHERE service = ?',
      )
      .get(service) as
      | {
          key_ciphertext: Buffer;
          secret_ciphertext: Buffer | null;
          iv: Buffer;
          tag: Buffer;
        }
      | undefined;
    if (row && config.masterKey) {
      const plaintext = decrypt({
        ciphertext: row.key_ciphertext,
        iv: row.iv,
        tag: row.tag,
      });
      const sepIdx = plaintext.indexOf('\u0000');
      if (sepIdx >= 0) {
        return {
          key: plaintext.slice(0, sepIdx),
          secret: plaintext.slice(sepIdx + 1),
        };
      }
      return { key: plaintext };
    }
  } catch {
    // fall through to env fallback
  }

  const upper = service.toUpperCase();
  const envKey = process.env[`${upper}_API_KEY`];
  const envSecret = process.env[`${upper}_API_SECRET`];
  if (envKey && envKey.length > 0) {
    return { key: envKey, secret: envSecret || undefined };
  }
  return null;
}
