/**
 * Dev CLI (task 3.6): `pnpm ask --symbol BTCUSDT [--provider groq] [--dry]`
 *
 * Builds a REAL snapshot from the live DB (Phase-1 candles + indicators;
 * weight 1.0 / hit-rate n/a placeholders until Phase 5), renders the prompt
 * (--dry) or routes a decision through the LLM router. Boots db + vault
 * directly — no server needed. `--provider stub` runs the deterministic
 * offline adapter; `--provider ollama` (or plain rotation, if Ollama is up)
 * uses the local model.
 */
import { db } from '../apps/server/src/db/client.js';
import { buildSnapshot, SnapshotDataError } from '../apps/server/src/llm/snapshot.js';
import { buildPrompt, estimateTokens, type PromptBotConfig } from '../apps/server/src/llm/prompt.js';
import { decide, type DecideOptions } from '../apps/server/src/llm/router.js';
import { getProviders, type ProviderRecord } from '../apps/server/src/llm/providers.js';
import { setStubScript } from '../apps/server/src/llm/adapters/stub.js';

interface Args {
  symbol: string;
  provider: string | null;
  dry: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { symbol: 'BTCUSDT', provider: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--symbol') args.symbol = (argv[++i] ?? '').toUpperCase();
    else if (a === '--provider') args.provider = argv[++i] ?? null;
    else if (a === '--dry') args.dry = true;
    else {
      console.error(`Unknown arg: ${a}\nUsage: pnpm ask --symbol BTCUSDT [--provider groq|stub] [--dry]`);
      process.exit(1);
    }
  }
  if (!args.symbol) {
    console.error('Missing --symbol');
    process.exit(1);
  }
  return args;
}

/** Bot config from settings guards defaults (runtime values from settings). */
function cliBotConfig(): PromptBotConfig {
  let guards: Record<string, unknown> = {};
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('guards.defaults') as
      | { value: string }
      | undefined;
    if (row) guards = JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    /* fall back to defaults */
  }
  return {
    name: 'CLI Ask',
    personality: 'Neutral analyst — no persona, judge the data on its merits.',
    minConfidence: typeof guards.min_confidence === 'number' ? guards.min_confidence : 65,
    feePctPerSide: typeof guards.fee_pct_per_side === 'number' ? guards.fee_pct_per_side : 0.1,
    slippagePct: typeof guards.slippage_pct === 'number' ? guards.slippage_pct : 0.05,
  };
}

const STUB_PROVIDER: ProviderRecord = {
  id: 'stub',
  baseUrl: 'stub://local',
  authStyle: 'none',
  adapter: 'stub',
  models: ['stub-model'],
  rpm: 1000,
  rpd: 100000,
  enabled: true,
};

/** Probe local Ollama; returns installed model ids or null when down. */
async function probeOllama(): Promise<string[] | null> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name ?? '').filter((n) => n.length > 0);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = cliBotConfig();

  let snapshot;
  try {
    snapshot = buildSnapshot(args.symbol);
  } catch (err) {
    if (err instanceof SnapshotDataError) {
      console.error(`Snapshot unavailable: ${err.message}`);
      console.error('Fix: run `pnpm dev:server` once and wait for "market warm", then retry.');
      process.exit(1);
    }
    throw err;
  }

  if (args.dry) {
    const prompt = buildPrompt(cfg, snapshot);
    console.log('══════ SYSTEM ══════');
    console.log(prompt.system);
    console.log('══════ USER ══════');
    console.log(prompt.user);
    console.log('══════════════════');
    console.log(
      `est tokens: ${prompt.estTokens} (chars/4; system ${estimateTokens(prompt.system)} + user ${estimateTokens(prompt.user)}) — target < 2500`,
    );
    process.exit(prompt.estTokens < 2500 ? 0 : 2);
  }

  // Assemble the provider list: registry + stub (CLI-only) + live Ollama probe.
  const providers = getProviders();
  providers.push(STUB_PROVIDER);
  setStubScript('stub', [{ kind: 'valid' }]);

  const ollamaModels = await probeOllama();
  const ollama = providers.find((p) => p.id === 'ollama');
  if (ollamaModels && ollamaModels.length > 0 && ollama) {
    ollama.enabled = true;
    if (ollama.models.length === 0) ollama.models = [ollamaModels[0]!];
    console.log(`[ask] Ollama detected on :11434 (model ${ollama.models[0]})`);
  } else if (!args.provider) {
    console.log('[ask] Ollama not running — skipping local model.');
  }

  const opts: DecideOptions = { providers };
  const providerOrder = args.provider ? [args.provider] : providers.map((p) => p.id);
  if (args.provider && !providers.some((p) => p.id === args.provider)) {
    console.error(`Unknown provider "${args.provider}". Known: ${providers.map((p) => p.id).join(', ')}`);
    process.exit(1);
  }

  const t0 = Date.now();
  const result = await decide(
    { botId: 0, providerOrder, config: cfg },
    snapshot,
    opts,
  );
  if (result.failed) {
    console.error(`llm_failed: ${result.reason}`);
    console.error('No provider produced a decision — register keys (see apps/server/src/llm/README-setup.md), start Ollama, or use --provider stub.');
    process.exit(1);
  }
  console.log(JSON.stringify(result.decision, null, 2));
  console.log(
    `provider=${result.provider} model=${result.model} latency=${result.latencyMs}ms total=${Date.now() - t0}ms`,
  );
  process.exit(0);
}

void main();
