'use client';

import { useEffect, useMemo, useState } from 'react';
import { useEventStream } from '@/lib/sse';

interface OrderbookProps {
  assetId: number | null;
}

type Level = [number, number]; // [price, qty]

interface OrderbookEvent {
  kind: 'orderbook';
  assetId: number;
  bids: Level[];
  asks: Level[];
  ts: number;
}

interface OrderbookState {
  bids: Level[];
  asks: Level[];
  ts: number | null;
}

function isOrderbookEvent(e: unknown): e is OrderbookEvent {
  if (!e || typeof e !== 'object') return false;
  const o = e as { kind?: unknown; bids?: unknown; asks?: unknown };
  return o.kind === 'orderbook' && Array.isArray(o.bids) && Array.isArray(o.asks);
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

const DEPTH = 20;

export function Orderbook({ assetId }: OrderbookProps) {
  const [book, setBook] = useState<OrderbookState>({ bids: [], asks: [], ts: null });

  const { lastEvent } = useEventStream(['orderbook'], {
    assetIds: assetId !== null ? [assetId] : undefined,
  });

  useEffect(() => {
    if (!lastEvent) return;
    if (!isOrderbookEvent(lastEvent)) return;
    if (assetId !== null && lastEvent.assetId !== assetId) return;
    setBook({ bids: lastEvent.bids, asks: lastEvent.asks, ts: lastEvent.ts });
  }, [lastEvent, assetId]);

  useEffect(() => {
    setBook({ bids: [], asks: [], ts: null });
  }, [assetId]);

  const { bids, asks, maxCumBid, maxCumAsk, bestBid, bestAsk } = useMemo(() => {
    const topBids = book.bids.slice(0, DEPTH);
    const topAsks = book.asks.slice(0, DEPTH);

    let cumBid = 0;
    const bidsWithCum = topBids.map(([p, q]) => {
      cumBid += q;
      return { price: p, qty: q, cum: cumBid };
    });

    let cumAsk = 0;
    const asksWithCum = topAsks.map(([p, q]) => {
      cumAsk += q;
      return { price: p, qty: q, cum: cumAsk };
    });

    return {
      bids: bidsWithCum,
      asks: asksWithCum,
      maxCumBid: cumBid || 1,
      maxCumAsk: cumAsk || 1,
      bestBid: topBids[0]?.[0] ?? null,
      bestAsk: topAsks[0]?.[0] ?? null,
    };
  }, [book]);

  if (assetId === null) {
    return (
      <div className="flex flex-col border border-border-dim bg-bg-terminal text-xs font-mono h-full">
        <div className="pixel-font text-[9px] text-text-secondary px-2 py-1 flex justify-between">
          <span>ORDERBOOK</span>
          <span className="text-text-dim">PRICE / QTY / CUM</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <span className="vt-font text-text-dim text-xs">—</span>
        </div>
      </div>
    );
  }

  const spread =
    bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const mid =
    bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spreadPct =
    spread !== null && mid !== null && mid !== 0 ? (spread / mid) * 100 : null;

  // Asks displayed so best-ask is nearest the spread (nearest-to-spread on bottom of asks block)
  const asksDisplay = [...asks].reverse();

  return (
    <div className="flex flex-col border border-border-dim bg-bg-terminal text-xs font-mono h-full">
      <div className="pixel-font text-[9px] text-text-secondary px-2 py-1 flex justify-between">
        <span>ORDERBOOK</span>
        <span className="text-text-dim">PRICE / QTY / CUM</span>
      </div>

      {/* ASKS */}
      <div className="flex flex-col-reverse flex-1 overflow-hidden">
        {asksDisplay.length === 0 ? (
          <div className="vt-font text-text-dim text-sm px-2 py-2">…</div>
        ) : (
          asksDisplay.map((row, i) => {
            const pct = (row.cum / maxCumAsk) * 100;
            return (
              <div
                key={`ask-${i}-${row.price}`}
                className="relative flex justify-between px-2 py-[1px]"
              >
                <div
                  className="absolute inset-y-0 right-0 bg-neon-red"
                  style={{ width: `${pct}%`, opacity: 0.15 }}
                />
                <span className="vt-font text-[14px] text-neon-red relative z-10">
                  {fmtPrice(row.price)}
                </span>
                <span className="vt-font text-[14px] text-text-secondary relative z-10">
                  {fmtQty(row.qty)}
                </span>
                <span className="vt-font text-[12px] text-text-dim relative z-10">
                  {fmtQty(row.cum)}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* SPREAD */}
      <div className="bg-bg-elevated py-2 px-2 text-center text-neon-cyan vt-font text-base">
        {mid !== null && spread !== null ? (
          <>
            <span className="glow">{fmtPrice(mid)}</span>
            <span className="text-text-secondary text-sm ml-2">
              SPREAD {fmtPrice(spread)}
              {spreadPct !== null ? ` (${spreadPct.toFixed(3)}%)` : ''}
            </span>
          </>
        ) : (
          <span className="text-text-dim">AWAITING FEED…</span>
        )}
      </div>

      {/* BIDS */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {bids.length === 0 ? (
          <div className="vt-font text-text-dim text-sm px-2 py-2">…</div>
        ) : (
          bids.map((row, i) => {
            const pct = (row.cum / maxCumBid) * 100;
            return (
              <div
                key={`bid-${i}-${row.price}`}
                className="relative flex justify-between px-2 py-[1px]"
              >
                <div
                  className="absolute inset-y-0 right-0 bg-neon-green"
                  style={{ width: `${pct}%`, opacity: 0.15 }}
                />
                <span className="vt-font text-[14px] text-neon-green relative z-10">
                  {fmtPrice(row.price)}
                </span>
                <span className="vt-font text-[14px] text-text-secondary relative z-10">
                  {fmtQty(row.qty)}
                </span>
                <span className="vt-font text-[12px] text-text-dim relative z-10">
                  {fmtQty(row.cum)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default Orderbook;
