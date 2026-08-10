/**
 * Typed fetchers over the Fastify API (IMPL-4 task 6.2).
 *
 * Same-origin: `next.config.mjs` rewrites `/api/*` to 127.0.0.1:3001, so
 * nothing here ever names an external host. Every response is zod-parsed —
 * the server is trusted but its shapes drift across phases and a silent
 * `undefined.map` in a panel is worse than a visible parse error.
 */
import { z } from 'zod';

const BASE = '';

async function request<T>(
  schema: z.ZodType<T>,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const json: unknown = await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${method} ${path} → bad shape: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  return parsed.data;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

// ── schemas ────────────────────────────────────────────────────────────

export const TIMEFRAMES = ['1m', '15m', '1h', '4h', '1d'] as const;
export type Tf = (typeof TIMEFRAMES)[number];

const num = z.number();
const nullNum = z.number().nullable();

export const BotConfigSchema = z.object({
  cadence_tf: z.string(),
  symbols: z.array(z.string()),
  provider_order: z.array(z.string()),
  model_prefs: z.array(z.string()),
  personality: z.string(),
  min_confidence: num,
  max_trades_day: num,
  cooldown_min: num,
  min_hold_min: num,
  max_pos_pct: num,
  drawdown_kill_pct: num,
  default_sl_pct: num,
  default_tp_pct: num,
  run: num,
});
export type BotConfig = z.infer<typeof BotConfigSchema>;

export const BotSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.enum(['running', 'stopped', 'busted']),
  bankrollStart: num,
  cash: num,
  equity: num,
  highWaterMark: nullNum,
  drawdownPct: nullNum,
  config: BotConfigSchema,
  createdTs: num,
  stoppedTs: nullNum,
  positions: num,
});
export type Bot = z.infer<typeof BotSchema>;

export const MarketSymbolSchema = z.object({
  symbol: z.string(),
  displayName: z.string(),
  lastPrice: nullNum,
  changePct24h: nullNum,
  votes: z.record(z.string(), z.string().nullable()),
});
export type MarketSymbol = z.infer<typeof MarketSymbolSchema>;

export const CandleSchema = z.object({
  ts: num, o: num, h: num, l: num, c: num, v: num,
});
export type Candle = z.infer<typeof CandleSchema>;

export const IndicatorSchema = z.object({
  name: z.string(),
  value: nullNum,
  vote: z.string().nullable(),
});
export type Indicator = z.infer<typeof IndicatorSchema>;

export const PositionSchema = z.object({
  symbol: z.string(),
  qty: num,
  avgEntry: num,
  stopPrice: nullNum,
  tpPrice: nullNum,
  openedTs: num,
  mid: nullNum,
  valueUsd: nullNum,
  unrealizedPnl: nullNum,
});
export type BotPosition = z.infer<typeof PositionSchema>;

export const FillSchema = z.object({
  id: num,
  bot_id: num,
  decision_id: nullNum,
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  qty: num,
  price: num,
  fee: num,
  slip: num,
  ts: num,
});
export type Fill = z.infer<typeof FillSchema>;

export const EquitySchema = z.object({
  botId: num,
  cash: num,
  bankrollStart: num,
  equity: num,
  highWaterMark: nullNum,
  drawdownPct: nullNum,
  snapshots: z.array(z.object({ ts: num, equity: num })),
});
export type EquityResponse = z.infer<typeof EquitySchema>;

const OutcomeSchema = z.object({
  fwdRetPct: nullNum,
  score: nullNum,
  evaluatedTs: nullNum,
});
export type Outcome = z.infer<typeof OutcomeSchema>;

export const DecisionSchema = z.object({
  id: num,
  ts: num,
  triggerType: z.string().nullable(),
  triggerDetail: z.string().nullable(),
  action: z.string(),
  symbol: z.string().nullable(),
  sizePct: nullNum,
  confidence: nullNum,
  reasoning: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  status: z.string(),
  vetoReason: z.string().nullable(),
  outcomes: z.record(z.string(), OutcomeSchema),
});
export type DecisionRow = z.infer<typeof DecisionSchema>;

export const IndicatorStatSchema = z.object({
  indicator: z.string(),
  samples: num,
  hits: num,
  weight: num,
  enabled: z.boolean(),
  hitRate: nullNum,
  updatedTs: num,
});
export type IndicatorStat = z.infer<typeof IndicatorStatSchema>;

