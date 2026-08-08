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
  masterKey: process.env.WICK_MASTER_KEY || undefined,
});

export const config = parsed;
export type Config = typeof config;

/**
 * Mutate the in-memory masterKey after a first-run generation. The `.env`
 * file append is handled by `src/index.ts`.
 */
export function setMasterKey(k: string): void {
  (config as { masterKey?: string }).masterKey = k;
  process.env.WICK_MASTER_KEY = k;
}

/**
 * Read an encrypted API key stored in the `settings` table (Wick vault
 * format: `apikey.<service>` → JSON {ct, iv, tag} base64). Falls back to
 * `.env` (`${SERVICE_UPPER}_API_KEY`). Returns null when neither exists.
 */
export function getApiKey(service: string): { key: string } | null {
  try {
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(`apikey.${service}`) as { value: string } | undefined;
    if (row && config.masterKey) {
      const blob = JSON.parse(row.value) as { ct: string; iv: string; tag: string };
      const plaintext = decrypt({
        ciphertext: Buffer.from(blob.ct, 'base64'),
        iv: Buffer.from(blob.iv, 'base64'),
        tag: Buffer.from(blob.tag, 'base64'),
      });
      return { key: plaintext };
    }
  } catch {
    // fall through to env fallback
  }

  const envKey = process.env[`${service.toUpperCase()}_API_KEY`];
  if (envKey && envKey.length > 0) {
    return { key: envKey };
  }
  return null;
}
