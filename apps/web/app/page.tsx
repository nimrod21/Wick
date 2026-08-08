'use client';

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { BotCard } from '@/components/dashboard/BotCard';
import { MarketStrip } from '@/components/dashboard/MarketStrip';
import { LiveFeed } from '@/components/dashboard/LiveFeed';
import { Empty, PixelTitle } from '@/components/ui';

export default function DashboardPage() {
  const qc = useQueryClient();
  const { data: bots, isLoading, isError, error } = useQuery({
    queryKey: ['bots'],
    queryFn: api.bots,
    refetchInterval: 30_000,
  });

  // A status change or a fill moves equity/positions — refresh the cards.
  useLive(['bot_status', 'fill'], () => {
    void qc.invalidateQueries({ queryKey: ['bots'] });
  });

  const botNames = useMemo(
    () => new Map((bots ?? []).map((b) => [b.id, b.name] as const)),
    [bots],
  );

  return (
    <div className="space-y-4">
      <PixelTitle className="text-green">DASHBOARD</PixelTitle>

      <MarketStrip />

      <div>
        {isLoading && <Empty>loading bots…</Empty>}
        {isError && <Empty>bots unavailable — {String((error as Error).message)}</Empty>}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(bots ?? []).map((b) => (
            <BotCard key={b.id} bot={b} />
          ))}
        </div>
        {bots && bots.length === 0 && <Empty>no bots yet</Empty>}
      </div>

      <LiveFeed botNames={botNames} />
    </div>
  );
}
