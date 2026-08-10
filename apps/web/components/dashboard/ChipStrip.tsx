'use client';

/**
 * Dashboard chip strip (IMPL-5 / LAYOUT.md): the whole watchlist plus the
 * macro board on one line — live price, 24h change, and a flash on every tick.
 *
 * Two kinds of chip, deliberately different targets:
 *   crypto → selects the big chart on this page (no navigation)
 *   macro  → deep-links to Intel's macro tab, which owns the depth
 *
 * Crypto prices are patched from the SSE `tick` topic and only fall back to
 * the 60s `/api/market/summary` refetch; macro quotes are polled upstream
 * every 10 minutes, so their chips just follow `/api/intel/macro`.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { Empty } from '@/components/ui';
import { pct, price, shortSymbol } from '@/lib/format';

/** Macro tiles worth a permanent chip, in board order (LAYOUT.md). */
const MACRO_CHIPS: Array<{ name: string; label: string }> = [
  { name: 'oil', label: 'OIL' },
  { name: 'gold', label: 'GOLD' },
  { name: 'silver', label: 'SLV' },
  { name: 'dxy', label: 'DXY' },
];

interface Tick {
  price: number;
  dir: 'up' | 'down';
  seq: number;
}

/** Restart the flash animation on every tick, including repeats. */
function useFlash(seq: number | undefined, dir: 'up' | 'down' | undefined) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useRef(0);
  useEffect(() => {
    if (seq === undefined || seq === seen.current) return;
    seen.current = seq;
    const el = ref.current;
    if (!el) return;
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth; // force reflow so consecutive ticks re-run it
    el.classList.add(dir === 'down' ? 'flash-down' : 'flash-up');
  }, [seq, dir]);
  return ref;
}

function chipClass(selected: boolean): string {
  return `panel flex shrink-0 items-baseline gap-2 px-2 py-1 text-left ${
    selected ? 'border-cyan' : 'hover:border-cyan'
  }`;
}

function CryptoChip({
  symbol,
  label,
  lastPrice,
  changePct,
  tick,
  selected,
  onSelect,
}: {
  symbol: string;
  label: string;
  lastPrice: number | null;
  changePct: number | null;
  tick: Tick | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const ref = useFlash(tick?.seq, tick?.dir);
  const shown = tick?.price ?? lastPrice;
  return (
    <button type="button" onClick={onSelect} className={chipClass(selected)} title={symbol}>
      <span ref={ref} className={`text-[11px] uppercase ${selected ? 'text-cyan' : 'text-muted'}`}>
        {label}
      </span>
      <span className="tnum text-xs">{price(shown)}</span>
      <span
        className={`tnum text-[10px] ${
          changePct === null ? 'text-muted' : changePct >= 0 ? 'text-green' : 'text-red'
        }`}
      >
        {pct(changePct, 1)}
      </span>
    </button>
  );
}

export function ChipStrip({
  symbol,
  onSelectSymbol,
}: {
  symbol: string;
  onSelectSymbol: (symbol: string) => void;
}) {
  const qc = useQueryClient();
  const summary = useQuery({ queryKey: ['market-summary'], queryFn: api.summary, refetchInterval: 60_000 });
  const macro = useQuery({ queryKey: ['intel-macro'], queryFn: api.macro, refetchInterval: 120_000 });

  const [ticks, setTicks] = useState<Record<string, Tick>>({});
  const lastRef = useRef<Record<string, number>>({});

  useLive('tick', (e) => {
    const prev = lastRef.current[e.symbol];
    lastRef.current[e.symbol] = e.price;
    setTicks((s) => ({
      ...s,
      [e.symbol]: {
        price: e.price,
        dir: prev === undefined || prev === e.price ? (s[e.symbol]?.dir ?? 'up') : e.price > prev ? 'up' : 'down',
        seq: (s[e.symbol]?.seq ?? 0) + 1,
      },
    }));
  });

  useLive('macro', () => {
    void qc.invalidateQueries({ queryKey: ['intel-macro'] });
  });

  const symbols = summary.data?.symbols ?? [];
  const tiles = macro.data?.tiles ?? [];

  return (
    <div className="panel flex flex-wrap items-center gap-2 p-2">
      {summary.isError && <Empty>market summary unavailable</Empty>}
      {symbols.map((s) => (
        <CryptoChip
          key={s.symbol}
          symbol={s.symbol}
          label={shortSymbol(s.symbol)}
          lastPrice={s.lastPrice}
          changePct={s.changePct24h}
          tick={ticks[s.symbol]}
          selected={s.symbol === symbol}
          onSelect={() => onSelectSymbol(s.symbol)}
        />
      ))}

      <span className="mx-1 h-6 w-px shrink-0 bg-line" aria-hidden />

      {MACRO_CHIPS.map((m) => {
        const tile = tiles.find((t) => t.name === m.name);
        return (
          <Link
            key={m.name}
            href="/intel?tab=macro"
            className={chipClass(false)}
            title={`${m.name}${tile?.stale ? ' — stale quote' : ''} · open Intel / Macro`}
          >
            <span className="text-[11px] uppercase text-muted">{m.label}</span>
            <span className="tnum text-xs">{price(tile?.price ?? null)}</span>
            <span
              className={`tnum text-[10px] ${
                tile?.changePct === null || tile?.changePct === undefined
                  ? 'text-muted'
                  : tile.changePct >= 0
                    ? 'text-green'
                    : 'text-red'
              }`}
            >
              {pct(tile?.changePct ?? null, 1)}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
