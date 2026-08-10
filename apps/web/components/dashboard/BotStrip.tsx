'use client';

/**
 * Bottom bot strip (IMPL-5 / LAYOUT.md): every bot as a small frame-status
 * card, a [+] into fleet management, and YOU — the human paper account —
 * sitting on the same row because it trades the same engine and belongs on
 * the same scoreboard.
 *
 * The YOU chip is deliberately NOT a BotCard: `/api/bots` never lists the
 * human account (that is `/api/trade`'s), and equity, not W/L, is the whole
 * story a glance needs.
 */

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { BotCard } from '@/components/dashboard/BotCard';
import { Empty, Panel, PixelTitle } from '@/components/ui';
import { pct, usd } from '@/lib/format';

export function BotStrip() {
  const qc = useQueryClient();
  const bots = useQuery({ queryKey: ['bots'], queryFn: api.bots, refetchInterval: 30_000 });
  const account = useQuery({
    queryKey: ['trade-account'],
    queryFn: () => api.tradeAccount(1),
    refetchInterval: 60_000,
  });

  useLive(['bot_status', 'fill'], () => {
    void qc.invalidateQueries({ queryKey: ['bots'] });
    void qc.invalidateQueries({ queryKey: ['trade-account'] });
  });

  const acct = account.data;
  const youPnlPct =
    acct && acct.equity !== null && acct.bankrollStart > 0
      ? ((acct.equity - acct.bankrollStart) / acct.bankrollStart) * 100
      : null;

  return (
    <Panel
      title="bots"
      right={
        <Link href="/bots" className="text-[10px] uppercase text-muted hover:text-cyan">
          manage fleet →
        </Link>
      }
      bodyClassName="p-3"
    >
      <div className="grid items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {bots.isError && <Empty>bots unavailable — {String((bots.error as Error).message)}</Empty>}

        <Link
          href="/trade"
          className="panel flex items-center gap-3 p-3 hover:border-cyan"
          title="your own paper account — trade by hand"
        >
        <span className="inline-block h-2 w-2 bg-cyan" aria-hidden />
        <span className="min-w-0">
          <PixelTitle as="span" className="block text-cyan">
            YOU
          </PixelTitle>
          <span className="mt-1 flex items-baseline gap-2">
            <span className="tnum text-sm">{usd(acct?.equity ?? null, 0)}</span>
            <span
              className={`tnum text-[10px] ${
                youPnlPct === null || youPnlPct === 0 ? 'text-muted' : youPnlPct > 0 ? 'text-green' : 'text-red'
              }`}
            >
              {pct(youPnlPct, 1)}
            </span>
          </span>
          <span className="mt-0.5 block text-[10px] text-muted">
            {acct === undefined ? 'loading…' : `${acct.positions.length} open`}
          </span>
        </span>
      </Link>

      {(bots.data ?? []).map((b) => (
        <BotCard key={b.id} bot={b} />
      ))}

      <Link
        href="/bots"
        className="panel flex min-h-[64px] items-center justify-center border-dashed px-3 text-xs uppercase tracking-wider text-muted hover:border-cyan hover:text-cyan"
        title="manage the fleet — create, start, stop, fund"
      >
        + new bot
      </Link>
      </div>
    </Panel>
  );
}
