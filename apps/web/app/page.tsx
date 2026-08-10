'use client';

/**
 * DASHBOARD — the glance (IMPL-5, LAYOUT.md).
 *
 * Chips on top, one big chart in the middle, three teaser panels down the
 * right, the bot fleet along the bottom. Nothing deep lives here: every panel
 * is a link into the page that owns that depth (/indicators, /intel, /bots,
 * /trade), and the decision feed that used to sit here now lives on the bot
 * pages where a decision has context.
 *
 * The centre is one `<ChartPane>` fed a single symbol. A 2×2 grid variant was
 * explicitly left open (LAYOUT.md): it would swap this one component out, not
 * rework the page, which is why the chart owns its own timeframe/candle state.
 */

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, TIMEFRAMES, type Tf } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { ChipStrip } from '@/components/dashboard/ChipStrip';
import { SignalsPanel } from '@/components/dashboard/SignalsPanel';
import { WhalesPanel } from '@/components/dashboard/WhalesPanel';
import { NewsPanel } from '@/components/dashboard/NewsPanel';
import { BotStrip } from '@/components/dashboard/BotStrip';
import { Empty, Panel, PixelTitle } from '@/components/ui';
import { pct, price } from '@/lib/format';

// lightweight-charts touches `document` at import time (IMPL-4 pitfall 1).
const CandleChart = dynamic(() => import('@/components/charts/CandleChart').then((m) => m.CandleChart), {
  ssr: false,
  loading: () => <div className="h-[420px]" />,
});

export default function DashboardPage() {
  const [symbol, setSymbol] = useState('BTCUSDT');

  return (
    <div className="space-y-4">
      <PixelTitle className="text-green">DASHBOARD</PixelTitle>

      <ChipStrip symbol={symbol} onSelectSymbol={setSymbol} />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <ChartPane symbol={symbol} />
        <div className="space-y-4">
          <SignalsPanel />
          <WhalesPanel />
          <NewsPanel />
        </div>
      </div>

      <BotStrip />
    </div>
  );
}

/** The one big chart. Swap this component for a grid to change the centre. */
function ChartPane({ symbol }: { symbol: string }) {
  const qc = useQueryClient();
  const [tf, setTf] = useState<Tf>('1h');

  const candles = useQuery({
    queryKey: ['candles', symbol, tf],
    queryFn: () => api.candles(symbol, tf, 400),
  });
  const summary = useQuery({ queryKey: ['market-summary'], queryFn: api.summary, refetchInterval: 60_000 });

  // Closed candles still trigger a refetch — CandleChart merges it into the
  // live series (no viewport reset), and it self-heals any gap the SSE missed.
  useLive('candle', (e) => {
    if (e.symbol === symbol && e.tf === tf && e.closed) {
      void qc.invalidateQueries({ queryKey: ['candles', symbol, tf] });
    }
  });
  // The header price must track the chip and the chart, not the 60s summary.
  const [tick, setTick] = useState<{ symbol: string; price: number } | null>(null);
  useLive('tick', (e) => {
    if (e.symbol === symbol) setTick({ symbol: e.symbol, price: e.price });
  });

  const row = summary.data?.symbols.find((s) => s.symbol === symbol);
  const lastPrice = tick?.symbol === symbol ? tick.price : (row?.lastPrice ?? null);

  return (
    <Panel
      title={
        <span className="flex items-baseline gap-2">
          <span className="text-fg">{symbol}</span>
          <span className="tnum normal-case tracking-normal">{price(lastPrice)}</span>
          <span
            className={`tnum normal-case tracking-normal ${
              row?.changePct24h === null || row?.changePct24h === undefined
                ? 'text-muted'
                : row.changePct24h >= 0
                  ? 'text-green'
                  : 'text-red'
            }`}
          >
            {pct(row?.changePct24h ?? null)}
          </span>
        </span>
      }
      right={
        <span className="flex gap-1">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTf(t)}
              className={`px-1 text-[10px] ${t === tf ? 'text-cyan' : 'text-muted hover:text-fg'}`}
            >
              {t}
            </button>
          ))}
        </span>
      }
      bodyClassName="p-0"
    >
      {(candles.data?.length ?? 0) === 0 ? (
        <Empty>
          {candles.isLoading ? 'loading candles…' : `no candles for ${symbol} ${tf}`}
        </Empty>
      ) : (
        <CandleChart candles={candles.data!} symbol={symbol} tf={tf} height={420} />
      )}
    </Panel>
  );
}
