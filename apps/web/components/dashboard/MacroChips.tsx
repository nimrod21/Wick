'use client';

/**
 * MACRO panel — every macro reading as a proper row (name · price · day %),
 * plus fear & greed. Data-driven off /api/intel/macro tiles so new symbols
 * appear without UI edits. Rows link into Intel / Macro for the full charts.
 */

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { Empty, Panel } from '@/components/ui';
import { pct, price } from '@/lib/format';

const LABELS: Record<string, string> = {
  oil: 'OIL (WTI)',
  gold: 'GOLD',
  silver: 'SILVER',
  dxy: 'DOLLAR (DXY)',
  vix: 'VIX',
};

export function MacroChips() {
  const qc = useQueryClient();
  const macro = useQuery({ queryKey: ['intel-macro'], queryFn: api.macro, refetchInterval: 120_000 });

  useLive('macro', () => {
    void qc.invalidateQueries({ queryKey: ['intel-macro'] });
  });

  const tiles = macro.data?.tiles ?? [];
  const fg = macro.data?.fearGreed ?? null;

  return (
    <Panel
      title="macro"
      right={
        <Link href="/intel?tab=macro" className="text-[10px] uppercase text-muted hover:text-cyan">
          full board →
        </Link>
      }
      bodyClassName="p-0"
    >
      {tiles.length === 0 ? (
        <Empty>{macro.isLoading ? 'loading…' : 'no macro quotes yet'}</Empty>
      ) : (
        <ul>
          {tiles.map((t) => (
            <li key={t.name}>
              <Link
                href="/intel?tab=macro"
                className="flex items-baseline justify-between gap-2 border-b border-line px-3 py-1.5 hover:bg-[#16161f]"
                title={t.stale ? `${t.name} — stale quote` : t.name}
              >
                <span className="text-[11px] uppercase text-muted">
                  {LABELS[t.name] ?? t.name.toUpperCase()}
                  {t.stale ? ' *' : ''}
                </span>
                <span className="flex items-baseline gap-2">
                  <span className="tnum text-xs">{price(t.price)}</span>
                  <span
                    className={`tnum w-12 text-right text-[10px] ${
                      t.changePct === null || t.changePct === undefined
                        ? 'text-muted'
                        : t.changePct >= 0
                          ? 'text-green'
                          : 'text-red'
                    }`}
                  >
                    {pct(t.changePct ?? null, 1)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
          <li className="flex items-baseline justify-between gap-2 px-3 py-1.5">
            <span className="text-[11px] uppercase text-muted">fear &amp; greed</span>
            <span className="flex items-baseline gap-2">
              <span className="tnum text-xs">{fg ? fg.value : '—'}</span>
              <span className="w-12 text-right text-[10px] uppercase text-amber">
                {fg ? fg.classification : ''}
              </span>
            </span>
          </li>
        </ul>
      )}
    </Panel>
  );
}
