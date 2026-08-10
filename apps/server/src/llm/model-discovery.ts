/**
 * OpenRouter free-model discovery (IMPL-5 polish batch).
 *
 * Pinned model IDs rot — OpenRouter retires `:free` variants without notice
 * and the router then burns a rotation slot on a 404. So instead of trusting
 * the seeded list forever, the public `GET /v1/models` catalogue is fetched,
 * filtered to ids ending in `:free`, and cached for a day in `settings`
 * (survives restarts; no new table, no migration).
 *
 * Precedence, resolved in `providers.getProviders()`:
 *   1. settings registry row with `"discover": false`  → pinned list, full stop
 *   2. fresh discovery cache → pinned ids that STILL EXIST first (a working
 *      choice keeps working; the router only ever calls `models[0]`), then the
 *      rest of the discovered free catalogue as automatic fallbacks
 *   3. no cache / failed fetch → pinned list unchanged
 *
 * Network failure is never fatal: the last good cache is kept, and if there
 * has never been one the caller sees `null` and stays on the pinned list.
 */

import { request } from 'undici';
import { db } from '../db/client.js';
import { logger } from '../util/logger.js';
import { nowMs } from '../util/time.js';

/** Settings row holding the cached catalogue. */
export const DISCOVERY_KEY = 'providers.openrouter.discovered';
export const DISCOVERY_TTL_MS = 24 * 3_600_000;
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const TIMEOUT_MS = 15_000;
/** Guardrail: the catalogue is public and unbounded — do not cache it whole. */
const MAX_CACHED = 40;

export interface DiscoveryCache {
  ts: number;
  models: string[];
}

interface ModelsResponse {
  data?: Array<{ id?: unknown }>;
}

export function isFreeModelId(id: string): boolean {
  return id.endsWith(':free');
}

/** Cached catalogue, or null when nothing has ever been discovered. */
export function readDiscoveredModels(): DiscoveryCache | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(DISCOVERY_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { ts, models } = parsed as { ts?: unknown; models?: unknown };
    if (typeof ts !== 'number' || !Array.isArray(models)) return null;
    const clean = models.filter((m): m is string => typeof m === 'string' && m.length > 0);
    return clean.length > 0 ? { ts, models: clean } : null;
  } catch {
    return null;
  }
}

function writeDiscoveredModels(cache: DiscoveryCache): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(DISCOVERY_KEY, JSON.stringify(cache));
}

export interface RefreshResult {
  ok: boolean;
  /** Free models now cached (0 when the fetch failed and no cache existed). */
  count: number;
  /** 'fetched' | 'cached' (still fresh) | an error string. */
  reason: string;
}

/**
 * Refresh the cache when it is older than a day. `force` refetches regardless
 * (used by the boot call and by tests); `url` is a test seam for exercising
 * the unreachable-upstream path. NEVER throws.
 */
export async function refreshOpenRouterModels(
  force = false,
  url: string = MODELS_URL,
): Promise<RefreshResult> {
  const existing = readDiscoveredModels();
  if (!force && existing && nowMs() - existing.ts < DISCOVERY_TTL_MS) {
    return { ok: true, count: existing.models.length, reason: 'cached' };
  }

  try {
    const res = await request(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      headersTimeout: TIMEOUT_MS,
      bodyTimeout: TIMEOUT_MS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      logger.warn({ status: res.statusCode }, 'openrouter /models failed — keeping pinned models');
      return { ok: false, count: existing?.models.length ?? 0, reason: `http ${res.statusCode}` };
    }
    const parsed = JSON.parse(raw) as ModelsResponse;
    const models = (parsed.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
      .filter(isFreeModelId);
    if (models.length === 0) {
      // A 200 with no free models is a catalogue change, not a success — the
      // pinned list is still the better bet.
      logger.warn('openrouter /models returned no :free models — keeping pinned models');
      return { ok: false, count: existing?.models.length ?? 0, reason: 'no free models' };
    }
    const cache: DiscoveryCache = { ts: nowMs(), models: models.slice(0, MAX_CACHED) };
    writeDiscoveredModels(cache);
    logger.info({ count: cache.models.length }, 'openrouter free models discovered');
    return { ok: true, count: cache.models.length, reason: 'fetched' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'openrouter /models unreachable — keeping pinned models');
    return { ok: false, count: existing?.models.length ?? 0, reason };
  }
}
