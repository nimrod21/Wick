'use client';

import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';

interface OrderRow {
  id: number;
  assetId: number;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop';
  qty: number;
  limitPrice: number | null;
  stopPrice: number | null;
  status: string;
  broker: string;
}

interface AssetLite {
  id: number;
  symbol: string;
  displayName: string | null;
}

function fmtPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

export function OpenOrdersPanel() {
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery<{ orders: OrderRow[] }>({
    queryKey: ['orders', { status: 'pending', limit: 20 }],
    queryFn: () => api.get<{ orders: OrderRow[] }>('/api/orders?status=pending&limit=20'),
    refetchInterval: 5_000,
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
    void qc.invalidateQueries({ queryKey: ['orders'] });
    void qc.invalidateQueries({ queryKey: ['positions'] });
  }, [lastEvent, qc]);

  const cancelMut = useMutation({
    mutationFn: (id: number) => api.del<{ ok: true }>(`/api/orders/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  if (isLoading) {
    return <div className="border border-border-dim bg-bg-terminal p-3 text-text-dim text-xs">Loading orders…</div>;
  }
  if (error) {
    return (
      <div className="border border-border-dim bg-bg-terminal p-3 text-neon-red text-xs">
        Failed: {(error as Error).message}
      </div>
    );
  }

  const orders = data?.orders ?? [];
  if (orders.length === 0) {
    return (
      <div className="border border-border-dim bg-bg-terminal p-3 text-text-dim pixel-font text-[10px] uppercase">
        No open orders
      </div>
    );
  }

  return (
    <div className="border border-border-dim bg-bg-terminal">
      <div className="grid grid-cols-[1fr_60px_60px_1fr_1fr_80px_80px] gap-2 px-3 py-1 pixel-font text-[8px] text-text-secondary uppercase border-b border-border-dim">
        <span>Asset</span>
        <span>Side</span>
        <span>Type</span>
        <span className="text-right">Qty</span>
        <span className="text-right">Price</span>
        <span>Status</span>
        <span />
      </div>
      <div className="flex flex-col">
        {orders.map((o) => {
          const symbol = symbolById.get(o.assetId) ?? `#${o.assetId}`;
          const price =
            o.type === 'limit' ? o.limitPrice : o.type === 'stop' ? o.stopPrice : null;
          return (
            <div
              key={o.id}
              className="grid grid-cols-[1fr_60px_60px_1fr_1fr_80px_80px] gap-2 px-3 py-1 vt-font text-base border-b border-border-dim last:border-b-0"
            >
              <span className="text-neon-cyan truncate">{symbol}</span>
              <span className={o.side === 'buy' ? 'text-neon-green' : 'text-neon-red'}>
                {o.side.toUpperCase()}
              </span>
              <span className="text-text-secondary uppercase">{o.type}</span>
              <span className="text-right text-text-primary">{o.qty}</span>
              <span className="text-right text-text-primary">{fmtPrice(price)}</span>
              <span className="text-text-secondary uppercase">{o.status}</span>
              <button
                type="button"
                disabled={cancelMut.isPending}
                onClick={() => cancelMut.mutate(o.id)}
                className="pixel-font text-[9px] border-2 border-neon-red text-neon-red px-2 py-0.5 disabled:opacity-40"
              >
                {cancelMut.isPending && cancelMut.variables === o.id ? '…' : 'CANCEL'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default OpenOrdersPanel;
