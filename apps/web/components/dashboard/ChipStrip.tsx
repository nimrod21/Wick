'use client';

/**
 * Dashboard chip strip — the whole watchlist on one line, live price, 24h
 * change, and a flash on every tick. Clicking a chip re-points the entire
 * dashboard (chart AND right column) at that asset; it never navigates.
 *
 * Built for ~50 symbols (IMPL-6B): the row scrolls horizontally and can be
 * dragged with the mouse, a search box filters it down, and starred symbols
 * pin themselves to the front. Stars live in localStorage — they reorder the
 * view, they are not a server-side watchlist edit.
 *
 * Prices come from the batched SSE `tick` feed (`useLiveTicks`, 5 Hz) and
 * only fall back to the 60s `/api/market/summary` refetch.
 *
 * The macro board is a SEPARATE export: at 50 crypto chips it no longer
 * belongs on the same scrolling line, so the dashboard renders it with the
 * other market-wide panels.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive, useLiveTicks, type LiveTick } from '@/lib/sse';
import { favoritesFirst, useFavorites } from '@/lib/prefs';
import { Empty } from '@/components/ui';
import { pct, price, shortSymbol } from '@/lib/format';

/** Macro tiles worth a permanent chip, in board order (LAYOUT.md). */
const MACRO_CHIPS: Array<{ name: string; label: string }> = [
  { name: 'oil', label: 'OIL' },
  { name: 'gold', label: 'GOLD' },
  { name: 'silver', label: 'SLV' },
  { name: 'dxy', label: 'DXY' },
];

/** Past this many pixels a pointer gesture is a scroll, not a chip click. */
const DRAG_SLOP_PX = 4;

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

/**
 * Drag-to-scroll for a horizontally scrolling row. Returns the ref to attach
 * plus `wasDragged()`, which a child click handler uses to ignore the click
 * that ends a drag.
 */
function useDragScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, startX: 0, startLeft: 0, moved: 0 });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // Let the search box keep normal text selection/caret behaviour.
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const el = ref.current;
    if (!el) return;
    drag.current = { active: true, startX: e.clientX, startLeft: el.scrollLeft, moved: 0 };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const el = ref.current;
    if (!el || !drag.current.active) return;
    const dx = e.clientX - drag.current.startX;
    drag.current.moved = Math.max(drag.current.moved, Math.abs(dx));
    if (drag.current.moved > DRAG_SLOP_PX) el.scrollLeft = drag.current.startLeft - dx;
  };

  const endDrag = (): void => {
    drag.current.active = false;
  };

  return {
    ref,
    wasDragged: (): boolean => drag.current.moved > DRAG_SLOP_PX,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerLeave: endDrag,
    },
  };
}

function CryptoChip({
  symbol,
  label,
  lastPrice,
  changePct,
  tick,
  selected,
  starred,
  onSelect,
  onStar,
}: {
  symbol: string;
  label: string;
  lastPrice: number | null;
  changePct: number | null;
  tick: LiveTick | undefined;
  selected: boolean;
  starred: boolean;
  onSelect: () => void;
  onStar: () => void;
}) {
  const ref = useFlash(tick?.seq, tick?.dir);
  const shown = tick?.price ?? lastPrice;
  return (
    <span className={chipClass(selected)} title={symbol}>
      <button
        type="button"
        onClick={onStar}
        title={starred ? 'unpin' : 'pin to the front'}
        className={`text-[10px] leading-none ${starred ? 'text-amber' : 'text-line hover:text-amber'}`}
      >
        {starred ? '★' : '☆'}
      </button>
      <button type="button" onClick={onSelect} className="flex items-baseline gap-2 text-left">
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
    </span>
  );
}

export function ChipStrip({
  symbol,
  onSelectSymbol,
}: {
  symbol: string;
  onSelectSymbol: (symbol: string) => void;
}) {
  const summary = useQuery({ queryKey: ['market-summary'], queryFn: api.summary, refetchInterval: 60_000 });
  const ticks = useLiveTicks();
  const [favs, toggleFav] = useFavorites();
  const [filter, setFilter] = useState('');
  const strip = useDragScroll();

  const needle = filter.trim().toUpperCase();
  const rows = favoritesFirst(
    (summary.data?.symbols ?? []).filter((s) => s.symbol.includes(needle)),
    favs,
    (s) => s.symbol,
  );

  return (
    <div className="panel flex items-center gap-2 p-2">
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="filter"
        aria-label="filter watchlist"
        className="w-20 shrink-0 border border-line bg-transparent px-1.5 py-1 text-[11px] uppercase placeholder:text-muted focus:border-cyan focus:outline-none"
      />
      <div
        ref={strip.ref}
        {...strip.handlers}
        className="flex flex-1 select-none items-center gap-2 overflow-x-auto pb-1"
        title="drag or scroll sideways"
      >
        {summary.isError && <Empty>market summary unavailable</Empty>}
        {!summary.isError && rows.length === 0 && (
          <span className="px-1 text-[11px] text-muted">
            {summary.isLoading ? 'loading watchlist…' : `no symbol matches “${filter}”`}
          </span>
        )}
        {rows.map((s) => (
          <CryptoChip
            key={s.symbol}
            symbol={s.symbol}
            label={shortSymbol(s.symbol)}
            lastPrice={s.lastPrice}
            changePct={s.changePct24h}
            tick={ticks[s.symbol]}
            selected={s.symbol === symbol}
            starred={favs.has(s.symbol)}
            onSelect={() => {
              if (!strip.wasDragged()) onSelectSymbol(s.symbol);
            }}
            onStar={() => {
              if (!strip.wasDragged()) toggleFav(s.symbol);
            }}
          />
        ))}
      </div>
      <span className="shrink-0 text-[10px] text-muted">{rows.length}</span>
    </div>
  );
}

/** The macro board — market-wide, so it sits with the global panels. */
export function MacroChips() {
  const qc = useQueryClient();
  const macro = useQuery({ queryKey: ['intel-macro'], queryFn: api.macro, refetchInterval: 120_000 });

  useLive('macro', () => {
    void qc.invalidateQueries({ queryKey: ['intel-macro'] });
  });

  const tiles = macro.data?.tiles ?? [];

  return (
    <div className="panel flex flex-wrap items-center gap-2 p-2">
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
