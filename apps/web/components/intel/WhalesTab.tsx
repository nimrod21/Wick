'use client';

/**
 * Intel · Whales — the movement log behind the `whale_flow` indicator.
 *
 * direction is read from the EXCHANGE's point of view: `inflow` = coins
 * arriving at an exchange wallet (supply to sell → bearish, red ↓),
 * `outflow` = coins leaving one (bullish, green ↑), `internal` = a shuffle
 * or a non-exchange whale (no vote, muted ↔).
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { Empty, Panel } from '@/components/ui';
import { dateTime, usd } from '@/lib/format';

const MIN_USD_OPTIONS = [0, 1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000];

const DIRECTION = {
  inflow: { arrow: '↓', cls: 'text-red', label: 'into exchange' },
  outflow: { arrow: '↑', cls: 'text-green', label: 'out of exchange' },
  internal: { arrow: '↔', cls: 'text-muted', label: 'internal / non-exchange' },
} as const;

function label(minUsd: number): string {
  return minUsd === 0 ? 'any size' : `≥ ${usd(minUsd, 0)}`;
}

export function WhalesTab() {
  const qc = useQueryClient();
  const [minUsd, setMinUsd] = useState(0);

  const whales = useQuery({
    queryKey: ['intel-whales', minUsd],
    queryFn: () => api.whales({ minUsd }),
    refetchInterval: 120_000,
  });

  useLive('whale', () => {
    void qc.invalidateQueries({ queryKey: ['intel-whales'] });
  });

  const moves = whales.data ?? [];

  return (
    <Panel
      title={`Whale moves — ${moves.length}`}
      right={
        <select
          className="py-0.5 text-[11px]"
          value={minUsd}
          onChange={(e) => setMinUsd(Number(e.target.value))}
          aria-label="minimum move size"
        >
          {MIN_USD_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {label(v)}
            </option>
          ))}
        </select>
      }
      bodyClassName="max-h-[640px] overflow-y-auto p-0"
    >
      {whales.isError ? (
        <Empty>whale log unavailable — {String((whales.error as Error).message)}</Empty>
      ) : moves.length === 0 ? (
        <Empty>{whales.isLoading ? 'loading…' : 'no moves above this size yet'}</Empty>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line text-[10px] uppercase tracking-wider text-muted">
              <th className="px-3 py-1.5 text-left font-normal">time</th>
              <th className="px-3 py-1.5 text-left font-normal">chain</th>
              <th className="px-3 py-1.5 text-left font-normal">dir</th>
              <th className="px-3 py-1.5 text-right font-normal">amount</th>
              <th className="px-3 py-1.5 text-right font-normal">usd</th>
              <th className="px-3 py-1.5 text-left font-normal">address tag</th>
              <th className="px-3 py-1.5 text-left font-normal">tx</th>
            </tr>
          </thead>
          <tbody>
            {moves.map((m) => {
              const d = DIRECTION[m.direction as keyof typeof DIRECTION] ?? DIRECTION.internal;
              return (
                <tr key={m.id} className="border-b border-line last:border-0">
                  <td className="tnum px-3 py-1.5 text-muted">{dateTime(m.ts)}</td>
                  <td className="px-3 py-1.5 uppercase text-muted">{m.chain}</td>
                  <td className={`px-3 py-1.5 ${d.cls}`} title={d.label}>
                    {d.arrow} {m.direction}
                  </td>
                  <td className="tnum px-3 py-1.5 text-right">{m.amount.toFixed(4)}</td>
                  <td className={`tnum px-3 py-1.5 text-right ${d.cls}`}>{usd(m.usd, 0)}</td>
                  <td className="px-3 py-1.5 truncate text-muted">{m.addressTag ?? '—'}</td>
                  <td className="px-3 py-1.5">
                    <a
                      href={`https://mempool.space/tx/${m.tx}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-muted hover:text-cyan"
                      title={m.tx}
                    >
                      {m.tx.slice(0, 10)}…
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
