'use client';

/**
 * WHALES teaser (IMPL-5): the last few moves above the dashboard's own size
 * floor, linking into Intel / Whales for the full log and its filters.
 *
 * The floor is applied server-side (`minUsd`) so "above threshold" means the
 * same thing here as it does on the Intel tab — a $200k shuffle is not news.
 *
 * Whale data is CHAIN-level, not per-asset: the only collector with a key is
 * BTC. So `asset` (IMPL-6C) changes what the panel claims, never what it
 * queries — for BTC it is that asset's own flow, for anything else it is
 * market context and says so.
 */

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { Empty, Panel } from '@/components/ui';
import { ago, usd } from '@/lib/format';

/** Dashboard-only floor — the Intel tab still defaults to "any size". */
const MIN_USD = 1_000_000;
const TOP_N = 7;

const DIRECTION = {
  inflow: { arrow: '↓', cls: 'text-red', label: 'into exchange — supply to sell' },
  outflow: { arrow: '↑', cls: 'text-green', label: 'out of exchange' },
  internal: { arrow: '↔', cls: 'text-muted', label: 'internal / non-exchange' },
} as const;

export function WhalesPanel({ asset }: { asset?: string }) {
  const qc = useQueryClient();
  const whales = useQuery({
    queryKey: ['intel-whales', MIN_USD],
    queryFn: () => api.whales({ minUsd: MIN_USD, limit: TOP_N }),
    refetchInterval: 120_000,
  });

  useLive('whale', () => {
    void qc.invalidateQueries({ queryKey: ['intel-whales'] });
  });

  const moves = whales.data ?? [];
  const ownChain = asset === 'BTC';

  return (
    <Panel
      title={
        <span title={ownChain ? undefined : 'BTC chain — the only whale collector with a key; market context for other assets'}>
          {ownChain ? `Whales — ${asset}` : 'Whales — BTC chain'} ≥ {usd(MIN_USD, 0)}
        </span>
      }
      right={
        <Link href="/intel?tab=whales" className="text-[10px] uppercase tracking-wider text-muted hover:text-cyan">
          whale log →
        </Link>
      }
      bodyClassName="p-0"
    >
      {whales.isError ? (
        <Empty>whale log unavailable</Empty>
      ) : moves.length === 0 ? (
        <Empty>{whales.isLoading ? 'loading…' : 'no moves above this size yet'}</Empty>
      ) : (
        <ul>
          {moves.map((m) => {
            const d = DIRECTION[m.direction as keyof typeof DIRECTION] ?? DIRECTION.internal;
            return (
              <li key={m.id} className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs last:border-0">
                <span className="tnum w-8 shrink-0 text-muted">{ago(m.ts)}</span>
                <span className={`w-4 shrink-0 ${d.cls}`} title={d.label}>
                  {d.arrow}
                </span>
                <span className="tnum shrink-0 uppercase text-muted">{m.chain}</span>
                <span className={`tnum flex-1 text-right ${d.cls}`}>{usd(m.usd, 0)}</span>
                <span className="w-24 shrink-0 truncate text-right text-muted" title={m.addressTag ?? ''}>
                  {m.addressTag ?? '—'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
