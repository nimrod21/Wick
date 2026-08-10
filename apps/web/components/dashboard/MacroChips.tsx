'use client';

/**
 * The macro board — oil, gold, silver, DXY as one row of chips.
 *
 * This was the tail of the dashboard's chip strip; the crypto half of that
 * strip is gone (IMPL-6D — a 50-chip horizontal ribbon is not how any trading
 * platform shows a watchlist; see WatchlistPanel). Macro stays a chip row: it
 * is four market-wide readings, not a symbol picker, and each one links into
 * Intel / Macro rather than re-pointing the page.
 */

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { pct, price } from '@/lib/format';

/** Macro tiles worth a permanent chip, in board order (LAYOUT.md). */
const MACRO_CHIPS: Array<{ name: string; label: string }> = [
  { name: 'oil', label: 'OIL' },
  { name: 'gold', label: 'GOLD' },
  { name: 'silver', label: 'SLV' },
  { name: 'dxy', label: 'DXY' },
];

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
            className="panel flex shrink-0 items-baseline gap-2 px-2 py-1 text-left hover:border-cyan"
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
