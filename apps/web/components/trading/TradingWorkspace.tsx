'use client';

import { useState } from 'react';
import { useTradingStore, type AssetType } from '@/lib/store';
import { LightweightChart } from '@/components/chart/LightweightChart';
import { TimeframeSwitcher } from '@/components/chart/TimeframeSwitcher';
import { AssetList } from '@/components/trading/AssetList';
import { Orderbook } from '@/components/trading/Orderbook';
import { RecentTrades } from '@/components/trading/RecentTrades';
import { MarketStats } from '@/components/trading/MarketStats';
import { OrderEntry } from '@/components/trading/OrderEntry';
import { OpenOrdersPanel } from '@/components/trading/OpenOrdersPanel';
import { PositionsPanel } from '@/components/trading/PositionsPanel';

type BottomTab = 'orders' | 'positions';

function ExecutionProxyCard({ type }: { type: Exclude<AssetType, 'crypto'> }) {
  const proxyText =
    type === 'metals' ? 'GLD and SLV' : type === 'commodities' ? 'USO' : 'their tickers';
  return (
    <div className="flex flex-col border border-border-dim bg-bg-terminal p-3 gap-2">
      <h3 className="pixel-font text-[10px] text-neon-amber uppercase tracking-wider">
        Execution Proxy
      </h3>
      <p className="vt-font text-sm text-text-secondary">
        Paper orders execute via {proxyText} on Alpaca.
      </p>
      <p className="vt-font text-xs text-text-dim">
        No L2 orderbook feed — quotes sourced from Twelve Data / Yahoo fallback.
      </p>
    </div>
  );
}

function NoL2FeedNote() {
  return (
    <div className="flex flex-col border border-border-dim bg-bg-terminal p-3 gap-1">
      <h3 className="pixel-font text-[10px] text-neon-cyan uppercase tracking-wider">
        Recent Trades
      </h3>
      <p className="vt-font text-xs text-text-dim">
        No L2 feed for this instrument.
      </p>
    </div>
  );
}

function EmptyRightPanel({ title }: { title: string }) {
  return (
    <div className="flex flex-col border border-border-dim bg-bg-terminal/40 p-3 gap-1">
      <h3 className="pixel-font text-[10px] text-text-dim uppercase tracking-wider">
        {title}
      </h3>
      <p className="vt-font text-sm text-text-dim">—</p>
    </div>
  );
}

function OpenOrdersPositionsBar() {
  const [tab, setTab] = useState<BottomTab>('orders');
  const tabCls = (active: boolean) =>
    active
      ? 'pixel-font text-[10px] px-3 py-1 border-2 bg-neon-cyan text-bg-void border-neon-cyan'
      : 'pixel-font text-[10px] px-3 py-1 border-2 text-text-secondary border-border-dim hover:border-neon-cyan hover:text-neon-cyan';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1">
        <button
          type="button"
          className={tabCls(tab === 'orders')}
          onClick={() => setTab('orders')}
        >
          OPEN ORDERS
        </button>
        <button
          type="button"
          className={tabCls(tab === 'positions')}
          onClick={() => setTab('positions')}
        >
          POSITIONS
        </button>
      </div>
      {tab === 'orders' ? <OpenOrdersPanel /> : <PositionsPanel />}
    </div>
  );
}

export function TradingWorkspace() {
  const selected = useTradingStore((s) => s.selectedAsset);
  const timeframe = useTradingStore((s) => s.timeframe);

  const supportsOrderbook = selected?.type === 'crypto';
  const selectedId = selected?.id ?? null;

  return (
    <div className="min-h-[calc(100vh-7rem)] flex flex-col gap-3">
      <MarketStats assetId={selectedId} />

      <div
        className="grid gap-3 flex-1 min-h-0"
        style={{ gridTemplateColumns: '260px minmax(0, 1fr) 340px' }}
      >
        <AssetList />

        <div className="flex flex-col border border-border-dim bg-bg-terminal min-h-0 min-w-0">
          <div className="h-9 flex items-center justify-between px-3 border-b border-border-dim shrink-0">
            <h2 className="pixel-font text-[10px] text-neon-cyan">
              {selected ? `${selected.symbol} · ${selected.displayName}` : 'SELECT AN ASSET'}
            </h2>
            <TimeframeSwitcher />
          </div>
          <div className="flex-1 min-h-0 min-w-0 relative">
            {selected ? (
              <LightweightChart
                assetId={selected.id}
                symbol={selected.symbol}
                timeframe={timeframe}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-text-dim vt-font text-lg">
                Pick an asset from the list.
              </div>
            )}
          </div>
        </div>

        <div
          className="grid gap-3 min-h-0"
          style={{ gridTemplateRows: 'minmax(200px, 1fr) minmax(180px, 1fr) auto' }}
        >
          {selected ? (
            supportsOrderbook ? (
              <>
                <Orderbook assetId={selectedId} />
                <RecentTrades assetId={selectedId} />
              </>
            ) : (
              <>
                <ExecutionProxyCard type={selected.type as Exclude<AssetType, 'crypto'>} />
                <NoL2FeedNote />
              </>
            )
          ) : (
            <>
              <EmptyRightPanel title="Orderbook" />
              <EmptyRightPanel title="Recent Trades" />
            </>
          )}
          <OrderEntry assetId={selectedId} />
        </div>
      </div>

      <OpenOrdersPositionsBar />
    </div>
  );
}

export default TradingWorkspace;
