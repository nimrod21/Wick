/**
 * Provider status + connectivity test (Phase 6 settings page).
 *
 *   GET  /api/providers          — registry rows + today's llm_usage + headroom
 *   POST /api/providers/:id/test — ONE cheap call through the router
 *
 * The test runs through `llm/router.complete()` so it exercises the real
 * rotation/quota path, but pinned to a single provider. Stub-safe: a provider
 * whose adapter is `stub` (or whose authStyle is `none`, e.g. Ollama) needs no
 * key, and a missing key is reported rather than attempted.
 */

import type { FastifyInstance } from 'fastify';
import { getApiKey } from '../config.js';
import { getProvider, getProviders } from '../llm/providers.js';
import { getUsage, hasHeadroom } from '../llm/quota.js';
import { complete } from '../llm/router.js';

const TEST_PROMPT = {
  system: 'Reply with exactly one word.',
  user: 'Say OK.',
};

export async function registerProvidersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => {
    const now = Date.now();
    return {
      providers: getProviders().map((p) => {
        const usage = getUsage(p.id, now);
        return {
          id: p.id,
          baseUrl: p.baseUrl,
          adapter: p.adapter,
          authStyle: p.authStyle,
          models: p.models,
          rpm: p.rpm,
          rpd: p.rpd,
          enabled: p.enabled,
          hasKey: getApiKey(p.id) !== null,
          calls: usage.calls,
          errors: usage.errors,
          headroom: hasHeadroom(p, now),
        };
      }),
    };
  });

  app.post<{ Params: { id: string } }>('/:id/test', async (req, reply) => {
    const provider = getProvider(req.params.id);
    if (!provider) return reply.code(404).send({ error: 'unknown provider' });
    if (!provider.enabled) {
      return { ok: false, provider: provider.id, error: 'provider disabled' };
    }
    const needsKey = provider.authStyle !== 'none' && provider.adapter !== 'stub';
    if (needsKey && getApiKey(provider.id) === null) {
      return { ok: false, provider: provider.id, error: 'no key registered' };
    }

    const res = await complete({ botId: 0, providerOrder: [provider.id] }, TEST_PROMPT, {
      providers: [provider],
    });
    if (res.failed) {
      // `complete` reports rotation-level reasons ("all providers exhausted");
      // pinned to one provider that always means this provider refused.
      return {
        ok: false,
        provider: provider.id,
        error: `call failed — check key/model (${res.reason})`,
      };
    }
    return {
      ok: true,
      provider: res.provider,
      model: res.model,
      latencyMs: res.latencyMs,
      reply: res.text.trim().slice(0, 120),
    };
  });
}
