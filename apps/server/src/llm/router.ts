/**
 * LLM router (task 3.4) — the ONE call site for decisions:
 * `decide(botCtx, snapshot) → {decision, provider, model, latencyMs} | {failed: true}`.
 *
 * Rotation: bot's provider_order ∩ enabled ∩ headroom. 429/5xx/timeout/
 * model-not-found → record error, next provider. Parse: strict JSON →
 * extract-first-{…} → ONE repair retry on the same provider → next provider.
 * Zod-validates the Decision contract. NEVER throws into the bot loop.
 */
import { DecisionSchema, type Decision } from '@wick/shared';
import { getApiKey } from '../config.js';
import { logger } from '../util/logger.js';
import { getProviders, type ProviderRecord } from './providers.js';
import { hasHeadroom, record } from './quota.js';
import { buildPrompt, type PromptBotConfig, type Snapshot } from './prompt.js';
import type { Adapter, AdapterResult } from './adapters/types.js';
import { openaiCompatAdapter } from './adapters/openai-compat.js';
import { geminiAdapter } from './adapters/gemini.js';
import { stubAdapter } from './adapters/stub.js';

export interface BotCtx {
  botId: number;
  /** Registry order when omitted. */
  providerOrder?: string[];
  config: PromptBotConfig;
}

export interface DecideSuccess {
  failed?: false;
  decision: Decision;
  provider: string;
  model: string;
  latencyMs: number;
}

export interface DecideFailure {
  failed: true;
  reason: string;
}

export type DecideResult = DecideSuccess | DecideFailure;

/** Test injection points — production callers pass nothing. */
export interface DecideOptions {
  providers?: ProviderRecord[];
  adapters?: Partial<Record<string, Adapter>>;
  now?: () => number;
}

const ADAPTERS: Record<string, Adapter> = {
  'openai-compat': openaiCompatAdapter,
  gemini: geminiAdapter,
  stub: stubAdapter,
};

const REPAIR_INSTRUCTION =
  'Your previous reply was not valid JSON matching the required schema. Reply with ONLY the corrected JSON object — no prose, no markdown.';

/** Strict parse, then balanced extract-first-{…} fallback (PLAN §16.6). */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to extraction */
  }
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 404/400 "model not found" style errors are treated like 429 (PLAN §16.4). */
function isTransportFailure(res: AdapterResult): boolean {
  return !res.ok; // 429, 5xx, 401/403 (bad key), 404 model-not-found, 0 timeout — all fall through
}

function tryDecision(text: string): { ok: true; decision: Decision } | { ok: false; error: string } {
  const parsed = extractJson(text);
  if (parsed === null) return { ok: false, error: 'no JSON object found in reply' };
  const validated = DecisionSchema.safeParse(parsed);
  if (!validated.success) {
    const msg = validated.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `schema: ${msg}` };
  }
  return { ok: true, decision: validated.data };
}

interface Candidate {
  provider: ProviderRecord;
  model: string;
  apiKey: string | null;
  adapter: Adapter;
}

/**
 * Rotation order for one call: the caller's provider_order ∩ enabled ∩
 * headroom ∩ has-a-model ∩ has-a-key. LAZY on purpose — headroom is checked
 * at the moment the candidate is reached, so quota consumed by an earlier
 * attempt in the same call is respected. Shared by `decide` and `complete`.
 */
function* eligibleProviders(
  order: string[],
  registry: ProviderRecord[],
  opts: DecideOptions,
  now: () => number,
  skipped: string[],
): Generator<Candidate> {
  const byId = new Map(registry.map((p) => [p.id, p]));
  for (const providerId of order) {
    const provider = byId.get(providerId);
    if (!provider || !provider.enabled) continue;
    if (!hasHeadroom(provider, now())) {
      skipped.push(`${providerId}:no-headroom`);
      continue;
    }
    const model = provider.models[0];
    if (!model) {
      skipped.push(`${providerId}:no-model`);
      continue;
    }
    const apiKey = getApiKey(provider.id)?.key ?? null;
    if (apiKey === null && provider.authStyle !== 'none' && provider.adapter !== 'stub') {
      // No key registered yet — skip silently rather than burn an error row.
      skipped.push(`${providerId}:no-key`);
      continue;
    }
    const adapter = opts.adapters?.[provider.adapter] ?? ADAPTERS[provider.adapter];
    if (!adapter) {
      skipped.push(`${providerId}:unknown-adapter`);
      continue;
    }
    yield { provider, model, apiKey, adapter };
  }
}

export interface CompleteSuccess {
  failed?: false;
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
}

export type CompleteResult = CompleteSuccess | DecideFailure;

