'use client';

import { useEffect, useMemo } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';

interface PositionRow {
  id: number;
  broker: string;
  assetId: number;
  qty: number;
  avgEntryPrice: number;
  realizedPnl: number;
  updatedAt: number;
}

interface AssetLite {
  id: number;
  symbol: string;
  displayName: string | null;
}

interface CandleBar {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function fmtPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function PositionsPanel() {
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery<{ positions: PositionRow[] }>({
    queryKey: ['positions'],
    queryFn: () => api.get<{ positions: PositionRow[] }>('/api/positions'),
    refetchInterval: 10_000,
  });

  const { data: assetsData } = useQuery<{ assets: AssetLite[] }>({
    queryKey: ['assets', 'all'],
    queryFn: () => api.get<{ assets: AssetLite[] }>('/api/assets'),
    staleTime: 60_000,
  });

  const symbolById = useMemo(() => {
    const m = new Map<number, string>();
    (assetsData?.assets ?? []).forEach((a) => m.set(a.id, a.symbol));
    return m;
  }, [assetsData]);

  const { lastEvent } = useEventStream(['order_status']);
  useEffect(() => {
    if (!lastEvent) return;
    void qc.invalidateQueries({ queryKey: ['positions'] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
  }, [lastEvent, qc]);

  const positions = data?.positions ?? [];

  const priceQueries = useQueries({
    queries: positions.map((p) => ({
      queryKey: ['candles', p.assetId, '1m', 1],
      queryFn: () =>
        api.get<{ candles: CandleBar[] }>(
          `/api/candles?assetId=${p.assetId}&timeframe=1m&limit=1`,
        ),
      refetchInterval: 15_000,
      staleTime: 5_000,
    })),
  });

  const currentPriceByAsset = useMemo(() => {
    const m = new Map<number, number>();
    positions.forEach((p, idx) => {
      const q = priceQueries[idx];
      const candles = q?.data?.candles;
      if (candles && candles.length > 0) {
        m.set(p.assetId, candles[candles.length - 1].c);
      }
    });
    return m;
  }, [priceQueries, positions]);

  const rows = useMemo(() => {
    return positions.map((p) => {
      const currentPrice = currentPriceByAsset.get(p.assetId) ?? null;
      // qty can be negative (short). PnL handles sign:
      //   long  (qty > 0):  (current - entry) * qty
      //   short (qty < 0):  (current - entry) * qty  (negative qty flips sign)
      const unrealized =
        currentPrice !== null ? (currentPrice - p.avgEntryPrice) * p.qty : null;
      return { pos: p, currentPrice, unrealized };
    });
  }, [positions, currentPriceByAsset]);

  const totalUnrealized = useMemo(() => {
    let sum = 0;
    let any = false;
    for (const r of rows) {
      if (r.unrealized !== null && Number.isFinite(r.unrealized)) {
        sum += r.unrealized;
        any = true;
      }
    }
    return any ? sum : null;
  }, [rows]);

  const totalRealized = useMemo(() => {
    return positions.reduce((acc, p) => acc + (p.realizedPnl || 0), 0);
  }, [positions]);

  if (isLoading) {
    return <div className="border border-border-dim bg-bg-terminal p-3 text-text-dim text-xs">Loading positions…</div>;
  }
  if (error) {
    return (
      <div className="border border-border-dim bg-bg-terminal p-3 text-neon-red text-xs">
        Failed: {(error as Error).message}
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div className="border border-border-dim bg-bg-terminal p-3 text-text-dim pixel-font text-[10px] uppercase">
        No positions
      </div>
    );
  }

  return (
    <div className="border border-border-dim bg-bg-terminal">
      {/* Totals header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-dim">
        <span className="pixel-font text-[9px] text-text-secondary uppercase">Totals</span>
        <div className="flex gap-4 vt-font text-base">
          <span>
            <span className="pixel-font text-[8px] text-text-secondary mr-1 uppercase">Unrealized</span>
            <span
              className={
                totalUnrealized === null
                  ? 'text-text-dim'
                  : totalUnrealized >= 0
                    ? 'text-neon-green'
                    : 'text-neon-red'
              }
            >
              {fmtUsd(totalUnrealized)}
            </span>
          </span>
          <span>
            <span className="pixel-font text-[8px] text-text-secondary mr-1 uppercase">Realized</span>
            <span className={totalRealized >= 0 ? 'text-neon-green' : 'text-neon-red'}>
              {fmtUsd(totalRealized)}
            </span>
          </span>
        </div>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr] gap-2 px-3 py-1 pixel-font text-[8px] text-text-secondary uppercase border-b border-border-dim">
        <span>Asset</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Avg Entry</span>
        <span className="text-right">Price</span>
        <span className="text-right">Unrealized</span>
      </div>

      {/* Rows */}
      <div className="flex flex-col">
        {rows.map((r) => {
          const symbol = symbolById.get(r.pos.assetId) ?? `#${r.pos.assetId}`;
          const pnlCls =
            r.unrealized === null
              ? 'text-text-dim'
              : r.unrealized >= 0
                ? 'text-neon-green'
                : 'text-neon-red';
          return (
            <div
              key={r.pos.id}
              className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr] gap-2 px-3 py-1 vt-font text-base border-b border-border-dim last:border-b-0"
            >
              <span className="text-neon-cyan truncate">{symbol}</span>
              <span className={`text-right ${r.pos.qty >= 0 ? 'text-text-primary' : 'text-neon-red'}`}>
                {r.pos.qty}
              </span>
              <span className="text-right text-text-primary">{fmtPrice(r.pos.avgEntryPrice)}</span>
              <span className="text-right text-text-primary">{fmtPrice(r.currentPrice)}</span>
              <span className={`text-right ${pnlCls}`}>{fmtUsd(r.unrealized)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default PositionsPanel;
