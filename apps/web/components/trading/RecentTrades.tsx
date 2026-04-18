'use client';

import { useEffect, useState } from 'react';
import { useEventStream } from '@/lib/sse';

interface RecentTradesProps {
  assetId: number | null;
}

interface TradeTick {
  kind: 'trade_tick';
  assetId?: number;
  price: number;
  qty: number;
  side: 'buy' | 'sell';
  ts: number;
}

function isTradeTick(e: unknown): e is TradeTick {
  if (!e || typeof e !== 'object') return false;
  const o = e as { kind?: unknown; price?: unknown; qty?: unknown; side?: unknown };
  return (
    o.kind === 'trade_tick' &&
    typeof o.price === 'number' &&
    typeof o.qty === 'number' &&
    (o.side === 'buy' || o.side === 'sell')
  );
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toFixed(3);
  return n.toFixed(4);
}

const MAX_TRADES = 50;

export function RecentTrades({ assetId }: RecentTradesProps) {
  const [trades, setTrades] = useState<TradeTick[]>([]);

  const { lastEvent } = useEventStream(['trade_tick'], {
    assetIds: assetId !== null ? [assetId] : undefined,
  });

  useEffect(() => {
    setTrades([]);
  }, [assetId]);

  useEffect(() => {
    if (!lastEvent || !isTradeTick(lastEvent)) return;
    if (
      assetId !== null &&
      typeof lastEvent.assetId === 'number' &&
      lastEvent.assetId !== assetId
    ) {
      return;
    }
    setTrades((prev) => {
      const next = [lastEvent, ...prev];
      if (next.length > MAX_TRADES) next.length = MAX_TRADES;
      return next;
    });
  }, [lastEvent, assetId]);

  if (assetId === null) {
    return (
      <div className="flex flex-col border border-border-dim bg-bg-terminal h-full items-center justify-center overflow-hidden">
        <span className="pixel-font text-[11px] text-neon-amber glow">SELECT AN ASSET</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col border border-border-dim bg-bg-terminal h-full overflow-hidden">
      <div className="pixel-font text-[9px] text-text-secondary px-2 py-1 border-b border-border-dim flex justify-between">
        <span>TIME</span>
        <span>PRICE</span>
        <span>QTY</span>
      </div>
      <div className="flex flex-col overflow-y-auto flex-1">
        {trades.length === 0 ? (
          <div className="vt-font text-text-dim text-sm px-2 py-2">AWAITING TRADES…</div>
        ) : (
          trades.map((t, i) => {
            const color = t.side === 'buy' ? 'text-neon-green' : 'text-neon-red';
            return (
              <div
                key={`${t.ts}-${i}`}
                className="flex justify-between px-2 py-[1px] text-sm vt-font"
              >
                <span className="text-text-dim">{fmtTime(t.ts)}</span>
                <span className={color}>{fmtPrice(t.price)}</span>
                <span className="text-text-secondary">{fmtQty(t.qty)}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default RecentTrades;
