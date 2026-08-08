/**
 * Settings API.
 *
 * Two surfaces over the single `settings` (key, value) table:
 *  - generic settings rows (guards, trigger thresholds, provider registry) —
 *    read/write as plain strings (callers parse JSON where applicable);
 *  - LLM provider API keys, stored encrypted (existing AES-GCM vault format)
 *    under `apikey.<provider>` keys. Keys are never returned in full —
 *    only masked previews.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { encrypt, decrypt, maskKey } from '../util/crypto-vault.js';
import { config } from '../config.js';
import { nowMs } from '../util/time.js';
import { logger } from '../util/logger.js';

export const LLM_PROVIDERS = [
  'openrouter',
  'groq',
  'gemini',
  'mistral',
  'cerebras',
  'ollama',
] as const;
type Provider = (typeof LLM_PROVIDERS)[number];

const providerSchema = z.enum(LLM_PROVIDERS);
const putKeyBodySchema = z.object({
  key: z.string().min(1),
});
const putSettingBodySchema = z.object({ value: z.string() });

const APIKEY_PREFIX = 'apikey.';

interface VaultBlob {
  ct: string; // base64 ciphertext
  iv: string; // base64
  tag: string; // base64
  added_ts: number;
}

function readSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function readVaultBlob(provider: Provider): VaultBlob | null {
  const raw = readSetting(`${APIKEY_PREFIX}${provider}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VaultBlob;
  } catch {
    return null;
  }
}

/** Decrypt the stored API key for an LLM provider. Null when absent/undecryptable. */
export function getProviderKey(provider: Provider): string | null {
  const blob = readVaultBlob(provider);
  if (!blob || !config.masterKey) return null;
  try {
    return decrypt({
      ciphertext: Buffer.from(blob.ct, 'base64'),
      iv: Buffer.from(blob.iv, 'base64'),
      tag: Buffer.from(blob.tag, 'base64'),
    });
  } catch (err) {
    logger.error({ err, provider }, 'failed to decrypt provider key');
    return null;
  }
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  // ── generic settings ────────────────────────────────────────────────
  app.get('/', async () => {
    const rows = db
      .prepare(`SELECT key, value FROM settings WHERE key NOT LIKE '${APIKEY_PREFIX}%' ORDER BY key`)
      .all() as Array<{ key: string; value: string }>;
    return { settings: rows };
  });

  app.put<{ Params: { key: string } }>('/:key', async (req, reply) => {
    const key = req.params.key;
    if (key.startsWith(APIKEY_PREFIX)) {
      return reply.code(400).send({ error: 'use /keys/:provider for api keys' });
    }
    const parsed = putSettingBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad body', issues: parsed.error.issues });
    }
    writeSetting(key, parsed.data.value);
    return { ok: true, key };
  });

  // ── provider keys (vault) ───────────────────────────────────────────
  app.get('/keys', async () => {
    const items = LLM_PROVIDERS.map((provider) => {
      const blob = readVaultBlob(provider);
      if (!blob) {
        return { provider, present: false, masked: null, addedTs: null };
      }
      if (!config.masterKey) {
        return {
          provider,
          present: true,
          masked: null,
          addedTs: blob.added_ts,
          error: 'master key missing, cannot decrypt',
        };
      }
      const plaintext = getProviderKey(provider);
      if (plaintext === null) {
        return { provider, present: true, masked: null, error: 'decrypt failed' };
      }
      return {
        provider,
        present: true,
        masked: maskKey(plaintext),
        addedTs: blob.added_ts,
      };
    });
    return { providers: items };
  });

  app.put<{ Params: { provider: string } }>('/keys/:provider', async (req, reply) => {
    const parsedProvider = providerSchema.safeParse(req.params.provider);
    if (!parsedProvider.success) {
      return reply.code(400).send({ error: 'unsupported provider' });
    }
    const parsedBody = putKeyBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      return reply
        .code(400)
        .send({ error: 'bad body', issues: parsedBody.error.issues });
    }
    if (!config.masterKey) {
      return reply.code(500).send({ error: 'master key not initialized' });
    }

    const provider: Provider = parsedProvider.data;
    const sealed = encrypt(parsedBody.data.key);
    const blob: VaultBlob = {
      ct: sealed.ciphertext.toString('base64'),
      iv: sealed.iv.toString('base64'),
      tag: sealed.tag.toString('base64'),
      added_ts: nowMs(),
    };
    writeSetting(`${APIKEY_PREFIX}${provider}`, JSON.stringify(blob));

    logger.info({ provider }, 'provider api key stored');
    return { ok: true, provider };
  });

  app.delete<{ Params: { provider: string } }>('/keys/:provider', async (req, reply) => {
    const parsedProvider = providerSchema.safeParse(req.params.provider);
    if (!parsedProvider.success) {
      return reply.code(400).send({ error: 'unsupported provider' });
    }
    const info = db
      .prepare('DELETE FROM settings WHERE key = ?')
      .run(`${APIKEY_PREFIX}${parsedProvider.data}`);
    return { ok: true, removed: info.changes };
  });

  // Phase 3 rewires this — live key verification goes through llm/router.
  app.post<{ Params: { provider: string } }>('/keys/:provider/test', async (req, reply) => {
    const parsedProvider = providerSchema.safeParse(req.params.provider);
    if (!parsedProvider.success) {
      return reply.code(400).send({ error: 'unsupported provider' });
    }
    return { ok: false, error: 'not implemented until Phase 3', provider: parsedProvider.data };
  });
}
