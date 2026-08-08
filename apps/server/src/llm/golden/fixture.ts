/**
 * Fixed snapshot fixture for the prompt golden test (task 3.5). Every value
 * is hardcoded — buildPrompt is pure, so the rendered output must be
 * byte-identical run to run. Regenerate the golden file with
 * `UPDATE_GOLDEN=1 pnpm tsx scripts/test-llm.ts` after INTENTIONAL prompt
 * changes only.
 */
import type { PromptBotConfig, Snapshot, SnapshotCandle } from '../prompt.js';

const BASE_TS = Date.UTC(2026, 7, 1, 0, 0, 0); // 2026-08-01T00:00:00Z

function candles(): SnapshotCandle[] {
  const out: SnapshotCandle[] = [];
  for (let i = 0; i < 24; i++) {
    const drift = Math.sin(i / 3) * 400;
    const o = 43000 + drift + i * 10;
    out.push({
      ts: BASE_TS + i * 3_600_000,
      o,
      h: o + 180,
      l: o - 150,
      c: o + 60,
      v: 1200 + i * 17,
    });
  }
  return out;
}

export const FIXTURE_BOT_CONFIG: PromptBotConfig = {
  name: 'Golden Test Bot',
  personality: 'Patient swing trader; prefers strong confluence and hates chop.',
  minConfidence: 65,
  feePctPerSide: 0.1,
  slippagePct: 0.05,
};

export const FIXTURE_SNAPSHOT: Snapshot = {
  symbol: 'BTCUSDT',
  ts: BASE_TS + 24 * 3_600_000,
  candles1h: candles(),
  // Phase 5: real learned weights/hit-rates/samples. `fear_greed` is the
  // auto-disabled one — it must stay in the snapshot (its votes keep being
  // recorded) and must NOT appear in the rendered prompt.
  indicators: [
    { name: 'atr14', value: 312.44, vote: null, weight: 1.0, hitRate: null, samples: 0, shadow: false },
    { name: 'bollinger', value: 0.82, vote: 'neutral', weight: 1.0, hitRate: 0.52, samples: 41, shadow: false },
    { name: 'ema_trend', value: 1.63, vote: 'bull', weight: 1.25, hitRate: 0.58, samples: 47, shadow: false },
    { name: 'fear_greed', value: 71, vote: 'bear', weight: 0.75, hitRate: 0.41, samples: 118, shadow: true },
    { name: 'funding', value: 0.012, vote: 'neutral', weight: 1.0, hitRate: null, samples: 0, shadow: false },
    { name: 'macd', value: 55.2, vote: 'bull', weight: 1.1, hitRate: 0.55, samples: 52, shadow: false },
    { name: 'rsi14', value: 63.1, vote: 'neutral', weight: 1.0, hitRate: 0.5, samples: 29, shadow: false },
    { name: 'volume_ratio', value: 1.9, vote: 'bull', weight: 0.9, hitRate: 0.48, samples: 44, shadow: false },
  ],
  funding: 0.00012,
  fearGreed: 71,
  position: {
    qty: 0.0023,
    avgEntry: 42800,
    uPnlPct: 1.42,
    stopPrice: 40660,
    tpPrice: 47080,
  },
  account: {
    cash: 612.4,
    equity: 1012.77,
    drawdownPct: 3.8,
    fees7d: 4.12,
    grossPnl7d: 18.6,
  },
  lastDecisions: [
    { ts: BASE_TS + 23 * 3_600_000, action: 'wait', symbol: null, sizePct: null, confidence: 40, status: 'executed', fwdRet4hPct: null, score4h: null },
    { ts: BASE_TS + 20 * 3_600_000, action: 'buy', symbol: 'BTCUSDT', sizePct: 40, confidence: 72, status: 'executed', fwdRet4hPct: 1.1, score4h: 0.3 },
    { ts: BASE_TS + 16 * 3_600_000, action: 'wait', symbol: null, sizePct: null, confidence: 55, status: 'executed', fwdRet4hPct: 0.1, score4h: 0.3 },
    { ts: BASE_TS + 12 * 3_600_000, action: 'buy', symbol: 'SOLUSDT', sizePct: 25, confidence: 68, status: 'vetoed', fwdRet4hPct: -0.9, score4h: 0 },
    { ts: BASE_TS + 8 * 3_600_000, action: 'sell', symbol: 'ETHUSDT', sizePct: 100, confidence: 70, status: 'executed', fwdRet4hPct: -2.1, score4h: 1 },
  ],
  lessons: [
    'Volume spikes without EMA confluence have been losing trades — skip them.',
    'Funding above 0.05% has preceded pullbacks; be wary of longs there.',
    'Waiting through chop scored well; do not force trades in tight ranges.',
  ],
  triggerReason: 'Woken by: RSI(1h) crossed 70 on BTCUSDT.',
  guardState: '3 trades left today, cooldown 12min remaining.',
};