/** One bot's row inside the global indicator rollup (IMPL-2). */
export const IndicatorBotStatSchema = z.object({
  botId: num,
  botName: z.string().nullable(),
  samples: num,
  hits: num,
  hitRate: nullNum,
  weight: num,
  enabled: z.boolean(),
  updatedTs: num,
});
export type IndicatorBotStat = z.infer<typeof IndicatorBotStatSchema>;

export const IndicatorRollupRowSchema = z.object({
  indicator: z.string(),
  rule: z.string(),
  scope: z.enum(['symbol', 'global']),
  registered: z.boolean(),
  samples: num,
  hits: num,
  hitRate: nullNum,
  weight: nullNum,
  botCount: num,
  enabledBots: num,
  updatedTs: nullNum,
  bots: z.array(IndicatorBotStatSchema),
  history: z.array(z.object({ ts: num, weight: num })),
});
export type IndicatorRollupRow = z.infer<typeof IndicatorRollupRowSchema>;

export const IndicatorRollupSchema = z.object({
  sampleFloor: num,
  disableFloor: num,
  indicators: z.array(IndicatorRollupRowSchema),
});
export type IndicatorRollup = z.infer<typeof IndicatorRollupSchema>;

export const JournalEntrySchema = z.object({
  id: num,
  ts: num,
  kind: z.string(),
  text: z.string(),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

export const TriggerRowSchema = z.object({
  id: num,
  ts: num,
  bot_id: nullNum,
  type: z.string(),
  detail: z.string().nullable(),
  fired: num,
});
export type TriggerRow = z.infer<typeof TriggerRowSchema>;

export const ProviderStatusSchema = z.object({
  id: z.string(),
  baseUrl: z.string(),
  adapter: z.string(),
  authStyle: z.string(),
  models: z.array(z.string()),
  rpm: num,
  rpd: num,
  enabled: z.boolean(),
  hasKey: z.boolean(),
  calls: num,
  errors: num,
  headroom: z.boolean(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const ProviderKeySchema = z.object({
  provider: z.string(),
  present: z.boolean(),
  masked: z.string().nullable().optional(),
  addedTs: nullNum.optional(),
  error: z.string().optional(),
});
export type ProviderKey = z.infer<typeof ProviderKeySchema>;

export const AssetSchema = z.object({
  symbol: z.string(),
  displayName: z.string(),
  active: z.boolean(),
  addedTs: num,
});
export type Asset = z.infer<typeof AssetSchema>;

export const ModelStatSchema = z.object({
  provider: z.string().nullable(),
  model: z.string().nullable(),
  decisions: num,
  evaluated: num,
  trades: num,
  wins: num,
  losses: num,
  winRate: nullNum,
  meanScore: nullNum,
  botIds: z.array(num),
});
export type ModelStat = z.infer<typeof ModelStatSchema>;

const TestResultSchema = z.object({
  ok: z.boolean(),
  provider: z.string().optional(),
  model: z.string().optional(),
  latencyMs: num.optional(),
  reply: z.string().optional(),
  error: z.string().optional(),
});
export type ProviderTestResult = z.infer<typeof TestResultSchema>;

// ── fetchers ───────────────────────────────────────────────────────────

export const api = {
  bots: () => request(z.object({ bots: z.array(BotSchema) }), 'GET', '/api/bots').then((r) => r.bots),

  bot: (id: number) =>
    request(z.object({ bot: BotSchema }), 'GET', `/api/bots/${id}`).then((r) => r.bot),

  botAction: (id: number, action: 'start' | 'stop' | 'reset') =>
    request(z.object({ bot: BotSchema }), 'POST', `/api/bots/${id}/${action}`, {}).then((r) => r.bot),

  patchBot: (
    id: number,
    patch: { name?: string; config?: Partial<BotConfig>; add_funds?: number },
  ) => request(z.object({ bot: BotSchema }), 'PATCH', `/api/bots/${id}`, patch).then((r) => r.bot),

  createBot: (input: { name: string; bankroll: number; config?: Partial<BotConfig> }) =>
    request(z.object({ bot: BotSchema }), 'POST', '/api/bots', input).then((r) => r.bot),

  /** Hard delete — server refuses with 409 while the bot is running. */
  deleteBot: (id: number) =>
    request(z.object({ ok: z.boolean(), deleted: num }), 'DELETE', `/api/bots/${id}`),

  positions: (id: number) =>
    request(z.object({ positions: z.array(PositionSchema) }), 'GET', `/api/bots/${id}/positions`)
      .then((r) => r.positions),

  fills: (id: number, limit = 200) =>
    request(z.object({ fills: z.array(FillSchema) }), 'GET', `/api/bots/${id}/fills${qs({ limit })}`)
      .then((r) => r.fills),

  equity: (id: number, limit = 500) =>
    request(EquitySchema, 'GET', `/api/bots/${id}/equity${qs({ limit })}`),

  outcomes: (id: number, limit = 500) =>
    request(z.object({ decisions: z.array(DecisionSchema) }), 'GET', `/api/bots/${id}/outcomes${qs({ limit })}`)
      .then((r) => r.decisions),

  stats: (id: number) =>
    request(z.object({ stats: z.array(IndicatorStatSchema) }), 'GET', `/api/bots/${id}/stats`)
      .then((r) => r.stats),

  journal: (id: number, limit = 100) =>
    request(
      z.object({
        entries: z.array(JournalEntrySchema),
        lessons: z.object({ text: z.string(), updatedTs: num }).nullable(),
      }),
      'GET',
      `/api/bots/${id}/journal${qs({ limit })}`,
    ),

  triggers: (id: number, limit = 200) =>
    request(z.object({ triggers: z.array(TriggerRowSchema) }), 'GET', `/api/bots/${id}/triggers${qs({ limit })}`)
      .then((r) => r.triggers),

  summary: () =>
    request(
      z.object({ warm: z.boolean(), symbols: z.array(MarketSymbolSchema) }),
      'GET',
      '/api/market/summary',
    ),

  candles: (symbol: string, tf: Tf, limit = 300) =>
    request(
      z.object({ symbol: z.string(), tf: z.string(), candles: z.array(CandleSchema) }),
      'GET',
      `/api/market/candles${qs({ symbol, tf, limit })}`,
    ).then((r) => r.candles),

  indicators: (symbol: string, tf = '1h') =>
    request(
      z.object({ symbol: z.string(), tf: z.string(), ts: nullNum, indicators: z.array(IndicatorSchema) }),
      'GET',
      `/api/market/indicators${qs({ symbol, tf })}`,
    ),

  models: () =>
    request(z.object({ models: z.array(ModelStatSchema) }), 'GET', '/api/stats/models').then((r) => r.models),

  /** Fleet-wide indicator track record + the registry that drives the grid columns. */
  indicatorRollup: () => request(IndicatorRollupSchema, 'GET', '/api/stats/indicators'),

  assets: () =>
    request(z.object({ assets: z.array(AssetSchema) }), 'GET', '/api/assets').then((r) => r.assets),

  addAsset: (symbol: string, displayName: string) =>
    request(z.object({ ok: z.boolean() }), 'POST', '/api/assets', {
      symbol,
      display_name: displayName,
    }),

  removeAsset: (symbol: string) =>
    request(z.object({ ok: z.boolean() }), 'DELETE', `/api/assets/${symbol}`),

  providers: () =>
    request(z.object({ providers: z.array(ProviderStatusSchema) }), 'GET', '/api/providers')
      .then((r) => r.providers),

  testProvider: (id: string) =>
    request(TestResultSchema, 'POST', `/api/providers/${id}/test`, {}),

  providerKeys: () =>
    request(z.object({ providers: z.array(ProviderKeySchema) }), 'GET', '/api/settings/keys')
      .then((r) => r.providers),

  setProviderKey: (provider: string, key: string) =>
    request(z.object({ ok: z.boolean() }), 'PUT', `/api/settings/keys/${provider}`, { key }),

  deleteProviderKey: (provider: string) =>
    request(z.object({ ok: z.boolean() }), 'DELETE', `/api/settings/keys/${provider}`),

  settings: () =>
    request(
      z.object({ settings: z.array(z.object({ key: z.string(), value: z.string() })) }),
      'GET',
      '/api/settings',
    ).then((r) => r.settings),

  putSetting: (key: string, value: string) =>
    request(z.object({ ok: z.boolean() }), 'PUT', `/api/settings/${key}`, { value }),
};
