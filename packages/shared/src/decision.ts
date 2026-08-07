import { z } from 'zod';

/**
 * LLM decision contract (PLAN §7). Validated with zod at the LLM boundary.
 * The schema is deliberately forgiving on *format* (coerces "82%" → 82,
 * "BUY" → "buy", string numbers → numbers, missing optionals → null) but
 * strict on *content* (buy/sell require symbol + size_pct in range).
 */

const ACTIONS = ['buy', 'sell', 'wait'] as const;
export type DecisionAction = (typeof ACTIONS)[number];

/** "82%" → 82, " 82 " → 82, 82 → 82; anything else → passthrough (fails schema). */
function coerceNumber(v: unknown): unknown {
  if (typeof v === 'string') {
    const stripped = v.trim().replace(/%$/, '');
    if (stripped.length > 0 && !Number.isNaN(Number(stripped))) return Number(stripped);
  }
  return v;
}

/** undefined → null, then number coercion. */
function coerceNullableNumber(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  return coerceNumber(v);
}

const looseNullableNumber = z.preprocess(coerceNullableNumber, z.number().nullable());

export const DecisionSchema = z
  .object({
    action: z.preprocess(
      (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
      z.enum(ACTIONS),
    ),
    symbol: z.preprocess(
      (v) => (v === undefined || v === '' ? null : typeof v === 'string' ? v.trim().toUpperCase() : v),
      z.string().min(1).nullable(),
    ),
    size_pct: z.preprocess(coerceNullableNumber, z.number().min(1).max(100).nullable()),
    confidence: z.preprocess(coerceNumber, z.number().min(0).max(100)),
    reasoning: z.preprocess(
      (v) => (v === undefined || v === null ? '' : String(v)),
      z.string().transform((s) => (s.length > 400 ? `${s.slice(0, 397)}...` : s)),
    ),
    sl_pct: looseNullableNumber,
    tp_pct: looseNullableNumber,
  })
  .superRefine((d, ctx) => {
    if (d.action === 'buy' || d.action === 'sell') {
      if (d.symbol === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['symbol'],
          message: `symbol is required for action "${d.action}"`,
        });
      }
      if (d.size_pct === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['size_pct'],
          message: `size_pct is required for action "${d.action}"`,
        });
      }
    }
  });

export type Decision = z.infer<typeof DecisionSchema>;

// Re-exported so consumers don't need direct zod plumbing for the common case.
export function parseDecision(
  raw: unknown,
): { ok: true; decision: Decision } | { ok: false; error: string } {
  const result = DecisionSchema.safeParse(raw);
  if (result.success) return { ok: true, decision: result.data };
  const msg = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: msg };
}