/**
 * Free-text call through the SAME provider rotation and quota ledger as
 * `decide` — no JSON contract, no repair retry. The only caller is the daily
 * lesson compression (PLAN §11.3, the one non-decision LLM spend). Never
 * throws: a total failure is `{failed: true}` and the caller keeps whatever
 * it had.
 */
export async function complete(
  botCtx: Pick<BotCtx, 'botId' | 'providerOrder'>,
  prompt: { system: string; user: string },
  opts: DecideOptions = {},
): Promise<CompleteResult> {
  const now = opts.now ?? Date.now;
  const registry = opts.providers ?? getProviders();
  const order = botCtx.providerOrder ?? registry.map((p) => p.id);
  const log = logger.child({ bot: botCtx.botId });
  const skipped: string[] = [];

  try {
    for (const cand of eligibleProviders(order, registry, opts, now, skipped)) {
      const t0 = now();
      const res = await cand.adapter(cand.provider, cand.apiKey, {
        model: cand.model,
        system: prompt.system,
        user: prompt.user,
      });
      const latencyMs = now() - t0;
      record(cand.provider, res.ok, now());
      if (!res.ok) {
        log.warn({ provider: cand.provider.id, status: res.status }, 'llm text call failed, rotating');
        continue;
      }
      if (res.text.trim().length === 0) {
        log.warn({ provider: cand.provider.id }, 'llm text call returned empty body, rotating');
        continue;
      }
      return { text: res.text, provider: cand.provider.id, model: cand.model, latencyMs };
    }
  } catch (err) {
    logger.error({ bot: botCtx.botId, err }, 'llm router: unexpected error in complete()');
    return { failed: true, reason: `unexpected: ${err instanceof Error ? err.message : String(err)}` };
  }

  return {
    failed: true,
    reason: `all providers exhausted (${skipped.length > 0 ? skipped.join(', ') : 'none eligible'})`,
  };
}

export async function decide(
  botCtx: BotCtx,
  snapshot: Snapshot,
  opts: DecideOptions = {},
): Promise<DecideResult> {
  try {
    return await decideInner(botCtx, snapshot, opts);
  } catch (err) {
    // Belt and braces: decide() must NEVER throw into the bot loop.
    logger.error({ bot: botCtx.botId, err }, 'llm router: unexpected error');
    return { failed: true, reason: `unexpected: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function decideInner(
  botCtx: BotCtx,
  snapshot: Snapshot,
  opts: DecideOptions,
): Promise<DecideResult> {
  const now = opts.now ?? Date.now;
  const registry = opts.providers ?? getProviders();
  const order = botCtx.providerOrder ?? registry.map((p) => p.id);
  const prompt = buildPrompt(botCtx.config, snapshot);
  const log = logger.child({ bot: botCtx.botId });
  const skipped: string[] = [];

  for (const { provider, model, apiKey, adapter } of eligibleProviders(
    order,
    registry,
    opts,
    now,
    skipped,
  )) {
    // ── first attempt ──
    const t0 = now();
    const res = await adapter(provider, apiKey, { model, system: prompt.system, user: prompt.user });
    const latencyMs = now() - t0;
    record(provider, res.ok, now());
    if (isTransportFailure(res)) {
      log.warn({ provider: provider.id, status: res.status }, 'llm call failed, rotating');
      continue;
    }
    const first = tryDecision(res.text);
    if (first.ok) {
      return { decision: first.decision, provider: provider.id, model, latencyMs };
    }
    log.debug({ provider: provider.id, error: first.error }, 'llm reply malformed, repair retry');

    // ── one repair retry on the same provider ──
    const repairUser = `${prompt.user}\n\nYour previous reply was:\n${res.text.slice(0, 1500)}\n\n${REPAIR_INSTRUCTION}`;
    const t1 = now();
    const repairRes = await adapter(provider, apiKey, { model, system: prompt.system, user: repairUser });
    const repairLatencyMs = now() - t1;
    if (isTransportFailure(repairRes)) {
      record(provider, false, now());
      log.warn({ provider: provider.id, status: repairRes.status }, 'llm repair call failed, rotating');
      continue;
    }
    const second = tryDecision(repairRes.text);
    // "malformed JSON after one repair-retry → mark error in ledger" (PLAN §7).
    record(provider, second.ok, now());
    if (second.ok) {
      return { decision: second.decision, provider: provider.id, model, latencyMs: repairLatencyMs };
    }
    log.warn({ provider: provider.id, error: second.error }, 'llm repair retry still malformed, rotating');
  }

  return {
    failed: true,
    reason: `all providers exhausted (${skipped.length > 0 ? skipped.join(', ') : 'none eligible'})`,
  };
}
