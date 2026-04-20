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

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtQty(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return n.toFixed(3);
  return n.toFixed(5);
}

export function PaperPnL() {
  const qc = useQueryClient();

  // Paper positions — /api/positions returns all positions; paper-only
  // filter is done client-side by broker === 'paper'.
  const {
    data: positionsData,
    isLoading,
    error,
  } = useQuery<{ positions: PositionRow[] }>({
    queryKey: ['paper-pnl', 'positions'],
    queryFn: () => api.get<{ positions: PositionRow[] }>('/api/positions'),
    refetchInterval: 15_000,
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

  // Invalidate on fills so the widget reflects changes immediately.
  const { lastEvent } = useEventStream(['order_status']);
  useEffect(() => {
    if (!lastEvent) return;
    void qc.invalidateQueries({ queryKey: ['paper-pnl', 'positions'] });
  }, [lastEvent, qc]);

  const paperPositions = useMemo(
    () =>
      (positionsData?.positions ?? []).filter(
        (p) => p.broker === 'paper' && p.qty !== 0,
      ),
    [positionsData],
  );

  const priceQueries = useQueries({
    queries: paperPositions.map((p) => ({
      queryKey: ['paper-pnl', 'candles', p.assetId, '1m', 1],
      queryFn: () =>
        api.get<{ candles: CandleBar[] }>(
          `/api/candles?assetId=${p.assetId}&timeframe=1m&limit=1`,
        ),
      refetchInterval: 15_000,
      staleTime: 5_000,
    })),
  });

  const rows = useMemo(() => {
    return paperPositions.map((p, idx) => {
      const candles = priceQueries[idx]?.data?.candles;
      const currentPrice =
        candles && candles.length > 0 ? candles[candles.length - 1].c : null;
      const unrealized =
        currentPrice !== null
          ? (currentPrice - p.avgEntryPrice) * p.qty
          : null;
      return { pos: p, unrealized };
    });
  }, [paperPositions, priceQueries]);

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

  const header = (
    <h3 className="pixel-font text-[10px] text-text-secondary uppercase tracking-wider">
      PAPER P&amp;L
    </h3>
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 border border-border-dim bg-bg-terminal p-3">
        {header}
        <div className="vt-font text-text-dim text-sm">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-2 border border-border-dim bg-bg-terminal p-3">
        {header}
        <div className="pixel-font text-[9px] text-neon-red uppercase">
          {(error as Error).message}
        </div>
      </div>
    );
  }

  if (paperPositions.length === 0) {
    return (
      <div className="flex flex-col gap-2 border border-border-dim bg-bg-terminal p-3">
        {header}
        <div className="vt-font text-sm text-text-dim">
          No open paper positions.
        </div>
      </div>
    );
  }

  const unrealizedCls =
    totalUnrealized === null
      ? 'text-text-dim'
      : totalUnrealized >= 0
        ? 'text-neon-green'
        : 'text-neon-red';

  return (
    <div className="flex flex-col gap-2 border border-border-dim bg-bg-terminal p-3">
      {header}
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="pixel-font text-[9px] text-text-secondary uppercase tracking-wider">
          OPEN:{' '}
          <span className="text-text-primary">
            {paperPositions.length}
          </span>{' '}
          {paperPositions.length === 1 ? 'position' : 'positions'}
        </span>
        <span className="pixel-font text-[9px] text-text-secondary uppercase tracking-wider">
          UNREALIZED:{' '}
          <span className={`vt-font text-base ${unrealizedCls} glow`}>
            {fmtUsd(totalUnrealized)}
          </span>
        </span>
      </div>
      <ul className="divide-y divide-border-dim border-t border-border-dim">
        {rows.map((r) => {
          const symbol = symbolById.get(r.pos.assetId) ?? `#${r.pos.assetId}`;
          const pnlCls =
            r.unrealized === null
              ? 'text-text-dim'
              : r.unrealized >= 0
                ? 'text-neon-green'
                : 'text-neon-red';
          const qtyCls = r.pos.qty >= 0 ? 'text-text-primary' : 'text-neon-red';
          return (
            <li
              key={r.pos.id}
              className="py-1 grid grid-cols-[1fr_auto_auto] items-center gap-3"
            >
              <span className="vt-font text-sm text-neon-cyan truncate">
                {symbol}
              </span>
              <span
                className={`vt-font text-xs tabular-nums ${qtyCls}`}
                title="Qty"
              >
                {fmtQty(r.pos.qty)}
              </span>
              <span
                className={`vt-font text-sm tabular-nums text-right w-24 ${pnlCls}`}
              >
                {fmtUsd(r.unrealized)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default PaperPnL;
