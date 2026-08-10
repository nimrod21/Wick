'use client';

/**
 * DASHBOARD — the glance (IMPL-5, LAYOUT.md), now an ASSET VIEW (IMPL-6C).
 *
 * A watchlist docked on the left, one big chart in the middle under its
 * asset-context header, and a right column that is ABOUT the selected asset:
 * its indicator votes, its tagged news, whale flow in its context. Picking a
 * watchlist row re-points all of it at once — no navigation, no second page.
 * Market-wide readings (SIGNALS NOW, the macro board) sit in their own row
 * below, and the bot fleet along the bottom.
 *
 * Nothing deep lives here: every panel is a link into the page that owns that
 * depth (/indicators, /intel, /bots, /trade). The old /market page was this
 * view with a worse chart and is gone; its API routes are untouched.
 */

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, TIMEFRAMES, type Tf } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { MacroChips } from '@/components/dashboard/MacroChips';
import { WatchlistPanel } from '@/components/dashboard/WatchlistPanel';
import { AssetPanel } from '@/components/dashboard/AssetPanel';
import { SignalsPanel } from '@/components/dashboard/SignalsPanel';
import { WhalesPanel } from '@/components/dashboard/WhalesPanel';
import { NewsPanel } from '@/components/dashboard/NewsPanel';
import { BotStrip } from '@/components/dashboard/BotStrip';
import { Empty, Panel, PixelTitle, Stat } from '@/components/ui';
import { pct, price, shortSymbol } from '@/lib/format';

// lightweight-charts touches `document` at import time (IMPL-4 pitfall 1).
const CandleChart = dynamic(() => import('@/components/charts/CandleChart').then((m) => m.CandleChart), {
  ssr: false,
  loading: () => <div className="h-[420px]" />,
});

export default function DashboardPage() {
  const [symbol, setSymbol] = useState('BTCUSDT');
  const asset = shortSymbol(symbol);

  return (
    <div className="space-y-4">
      <PixelTitle className="text-green">DASHBOARD</PixelTitle>

      {/* [watchlist | center | right] — chart stays top-central; signals+macro
          tuck under it at the same width; the asset stack fills the right
          column. Flex (not grid) so the watchlist rail collapse reflows alone. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <WatchlistPanel symbol={symbol} onSelectSymbol={setSymbol} />
        <div className="grid min-w-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            <ChartPane symbol={symbol} />
            <div className="grid gap-4 sm:grid-cols-2">
              <SignalsPanel />
              <MacroChips />
            </div>
          </div>
          <div className="min-w-0 space-y-4">
            <AssetPanel symbol={symbol} />
            <NewsPanel asset={asset} />
            <WhalesPanel asset={asset} />
          </div>
        </div>
      </div>

      <BotStrip />
    </div>
  );
}

/** The one big chart, under the selected asset's 24h context. */
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
  const changeClass =
    row?.changePct24h === null || row?.changePct24h === undefined
      ? 'text-muted'
      : row.changePct24h >= 0
        ? 'text-green'
        : 'text-red';

  return (
    <Panel
      title={
        <span className="flex items-baseline gap-2">
          <span className="text-fg">{symbol}</span>
          <span className="tnum normal-case tracking-normal">{price(lastPrice)}</span>
          <span className={`tnum normal-case tracking-normal ${changeClass}`}>
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
      className="lg:self-start"
      bodyClassName="p-0"
    >
      <div className="grid grid-cols-2 gap-2 border-b border-line p-3 sm:grid-cols-4">
        <Stat label="last" value={price(lastPrice)} />
        <Stat label="24h" value={pct(row?.changePct24h ?? null)} valueClass={changeClass} />
        <Stat
          label="24h high / low"
          value={`${price(row?.high24h ?? null)} / ${price(row?.low24h ?? null)}`}
        />
        <Stat
          label={`24h volume (${shortSymbol(symbol)})`}
          value={
            row?.volume24h == null
              ? '—'
              : row.volume24h.toLocaleString('en-US', { maximumFractionDigits: 0 })
          }
        />
      </div>
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
