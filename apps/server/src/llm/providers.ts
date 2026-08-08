/**
 * Provider registry (PLAN §7, task 3.1).
 *
 * Runtime values ALWAYS come from the `settings` table (`providers.registry`,
 * seeded at migrate, UI-editable later). The DEFAULTS below are only a
 * fallback for rows/fields missing from settings — limits and model IDs are
 * data, not code (PLAN §16.4).
 */
import { z } from 'zod';
import { db } from '../db/client.js';

export type AdapterKind = 'openai-compat' | 'gemini' | 'stub';
export type AuthStyle = 'bearer' | 'gemini-header' | 'none';

export interface ProviderRecord {
  id: string;
  baseUrl: string;
  authStyle: AuthStyle;
  adapter: AdapterKind;
  models: string[];
  rpm: number;
  rpd: number;
  enabled: boolean;
}

/** Fallbacks only — mirrors the migrate-time seed. Settings win. */
export const PROVIDER_DEFAULTS: ProviderRecord[] = [
  // Model IDs verified live 2026-08-08 — they rot; when a provider 404s, re-check its /models endpoint.
  { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', authStyle: 'bearer', adapter: 'openai-compat', models: ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'], rpm: 20, rpd: 50, enabled: true },
  { id: 'groq', baseUrl: 'https://api.groq.com/openai/v1', authStyle: 'bearer', adapter: 'openai-compat', models: ['llama-3.3-70b-versatile'], rpm: 30, rpd: 1000, enabled: true },
  { id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', authStyle: 'gemini-header', adapter: 'gemini', models: ['gemini-3.6-flash', 'gemini-3.5-flash-lite'], rpm: 15, rpd: 1000, enabled: true },
  { id: 'mistral', baseUrl: 'https://api.mistral.ai/v1', authStyle: 'bearer', adapter: 'openai-compat', models: ['mistral-small-latest'], rpm: 60, rpd: 500, enabled: true },
  // Cerebras chat API now returns payment_required on free accounts (2026-08) — disabled by default.
  { id: 'cerebras', baseUrl: 'https://api.cerebras.ai/v1', authStyle: 'bearer', adapter: 'openai-compat', models: ['gpt-oss-120b', 'zai-glm-4.7'], rpm: 30, rpd: 1000, enabled: false },
  { id: 'ollama', baseUrl: 'http://localhost:11434/v1', authStyle: 'none', adapter: 'openai-compat', models: [], rpm: 600, rpd: 100000, enabled: false },
];

const SettingsRowSchema = z.object({
  id: z.string().min(1),
  baseUrl: z.string().min(1).optional(),
  authStyle: z.enum(['bearer', 'gemini-header', 'none']).optional(),
  adapter: z.enum(['openai-compat', 'gemini', 'stub']).optional(),
  models: z.array(z.string()).optional(),
  rpm: z.number().optional(),
  rpd: z.number().optional(),
  enabled: z.boolean().optional(),
});

function inferAuthStyle(id: string): AuthStyle {
  if (id === 'gemini') return 'gemini-header';
  if (id === 'ollama') return 'none';
  return 'bearer';
}

function inferAdapter(id: string): AdapterKind {
  return id === 'gemini' ? 'gemini' : 'openai-compat';
}

/**
 * Read the live registry: settings rows merged over defaults (settings win
 * per field; unknown providers from settings are kept with inferred
 * auth/adapter). Order = settings order (that IS the default provider_order).
 */
export function getProviders(): ProviderRecord[] {
  let raw: unknown = null;
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const row = stmt.get('providers.registry') as { value: string } | undefined;
  if (row) {
    try {
      raw = JSON.parse(row.value);
    } catch {
      raw = null;
    }
  }
  if (!Array.isArray(raw)) return PROVIDER_DEFAULTS.map((p) => ({ ...p, models: [...p.models] }));

  const out: ProviderRecord[] = [];
  for (const entry of raw) {
    const parsed = SettingsRowSchema.safeParse(entry);
    if (!parsed.success) continue; // malformed row → skip, don't crash
    const s = parsed.data;
    const def = PROVIDER_DEFAULTS.find((d) => d.id === s.id);
    out.push({
      id: s.id,
      baseUrl: s.baseUrl ?? def?.baseUrl ?? '',
      authStyle: s.authStyle ?? def?.authStyle ?? inferAuthStyle(s.id),
      adapter: s.adapter ?? def?.adapter ?? inferAdapter(s.id),
      models: s.models ?? def?.models ?? [],
      rpm: s.rpm ?? def?.rpm ?? 10,
      rpd: s.rpd ?? def?.rpd ?? 100,
      enabled: s.enabled ?? def?.enabled ?? false,
    });
  }
  return out.length > 0 ? out : PROVIDER_DEFAULTS.map((p) => ({ ...p, models: [...p.models] }));
}

export function getProvider(id: string): ProviderRecord | null {
  return getProviders().find((p) => p.id === id) ?? null;
}
