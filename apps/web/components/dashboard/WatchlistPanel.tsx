'use client';

/**
 * WATCHLIST — the platform-standard vertical symbol panel (IMPL-6D).
 *
 * Replaces the 50-chip horizontal ribbon: a docked column of rows, one per
 * symbol — star · ticker · live price · 24h change — with its own scroll and a
 * search box on top. Clicking a row re-points whatever owns the page (the
 * dashboard's chart AND its asset column, the trade page's chart + ticket); it
 * never navigates.
 *
 * Order: starred first (localStorage, a view preference — it never edits the
 * server watchlist), then by 24h QUOTE volume descending, so the liquid names
 * sit at the top the way every exchange sorts them. `/api/market/summary`
 * carries base volume only, so quote volume is derived as volume × last price
 * rather than growing the API for a sort key.
 *
 * Prices come from the batched SSE `tick` feed (`useLiveTicks`, 5 Hz) — ONE
 * subscription for the whole panel, not one per row: 50 symbols push ~100
 * events/s and a handler each would re-render the column a hundred times a
 * second. Each row flashes on its own tick (the only motion here, PLAN §12).
 *
 * Two variants: `dock` (dashboard) collapses to a thin rail and remembers it;
 * `compact` (trade) is height-capped and always open.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type MarketSymbol } from '@/lib/api';
import { useLiveTicks, type LiveTick } from '@/lib/sse';
import { favoritesFirst, useFavorites, useWatchlistCollapsed } from '@/lib/prefs';
import { Panel } from '@/components/ui';
import { pct, price, shortSymbol } from '@/lib/format';

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

/** Sort key: the exchange-standard one, derived (see file header). */
function quoteVolume(s: MarketSymbol): number {
  return (s.volume24h ?? 0) * (s.lastPrice ?? 0);
}

function WatchlistRow({
  symbol,
  lastPrice,
  changePct,
  tick,
  selected,
  starred,
  onSelect,
  onStar,
}: {
  symbol: string;
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
    <div
      className={`flex items-center gap-1.5 border-l-2 px-2 py-1 ${
        selected ? 'border-cyan bg-line' : 'border-transparent hover:bg-[#1A1A24]'
      }`}
    >
      <button
        type="button"
        onClick={onStar}
        title={starred ? 'unpin' : 'pin to the top'}
        aria-label={starred ? `unpin ${symbol}` : `pin ${symbol}`}
        className={`shrink-0 text-[10px] leading-none ${
          starred ? 'text-amber' : 'text-line hover:text-amber'
        }`}
      >
        {starred ? '★' : '☆'}
      </button>
      <button
        type="button"
        onClick={onSelect}
        title={symbol}
        aria-current={selected}
        className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
      >
        <span
          className={`min-w-0 flex-1 truncate text-[11px] uppercase ${
            selected ? 'text-cyan' : 'text-fg'
          }`}
        >
          {shortSymbol(symbol)}
        </span>
        <span ref={ref} className="tnum shrink-0 text-[11px]">
          {price(shown)}
        </span>
        <span
          className={`tnum w-[46px] shrink-0 text-right text-[10px] ${
            changePct === null ? 'text-muted' : changePct >= 0 ? 'text-green' : 'text-red'
          }`}
        >
          {pct(changePct, 1)}
        </span>
      </button>
    </div>
  );
}

export function WatchlistPanel({
  symbol,
  onSelectSymbol,
  variant = 'dock',
  fillRow = false,
}: {
  symbol: string;
  onSelectSymbol: (symbol: string) => void;
  /** `dock`: collapsible dashboard column. `compact`: height-capped picker. */
  variant?: 'dock' | 'compact';
  /**
   * Fill a sibling-defined row height instead of having one of our own: the
   * caller wraps us in a `relative` box and we go absolute inside it, so 50
   * rows can never drive the row's height (they scroll instead).
   */
  fillRow?: boolean;
}) {
  const summary = useQuery({ queryKey: ['market-summary'], queryFn: api.summary, refetchInterval: 60_000 });
  const ticks = useLiveTicks();
  const [favs, toggleFav] = useFavorites();
  const [collapsed, setCollapsed] = useWatchlistCollapsed();
  const [filter, setFilter] = useState('');

  const byVolume = useMemo(
    () => [...(summary.data?.symbols ?? [])].sort((a, b) => quoteVolume(b) - quoteVolume(a)),
    [summary.data],
  );

  const needle = filter.trim().toUpperCase();
  const rows = favoritesFirst(
    byVolume.filter((s) => s.symbol.includes(needle)),
    favs,
    (s) => s.symbol,
  );

  const collapsible = variant === 'dock';

  if (collapsible && collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        title="show the watchlist"
        aria-expanded={false}
        className="panel flex w-full shrink-0 items-center gap-2 px-2 py-1.5 text-[10px] uppercase tracking-wider text-muted hover:text-cyan lg:w-9 lg:flex-col lg:justify-start lg:py-2"
      >
        <span aria-hidden>›</span>
        <span className="lg:[writing-mode:vertical-rl]">watchlist</span>
      </button>
    );
  }

  return (
    <Panel
      className={
        fillRow
          ? 'flex w-full flex-col lg:absolute lg:inset-0'
          : 'flex w-full shrink-0 flex-col lg:w-[220px]'
      }
      title="Watchlist"
      right={
        <span className="flex items-center gap-2">
          <span className="tnum text-[10px] text-muted">{rows.length}</span>
          {collapsible && (
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              title="collapse to a rail"
              aria-expanded
              aria-label="collapse the watchlist"
              className="text-[10px] leading-none text-muted hover:text-cyan"
            >
              ‹
            </button>
          )}
        </span>
      }
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
    >
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="search"
        aria-label="search the watchlist"
        className="w-full border-0 border-b border-line bg-transparent px-2 py-1 text-[11px] uppercase placeholder:text-muted focus:border-cyan focus:outline-none"
      />
      <div
        className={`overflow-y-auto ${
          fillRow
            ? 'max-h-56 lg:max-h-none lg:min-h-0 lg:flex-1'
            : variant === 'dock'
              ? 'max-h-56 lg:max-h-[560px]'
              : 'max-h-56 lg:max-h-[420px]'
        }`}
      >
        {summary.isError && (
          <p className="px-2 py-6 text-center text-[11px] text-muted">market summary unavailable</p>
        )}
        {!summary.isError && rows.length === 0 && (
          <p className="px-2 py-6 text-center text-[11px] text-muted">
            {summary.isLoading ? 'loading watchlist…' : `no symbol matches “${filter}”`}
          </p>
        )}
        {rows.map((s) => (
          <WatchlistRow
            key={s.symbol}
            symbol={s.symbol}
            lastPrice={s.lastPrice}
            changePct={s.changePct24h}
            tick={ticks[s.symbol]}
            selected={s.symbol === symbol}
            starred={favs.has(s.symbol)}
            onSelect={() => onSelectSymbol(s.symbol)}
            onStar={() => toggleFav(s.symbol)}
          />
        ))}
      </div>
    </Panel>
  );
}
