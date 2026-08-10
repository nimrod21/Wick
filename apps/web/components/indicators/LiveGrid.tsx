'use client';

/**
 * Live indicator grid (IMPL-2): watchlist symbols × every registered
 * indicator.
 *
 * Columns come from `/api/stats/indicators` — i.e. straight off the server's
 * INDICATOR_DEFS registry — so an indicator added in a later phase gets a
 * column here with no edit to this file. Nothing is hardcoded except the
 * symbol/global split, which is itself a field on the registry.
 *
 * Values load once per symbol over the REST route, then SSE `indicator`
 * frames patch individual cells in place (no refetch storm on candle close);
 * a patched cell flashes for two seconds so the update is visible.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api, type IndicatorRollup } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { Empty, Panel } from '@/components/ui';
import { num, shortSymbol } from '@/lib/format';

interface Cell {
  value: number | null;
  vote: string | null;
}

const FLASH_MS = 2_000;

function voteClass(vote: string | null): string {
  return vote === 'bull' ? 'text-green' : vote === 'bear' ? 'text-red' : 'text-muted';
}

function cellKey(symbol: string, name: string): string {
  return `${symbol}|${name}`;
}

function IndicatorCell({ cell, flash }: { cell: Cell | undefined; flash: boolean }) {
  if (!cell) return <td className="px-2 py-1 text-center text-muted">—</td>;
  return (
    <td
      className={`tnum px-2 py-1 text-right ${voteClass(cell.vote)} ${
        flash ? 'outline outline-1 outline-cyan' : ''
      }`}
      title={cell.vote ?? 'no vote'}
    >
      {num(cell.value, 3)}
    </td>
  );
}

export function LiveGrid({
  rollup,
  onPickIndicator,
}: {
  rollup: IndicatorRollup | undefined;
  onPickIndicator: (indicator: string) => void;
}) {
  const summary = useQuery({ queryKey: ['market-summary'], queryFn: api.summary, refetchInterval: 60_000 });
  const symbols = (summary.data?.symbols ?? []).map((s) => s.symbol);

  const sets = useQueries({
    queries: symbols.map((symbol) => ({
      queryKey: ['indicators', symbol],
      queryFn: () => api.indicators(symbol, '1h'),
      staleTime: 60_000,
    })),
  });

  // SSE overlay: symbol|name → freshest cell, applied on top of the fetches.
  const [live, setLive] = useState<Record<string, Cell>>({});
  const [flashing, setFlashing] = useState<Record<string, number>>({});
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    },
    [],
  );

  useLive('indicator', (e) => {
    if (e.tf !== '1h') return;
    const key = cellKey(e.symbol, e.name);
    setLive((prev) => ({ ...prev, [key]: { value: e.value, vote: e.vote } }));
    setFlashing((prev) => ({ ...prev, [key]: Date.now() }));
    timers.current.push(
      setTimeout(() => {
        setFlashing((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }, FLASH_MS),
    );
  });

  const defs = rollup?.indicators ?? [];
  const globalDefs = defs.filter((d) => d.scope === 'global');

  const cellFor = (symbol: string, name: string): Cell | undefined => {
    const patched = live[cellKey(symbol, name)];
    if (patched) return patched;
    const idx = symbols.indexOf(symbol);
    const found = sets[idx]?.data?.indicators.find((i) => i.name === name);
    return found ? { value: found.value, vote: found.vote } : undefined;
  };

  if (summary.isLoading || !rollup) return <Empty>loading indicator grid…</Empty>;
  if (defs.length === 0) return <Empty>no indicators registered</Empty>;
  if (symbols.length === 0) return <Empty>watchlist is empty — add symbols in settings</Empty>;

  return (
    <Panel
      title={`Live — ${symbols.length} symbols × ${defs.length} indicators (1h)`}
      right={
        <span className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted">
          <span className="text-green">bull</span>
          <span className="text-red">bear</span>
          <span>neutral</span>
        </span>
      }
      bodyClassName="p-0"
    >
      {/* ~50 symbols since IMPL-6B: the grid scrolls in both axes inside the
          panel, with the header row pinned so the columns stay readable. */}
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr className="border-b border-line text-[10px] uppercase tracking-wider text-muted">
              <th className="px-2 py-1 text-left font-normal">symbol</th>
              {defs.map((d) => (
                <th key={d.indicator} className="px-2 py-1 text-right font-normal">
                  <button
                    type="button"
                    onClick={() => onPickIndicator(d.indicator)}
                    title={`${d.rule || 'unregistered indicator'} — click for track record`}
                    className="uppercase tracking-wider hover:text-cyan"
                  >
                    {d.indicator}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {symbols.map((symbol) => (
              <tr key={symbol} className="border-b border-line">
                <td className="px-2 py-1 text-fg">{shortSymbol(symbol)}</td>
                {defs.map((d) =>
                  d.scope === 'global' ? (
                    <td key={d.indicator} className="px-2 py-1 text-center text-muted" title="market-wide — see the global row">
                      ·
                    </td>
                  ) : (
                    <IndicatorCell
                      key={d.indicator}
                      cell={cellFor(symbol, d.indicator)}
                      flash={flashing[cellKey(symbol, d.indicator)] !== undefined}
                    />
                  ),
                )}
              </tr>
            ))}
            {globalDefs.length > 0 && (
              <tr className="border-t border-line bg-panel">
                <td className="px-2 py-1 uppercase tracking-wider text-cyan" title="market-wide indicators — one reading for all symbols">
                  global
                </td>
                {defs.map((d) =>
                  d.scope === 'global' ? (
                    <IndicatorCell
                      key={d.indicator}
                      cell={cellFor(symbols[0]!, d.indicator)}
                      flash={flashing[cellKey(symbols[0]!, d.indicator)] !== undefined}
                    />
                  ) : (
                    <td key={d.indicator} className="px-2 py-1 text-center text-muted">
                      ·
                    </td>
                  ),
                )}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-2 py-1 text-[10px] text-muted">
        cell = latest 1h value, colored by its vote · click a column header for that indicator&apos;s track record
      </p>
    </Panel>
  );
}
