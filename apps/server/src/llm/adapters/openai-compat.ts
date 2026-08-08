/**
 * OpenAI-compatible chat adapter (OpenRouter, Groq, Mistral, Cerebras,
 * Ollama). Base URL + auth header differ per provider; request shape is
 * identical. `response_format: json_object` is sent as a HINT only — support
 * varies by model, the router's extractor is the real guarantee (IMPL-2
 * Phase 3 pitfalls).
 */
import { request } from 'undici';
import type { Adapter, AdapterResult } from './types.js';
import { LLM_TIMEOUT_MS } from './types.js';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string } | string;
}

export const openaiCompatAdapter: Adapter = async (provider, apiKey, req): Promise<AdapterResult> => {
  const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (provider.id === 'openrouter') {
    // OpenRouter free models reject requests missing these (IMPL-2 pitfall).
    headers['HTTP-Referer'] = 'https://github.com/wick-paper-trading';
    headers['X-Title'] = 'Wick';
  }

  const body = JSON.stringify({
    model: req.model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    response_format: { type: 'json_object' }, // hint only
    temperature: 0.2,
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
    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      return { ok: false, text: `non-JSON response body: ${raw.slice(0, 200)}`, status: res.statusCode };
    }
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      return { ok: false, text: `empty completion: ${raw.slice(0, 200)}`, status: res.statusCode };
    }
    return { ok: true, text: content, status: res.statusCode };
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err), status: 0 };
  }
};
