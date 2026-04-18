'use client';

import { useTradingStore } from '@/lib/store';
import { LightweightChart } from '@/components/chart/LightweightChart';
import { TimeframeSwitcher } from '@/components/chart/TimeframeSwitcher';
import { AssetList } from '@/components/trading/AssetList';
import { Orderbook } from '@/components/trading/Orderbook';
import { RecentTrades } from '@/components/trading/RecentTrades';
import { MarketStats } from '@/components/trading/MarketStats';
import { OrderEntry } from '@/components/trading/OrderEntry';

const TRADING_TYPE = 'crypto' as const;

export default function CryptoTradingPage() {
  const activeAsset = useTradingStore((s) => s.activeAsset[TRADING_TYPE]);
  const timeframe = useTradingStore((s) => s.timeframe[TRADING_TYPE]);

  // Explicit grid rows: top stats strip is auto-sized, middle body fills
  // remaining space, bottom order entry is auto-sized but capped so it
  // can't eat into the chart. Everything uses min-h-0 so flex-column
  // children actually shrink when needed.
  return (
    <div
      className="grid gap-3 h-[calc(100vh-6rem)]"
      style={{ gridTemplateRows: 'auto minmax(0, 1fr) auto' }}
    >
      <MarketStats assetId={activeAsset} />

      <div
        className="grid gap-3 min-h-0"
        style={{ gridTemplateColumns: '240px minmax(0, 1fr) 300px' }}
      >
        <AssetList tradingType={TRADING_TYPE} assetTypes={['crypto']} />

        <div className="flex flex-col border border-border-dim bg-bg-terminal min-h-0 min-w-0">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-dim shrink-0">
            <h2 className="pixel-font text-[10px] text-neon-cyan">
              {activeAsset ? `ASSET #${activeAsset}` : 'SELECT AN ASSET'}
            </h2>
            <TimeframeSwitcher tradingType={TRADING_TYPE} />
          </div>
          <div className="flex-1 min-h-0 min-w-0 relative">
            {activeAsset ? (
              <LightweightChart assetId={activeAsset} timeframe={timeframe} />
            ) : (
              <div className="h-full flex items-center justify-center text-text-dim vt-font text-lg">
                Pick a pair from the list.
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-3 min-h-0" style={{ gridTemplateRows: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
          <Orderbook assetId={activeAsset} />
          <RecentTrades assetId={activeAsset} />
        </div>
      </div>

      <div className="max-h-[22rem] overflow-y-auto">
        <OrderEntry assetId={activeAsset} />
      </div>
    </div>
  );
}
