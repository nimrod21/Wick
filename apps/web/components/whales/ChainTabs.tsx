'use client';

export type WhaleChain = 'eth' | 'sol' | 'btc';

interface ChainTabsProps {
  activeChain: WhaleChain;
  onChange: (chain: WhaleChain) => void;
}

const CHAINS: ReadonlyArray<{ id: WhaleChain; label: string }> = [
  { id: 'eth', label: 'ETH' },
  { id: 'sol', label: 'SOL' },
  { id: 'btc', label: 'BTC' },
];

export function ChainTabs({ activeChain, onChange }: ChainTabsProps) {
  return (
    <div className="flex gap-1">
      {CHAINS.map((c) => {
        const active = c.id === activeChain;
        const cls = active
          ? 'pixel-font text-[10px] px-3 py-1 border-2 bg-neon-magenta text-bg-void border-neon-magenta glow'
          : 'pixel-font text-[10px] px-3 py-1 border-2 text-text-secondary border-border-dim hover:border-neon-magenta hover:text-neon-magenta';
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            className={cls}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

export default ChainTabs;
