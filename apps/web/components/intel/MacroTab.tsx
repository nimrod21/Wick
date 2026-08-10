'use client';

/**
 * Intel · Macro — the five Yahoo quotes (gold, oil, silver, DXY, VIX) plus
 * fear & greed. Tiles show price, day change and a spark of the stored
 * `macro_quotes` history; clicking one opens the same series large.
 *
 * The quotes are polled every 10 minutes and served last-known-good, so a
 * tile can be stale without being wrong — that is marked, not hidden.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MacroTile } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { Empty, Panel, Sparkline } from '@/components/ui';
import { ago, dateTime, pct, price, signClass } from '@/lib/format';

/** Fear & greed is a 0–100 sentiment index; red stays reserved for losses. */
function fgClass(value: number): string {
  if (value >= 55) return 'text-green';
  if (value <= 45) return 'text-amber';
  return 'text-muted';
}

function Tile({
  tile,
  selected,
  onSelect,
}: {
  tile: MacroTile;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`panel p-3 text-left ${selected ? 'border-cyan' : 'hover:border-cyan'}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted">{tile.name}</span>
        <span className="text-[10px] text-muted">{tile.symbol}</span>
      </div>
      <div className="tnum mt-1 text-lg">{price(tile.price)}</div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className={`tnum text-xs ${signClass(tile.changePct)}`}>{pct(tile.changePct)}</span>
        <span className="text-[10px] text-muted">
          {tile.ts === null ? 'no data' : `${ago(tile.ts)} ago`}
          {tile.stale ? ' · stale' : ''}
        </span>
      </div>
      <Sparkline
        values={tile.history.map((h) => h.price)}
        width={160}
        height={26}
        className="mt-2 w-full"
        label={`${tile.name} price sparkline`}
      />
    </button>
  );
}

export function MacroTab() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  const macro = useQuery({ queryKey: ['intel-macro'], queryFn: api.macro, refetchInterval: 120_000 });

  useLive('macro', () => {
    void qc.invalidateQueries({ queryKey: ['intel-macro'] });
  });

  const tiles = macro.data?.tiles ?? [];
  const fg = macro.data?.fearGreed ?? null;
  const focus = tiles.find((t) => t.name === selected) ?? null;
  const values = focus?.history.map((h) => h.price) ?? [];

  if (macro.isError) {
    return <Empty>macro board unavailable — {String((macro.error as Error).message)}</Empty>;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <Tile
            key={t.name}
            tile={t}
            selected={selected === t.name}
            onSelect={() => setSelected((s) => (s === t.name ? null : t.name))}
          />
        ))}

        <div className="panel p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted">fear &amp; greed</div>
          {fg === null ? (
            <div className="mt-1 text-sm text-muted">—</div>
          ) : (
            <>
              <div className={`tnum mt-1 text-lg ${fgClass(fg.value)}`}>{fg.value}</div>
              <div className="mt-0.5 flex items-baseline justify-between gap-2">
                <span className="text-xs text-muted">{fg.classification}</span>
                <span className="text-[10px] text-muted">{ago(fg.ts)} ago</span>
              </div>
              <span className="mt-3 block h-1.5 w-full bg-line" aria-hidden>
                <span
                  className={`block h-full ${fg.value >= 55 ? 'bg-green' : fg.value <= 45 ? 'bg-amber' : 'bg-muted'}`}
                  style={{ width: `${Math.max(0, Math.min(100, fg.value))}%` }}
                />
              </span>
            </>
          )}
        </div>
      </div>

      {focus && (
        <Panel
          title={`${focus.name.toUpperCase()} — ${focus.symbol}`}
          right={
            <span className="tnum text-[11px] text-muted">
              {price(focus.price)} <span className={signClass(focus.changePct)}>{pct(focus.changePct)}</span>
            </span>
          }
        >
          {values.length < 2 ? (
            <Empty>only {values.length} stored quote so far — the chart fills in as the poller runs</Empty>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Sparkline values={values} width={900} height={220} label={`${focus.name} price history`} />
              </div>
              <div className="mt-2 flex justify-between text-[10px] text-muted">
                <span>{dateTime(focus.history[0]?.ts)}</span>
                <span className="tnum">
                  low {price(Math.min(...values))} · high {price(Math.max(...values))} · {values.length} points
                </span>
                <span>{dateTime(focus.history[focus.history.length - 1]?.ts)}</span>
              </div>
            </>
          )}
        </Panel>
      )}
    </div>
  );
}
