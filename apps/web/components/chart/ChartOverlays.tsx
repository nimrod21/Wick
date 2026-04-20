'use client';

interface Props {
  overlays: { ema: boolean; rsi: boolean; macd: boolean };
  onToggle: (key: 'ema' | 'rsi' | 'macd', value: boolean) => void;
}

const CHIPS: Array<{ key: 'ema' | 'rsi' | 'macd'; label: string }> = [
  { key: 'ema', label: 'EMA' },
  { key: 'rsi', label: 'RSI' },
  { key: 'macd', label: 'MACD' },
];

export function ChartOverlays({ overlays, onToggle }: Props) {
  return (
    <div className="flex items-center gap-1">
      {CHIPS.map(({ key, label }) => {
        const active = overlays[key];
        return (
          <button
            key={key}
            type="button"
            onClick={() => onToggle(key, !active)}
            className={
              active
                ? 'pixel-font text-[9px] px-2 py-1 border-2 border-neon-cyan text-neon-cyan glow'
                : 'pixel-font text-[9px] px-2 py-1 border-2 border-border-dim text-text-dim hover:border-neon-cyan hover:text-neon-cyan'
            }
            aria-pressed={active}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
