'use client';

/**
 * Shared layout for trading tabs that don't have an L2 orderbook feed
 * (metals, commodities, stocks). Mirrors the crypto page, minus the
 * Orderbook column — replaced with a proxy/info panel since orders execute
 * via Alpaca using ETF proxies.
 */

import { useTradingStore, type TradingType } from '@/lib/store';
import { LightweightChart } from '@/components/chart/LightweightChart';
import { TimeframeSwitcher } from '@/components/chart/TimeframeSwitcher';
import { AssetList } from '@/components/trading/AssetList';
import { RecentTrades } from '@/components/trading/RecentTrades';
import { MarketStats } from '@/components/trading/MarketStats';
import { OrderEntry } from '@/components/trading/OrderEntry';

type AssetKind = 'crypto' | 'stock' | 'commodity' | 'etf';

interface NonCryptoLayoutProps {
  tradingType: Exclude<TradingType, 'crypto'>;
  assetTypes: AssetKind[];
  symbolFilter?: (symbol: string) => boolean;
  proxyNote: string;
}

export function NonCryptoLayout({
  tradingType,
  assetTypes,
  symbolFilter,
  proxyNote,
}: NonCryptoLayoutProps) {
  const activeAsset = useTradingStore((s) => s.activeAsset[tradingType]);
  const selected = useTradingStore((s) => s.selectedAsset[tradingType]);
  const timeframe = useTradingStore((s) => s.timeframe[tradingType]);

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-8rem)]">
      <MarketStats assetId={activeAsset} />

      <div className="grid grid-cols-[220px_1fr_280px] gap-3 flex-1 min-h-0">
        <AssetList
          tradingType={tradingType}
          assetTypes={assetTypes}
          symbolFilter={symbolFilter}
        />

        <div className="flex flex-col border border-border-dim bg-bg-terminal min-h-0">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-dim">
            <h2 className="pixel-font text-[10px] text-neon-cyan">
              {selected ? `${selected.symbol} · ${selected.displayName}` : 'SELECT AN ASSET'}
            </h2>
            <TimeframeSwitcher tradingType={tradingType} />
          </div>
          <div className="flex-1 min-h-0 p-2">
            {activeAsset ? (
              <LightweightChart
                assetId={activeAsset}
                timeframe={timeframe}
                height={480}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-text-dim vt-font text-lg">
                Pick an instrument from the list.
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3 min-h-0">
          <div className="flex flex-col border border-border-dim bg-bg-terminal p-3 gap-2">
            <span className="pixel-font text-[10px] text-neon-amber">
              EXECUTION PROXY
            </span>
            <span className="vt-font text-sm text-text-secondary leading-snug">
              {proxyNote}
            </span>
            <span className="vt-font text-xs text-text-dim leading-snug">
              No L2 orderbook feed — quotes sourced from Twelve Data /
              Yahoo fallback.
            </span>
          </div>
          <div className="flex-1 min-h-0">
            <RecentTrades assetId={activeAsset} />
          </div>
        </div>
      </div>

      <OrderEntry assetId={activeAsset} />
    </div>
  );
}

export default NonCryptoLayout;
