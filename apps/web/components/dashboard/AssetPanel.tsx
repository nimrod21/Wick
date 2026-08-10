'use client';

/**
 * ASSET VOTES (IMPL-6C) — what every indicator says about the symbol the
 * dashboard is pointed at, plus the two readings that are not a price study
 * (funding, fear & greed) as a header line.
 *
 * This is the panel the deleted /market page used to own; it reads the same
 * `/api/market/indicators?symbol&tf=1h` route and patches itself from the SSE
 * `indicator` topic, so it moves on the hourly close like the grid does.
 */

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { Empty, Panel, VoteDot } from '@/components/ui';
import { num } from '@/lib/format';

export function AssetPanel({ symbol }: { symbol: string }) {
  const qc = useQueryClient();
  const indicators = useQuery({
    queryKey: ['indicators', symbol],
    queryFn: () => api.indicators(symbol, '1h'),
    staleTime: 60_000,
  });

  useLive('indicator', (e) => {
    if (e.symbol === symbol) void qc.invalidateQueries({ queryKey: ['indicators', symbol] });
  });

  const all = indicators.data?.indicators ?? [];
  const funding = all.find((i) => i.name === 'funding');
  const fearGreed = all.find((i) => i.name === 'fear_greed');
  const rows = all.filter((i) => i.name !== 'funding' && i.name !== 'fear_greed');
  const bulls = all.filter((i) => i.vote === 'bull').length;
  const bears = all.filter((i) => i.vote === 'bear').length;

  return (
    <Panel
      title={`${symbol} — votes (1h)`}
      right={
        <span className="flex items-center gap-3 text-[10px] uppercase tracking-wider">
          <span className="text-green">{bulls} bull</span>
          <span className="text-red">{bears} bear</span>
          <Link href="/indicators" className="text-muted hover:text-cyan">
            grid →
          </Link>
        </span>
      }
      bodyClassName="p-0"
    >
      <div className="flex items-center gap-4 border-b border-line px-3 py-1.5 text-[11px]">
        <span className="text-muted">
          funding{' '}
          <span className="tnum text-fg">
            {funding?.value === null || funding?.value === undefined
              ? '—'
              : `${(funding.value * 100).toFixed(4)}%`}
          </span>
        </span>
        <span className="text-muted">
          fear &amp; greed <span className="tnum text-fg">{num(fearGreed?.value, 0)}</span>
        </span>
      </div>
      {rows.length === 0 ? (
        <Empty>{indicators.isLoading ? 'loading…' : `no indicator values for ${symbol} yet`}</Empty>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {rows.map((i) => (
              <tr key={i.name} className="border-b border-line last:border-0">
                <td className="px-3 py-1">{i.name}</td>
                <td className="tnum px-3 py-1 text-right">{num(i.value, 3)}</td>
                <td className="px-3 py-1 text-right">
                  <span className="inline-flex items-center gap-1.5">
                    <VoteDot vote={i.vote} />
                    <span
                      className={
                        i.vote === 'bull' ? 'text-green' : i.vote === 'bear' ? 'text-red' : 'text-muted'
                      }
                    >
                      {i.vote ?? '—'}
                    </span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
