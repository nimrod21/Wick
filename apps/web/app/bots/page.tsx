'use client';

/**
 * Fleet management (IMPL-1). Everything about a bot's life is here: create,
 * start, stop, top up, delete. Status is the card frame — lit green running,
 * dim stopped, red busted — so the fleet reads at a glance.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { BotCard } from '@/components/dashboard/BotCard';
import { NewBotCard } from '@/components/bots/NewBotCard';
import { Empty, PixelTitle } from '@/components/ui';

export default function BotsPage() {
  const qc = useQueryClient();
  const { data: bots, isLoading, isError, error } = useQuery({
    queryKey: ['bots'],
    queryFn: api.bots,
    refetchInterval: 30_000,
  });

  useLive(['bot_status', 'fill'], () => {
    void qc.invalidateQueries({ queryKey: ['bots'] });
  });

  const running = (bots ?? []).filter((b) => b.status === 'running').length;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <PixelTitle className="text-green">BOTS</PixelTitle>
        <span className="text-[11px] uppercase tracking-wider text-muted">
          {running} running / {(bots ?? []).length} total
        </span>
      </div>

      {isLoading && <Empty>loading bots…</Empty>}
      {isError && <Empty>bots unavailable — {String((error as Error).message)}</Empty>}

      {/* items-start: an expanded NewBotCard form must not inflate the other
          cards in its row to the form's height. */}
      <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(bots ?? []).map((b) => (
          <BotCard key={b.id} bot={b} actions />
        ))}
        <NewBotCard />
      </div>
    </div>
  );
}
