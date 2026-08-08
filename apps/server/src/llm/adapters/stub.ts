/**
 * Deterministic stub adapter for router tests and keyless end-to-end runs.
 * Behaviors are injected per provider id as a script (one entry consumed per
 * call; the last entry repeats). No network, no delays.
 */
import type { Adapter, AdapterResult, ChatRequest } from './types.js';

export type StubBehavior =
  | { kind: 'valid'; decision?: Record<string, unknown> }
  | { kind: 'prose' } // valid JSON wrapped in prose
  | { kind: 'garbage' } // no JSON anywhere
  | { kind: '429' }
  | { kind: '500' }
  | { kind: 'timeout' }
  | { kind: 'custom'; result: AdapterResult };

const scripts = new Map<string, { behaviors: StubBehavior[]; cursor: number }>();
const calls: Array<{ providerId: string; req: ChatRequest }> = [];

const DEFAULT_DECISION: Record<string, unknown> = {
  action: 'wait',
  symbol: null,
  size_pct: null,
  confidence: 55,
  reasoning: 'Stub decision: nothing actionable in the snapshot.',
  sl_pct: null,
  tp_pct: null,
};

export function setStubScript(providerId: string, behaviors: StubBehavior[]): void {
  scripts.set(providerId, { behaviors, cursor: 0 });
}

export function resetStub(): void {
  scripts.clear();
  calls.length = 0;
}

export function getStubCalls(): ReadonlyArray<{ providerId: string; req: ChatRequest }> {
  return calls;
}

function render(behavior: StubBehavior): AdapterResult {
  switch (behavior.kind) {
    case 'valid':
      return { ok: true, text: JSON.stringify(behavior.decision ?? DEFAULT_DECISION), status: 200 };
    case 'prose':
      return {
        ok: true,
        text: `Sure! Based on the snapshot here is my decision:\n${JSON.stringify(DEFAULT_DECISION)}\nLet me know if you need anything else.`,
        status: 200,
      };
    case 'garbage':
      return { ok: true, text: 'I think the market looks choppy, maybe wait? (no JSON here)', status: 200 };
    case '429':
      return { ok: false, text: 'rate limit exceeded', status: 429 };
    case '500':
      return { ok: false, text: 'internal server error', status: 500 };
    case 'timeout':
      return { ok: false, text: 'request timed out after 20000ms', status: 0 };
    case 'custom':
      return behavior.result;
  }
}

export const stubAdapter: Adapter = async (provider, _apiKey, req): Promise<AdapterResult> => {
  calls.push({ providerId: provider.id, req });
  const script = scripts.get(provider.id);
  if (!script || script.behaviors.length === 0) {
    return render({ kind: 'valid' });
  }
  const behavior = script.behaviors[Math.min(script.cursor, script.behaviors.length - 1)]!;
  script.cursor += 1;
  return render(behavior);
};
