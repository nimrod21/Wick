'use client';

import { useTradingStore, type TradingType, type Timeframe } from '@/lib/store';

interface Props {
  tradingType: TradingType;
}

const TIMEFRAMES: readonly Timeframe[] = ['1m', '3m', '15m', '1h', '4h', '1d', '1w'] as const;

export function TimeframeSwitcher({ tradingType }: Props) {
  const tf = useTradingStore((s) => s.timeframe[tradingType]);
  const setTf = useTradingStore((s) => s.setTimeframe);

  return (
    <div className="flex gap-1" role="tablist" aria-label="Chart timeframe">
      {TIMEFRAMES.map((t) => {
        const active = t === tf;
        const cls = active
          ? 'vt-font text-sm px-2 py-0.5 border-2 transition-none bg-neon-cyan text-bg-void border-neon-cyan'
          : 'vt-font text-sm px-2 py-0.5 border-2 transition-none text-text-secondary border-border-dim hover:border-neon-cyan hover:text-neon-cyan';
        return (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setTf(tradingType, t)}
            className={cls}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}
