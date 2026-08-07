import type { ProviderRecord } from '../providers.js';

/** One chat call: system + user (repair retries fold history into `user`). */
export interface ChatRequest {
  model: string;
  system: string;
  user: string;
}

/**
 * Adapter contract (task 3.2): never throws.
 * status: HTTP status, or 0 for timeout / network / anything non-HTTP.
 * text: assistant text on ok, error detail otherwise.
 */
export interface AdapterResult {
  ok: boolean;
  text: string;
  status: number;
}

export type Adapter = (
  provider: ProviderRecord,
  apiKey: string | null,
  req: ChatRequest,
) => Promise<AdapterResult>;

export const LLM_TIMEOUT_MS = 20_000;
