/**
 * Gemini (AI Studio) native adapter — `generateContent` with
 * `responseMimeType: application/json`. The Gemini API shape stays isolated
 * here (PLAN §16.5). Some free-tier models reject a system role /
 * systemInstruction, so the system prompt is ALWAYS folded into the first
 * user turn (IMPL-2 Phase 3 pitfalls) — deterministic, works everywhere.
 */
import { request } from 'undici';
import type { Adapter, AdapterResult } from './types.js';
import { LLM_TIMEOUT_MS } from './types.js';

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

export const geminiAdapter: Adapter = async (provider, apiKey, req): Promise<AdapterResult> => {
  const url = `${provider.baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (apiKey) headers['x-goog-api-key'] = apiKey;

  const body = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [{ text: `${req.system}\n\n---\n\n${req.user}` }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  });

  try {
    const res = await request(url, {
      method: 'POST',
      headers,
      body,
      headersTimeout: LLM_TIMEOUT_MS,
      bodyTimeout: LLM_TIMEOUT_MS,
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    const raw = await res.body.text();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { ok: false, text: raw.slice(0, 500), status: res.statusCode };
    }
    let parsed: GenerateContentResponse;
    try {
      parsed = JSON.parse(raw) as GenerateContentResponse;
    } catch {
      return { ok: false, text: `non-JSON response body: ${raw.slice(0, 200)}`, status: res.statusCode };
    }
    const text = (parsed.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    if (text.length === 0) {
      return { ok: false, text: `empty candidates: ${raw.slice(0, 200)}`, status: res.statusCode };
    }
    return { ok: true, text, status: res.statusCode };
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err), status: 0 };
  }
};
