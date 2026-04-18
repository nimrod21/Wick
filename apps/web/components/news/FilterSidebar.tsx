'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface NewsFilterValue {
  tickers: string[];
  sources: string[];
  sentRange: [number, number];
}

interface FilterSidebarProps {
  value: NewsFilterValue;
  onChange: (next: NewsFilterValue) => void;
}

interface AssetSummary {
  id: number;
  symbol: string;
  type: string;
}

interface AssetsResponse {
  assets: AssetSummary[];
}

// Source list matches the seed + known API feeds. Kept as a stable default
// so the filter renders before the first events arrive.
const SOURCE_OPTIONS: ReadonlyArray<string> = [
  'CoinDesk',
  'Cointelegraph',
  'The Block',
  'Decrypt',
  'Bloomberg Markets',
  'WSJ Markets',
  'CryptoPanic',
  'Finnhub',
];

function stripUsdt(sym: string): string {
  if (sym.endsWith('USDT')) return sym.slice(0, -4);
  return sym;
}

function dedup(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function FilterSidebar({ value, onChange }: FilterSidebarProps) {
  const cryptoQuery = useQuery<AssetsResponse>({
    queryKey: ['assets', 'crypto'],
    queryFn: () => api.get<AssetsResponse>('/api/assets?type=crypto'),
    staleTime: 300_000,
  });
  const stockQuery = useQuery<AssetsResponse>({
    queryKey: ['assets', 'stock'],
    queryFn: () => api.get<AssetsResponse>('/api/assets?type=stock'),
    staleTime: 300_000,
  });

  const tickerOptions = useMemo<string[]>(() => {
    const crypto = (cryptoQuery.data?.assets ?? []).map((a) =>
      stripUsdt(a.symbol),
    );
    const stocks = (stockQuery.data?.assets ?? []).map((a) => a.symbol);
    return dedup([...crypto, ...stocks]).sort();
  }, [cryptoQuery.data, stockQuery.data]);

  const toggleTicker = (t: string): void => {
    const next = value.tickers.includes(t)
      ? value.tickers.filter((x) => x !== t)
      : [...value.tickers, t];
    onChange({ ...value, tickers: next });
  };

  const toggleSource = (s: string): void => {
    const next = value.sources.includes(s)
      ? value.sources.filter((x) => x !== s)
      : [...value.sources, s];
    onChange({ ...value, sources: next });
  };

  const setMin = (n: number): void => {
    const max = Math.max(n, value.sentRange[1]);
    onChange({ ...value, sentRange: [n, max] });
  };

  const setMax = (n: number): void => {
    const min = Math.min(value.sentRange[0], n);
    onChange({ ...value, sentRange: [min, n] });
  };

  const clearAll = (): void => {
    onChange({ tickers: [], sources: [], sentRange: [-1, 1] });
  };

  const [minSent, maxSent] = value.sentRange;

  return (
    <aside className="flex flex-col gap-4 border border-border-dim bg-bg-terminal p-3 overflow-y-auto">
      <div className="flex items-center justify-between">
        <h2 className="pixel-font text-[9px] text-neon-amber glow uppercase">
          Filters
        </h2>
        <button
          type="button"
          onClick={clearAll}
          className="pixel-font text-[8px] px-2 py-1 border-2 border-border-dim text-text-secondary hover:border-neon-red hover:text-neon-red"
        >
          CLEAR ALL
        </button>
      </div>

      {/* Ticker pills */}
      <section className="flex flex-col gap-2">
        <span className="pixel-font text-[8px] text-text-secondary uppercase">
          Tickers
        </span>
        <div className="flex flex-wrap gap-1">
          {tickerOptions.length === 0 ? (
            <span className="vt-font text-[12px] text-text-dim">
              {cryptoQuery.isLoading || stockQuery.isLoading
                ? 'LOADING…'
                : 'NO TICKERS'}
            </span>
          ) : (
            tickerOptions.map((t) => {
              const active = value.tickers.includes(t);
              const cls = active
                ? 'pixel-font text-[8px] px-2 py-1 border-2 bg-neon-amber text-bg-void border-neon-amber'
                : 'pixel-font text-[8px] px-2 py-1 border-2 text-text-secondary border-border-dim hover:border-neon-amber hover:text-neon-amber';
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTicker(t)}
                  className={cls}
                >
                  {t}
                </button>
              );
            })
          )}
        </div>
      </section>

      {/* Sources */}
      <section className="flex flex-col gap-2">
        <span className="pixel-font text-[8px] text-text-secondary uppercase">
          Sources
        </span>
        <div className="flex flex-col gap-1">
          {SOURCE_OPTIONS.map((s) => {
            const active = value.sources.includes(s);
            return (
              <label
                key={s}
                className="flex items-center gap-2 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggleSource(s)}
                  className="accent-neon-amber"
                />
                <span className="vt-font text-[13px] text-text-primary">
                  {s}
                </span>
              </label>
            );
          })}
        </div>
      </section>

      {/* Sentiment range */}
      <section className="flex flex-col gap-2">
        <span className="pixel-font text-[8px] text-text-secondary uppercase">
          Sentiment
        </span>
        <div className="flex items-center justify-between vt-font text-[12px] text-text-primary">
          <span>{minSent.toFixed(2)}</span>
          <span className="text-text-dim">to</span>
          <span>{maxSent.toFixed(2)}</span>
        </div>
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2">
            <span className="pixel-font text-[8px] text-text-secondary w-8">
              MIN
            </span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={minSent}
              onChange={(e) => setMin(Number(e.target.value))}
              className="flex-1 accent-neon-amber"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="pixel-font text-[8px] text-text-secondary w-8">
              MAX
            </span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={maxSent}
              onChange={(e) => setMax(Number(e.target.value))}
              className="flex-1 accent-neon-amber"
            />
          </label>
        </div>
      </section>
    </aside>
  );
}

export default FilterSidebar;
