'use client';

/**
 * DASHBOARD — the glance (IMPL-5, LAYOUT.md), an ASSET VIEW (IMPL-6C) with no
 * chart: charts live on /trade. A watchlist docked on the left drives the
 * asset row — the selected coin's indicator votes, its tagged news, whale flow
 * in its context. Market-wide readings (SIGNALS NOW, the macro board) share
 * the grid, and the bot fleet runs along the bottom.
 *
 * Nothing deep lives here: every panel is a link into the page that owns that
 * depth (/indicators, /intel, /bots, /trade).
 */

import { useState } from 'react';
import { MacroChips } from '@/components/dashboard/MacroChips';
import { WatchlistPanel } from '@/components/dashboard/WatchlistPanel';
import { AssetPanel } from '@/components/dashboard/AssetPanel';
import { SignalsPanel } from '@/components/dashboard/SignalsPanel';
import { WhalesPanel } from '@/components/dashboard/WhalesPanel';
import { NewsPanel } from '@/components/dashboard/NewsPanel';
import { BotStrip } from '@/components/dashboard/BotStrip';
import { PixelTitle } from '@/components/ui';
import { shortSymbol } from '@/lib/format';

export default function DashboardPage() {
  const [symbol, setSymbol] = useState('BTCUSDT');
  const asset = shortSymbol(symbol);

  return (
    <div className="space-y-4">
      <PixelTitle className="text-green">DASHBOARD</PixelTitle>

      {/* Bots front and center — they are the product. */}
      <BotStrip />

      {/* [watchlist | 3-col grid]. Row 1: selected asset · market signals ·
          macro. Row 2: the asset's news (wide — headlines want width) · whale
          log. Grid stretch keeps each row's panel edges flush. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
        <WatchlistPanel symbol={symbol} onSelectSymbol={setSymbol} />
        <div className="grid min-w-0 flex-1 gap-4 lg:grid-cols-3">
          <AssetPanel symbol={symbol} />
          <SignalsPanel />
          <MacroChips />
          <div className="min-w-0 lg:col-span-2 [&>section]:h-full">
            <NewsPanel asset={asset} />
          </div>
          <WhalesPanel asset={asset} />
        </div>
      </div>
    </div>
  );
}
