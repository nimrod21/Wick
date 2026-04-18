'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';

type OrderType = 'MARKET' | 'LIMIT' | 'STOP';
type OrderSide = 'buy' | 'sell';

interface OrderEntryProps {
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

interface OrderResponse {
  id?: number;
  status?: 'filled' | 'pending' | 'rejected' | string;
  message?: string;
}

function isTradeTick(e: unknown): e is TradeTick {
  if (!e || typeof e !== 'object') return false;
  const o = e as { kind?: unknown; price?: unknown };
  return o.kind === 'trade_tick' && typeof o.price === 'number';
}

function fmtPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

interface Toast {
  kind: 'success' | 'error';
  text: string;
}

export function OrderEntry({ assetId }: OrderEntryProps) {
  const qc = useQueryClient();

  const [type, setType] = useState<OrderType>('MARKET');
  const [side, setSide] = useState<OrderSide>('buy');
  const [qtyStr, setQtyStr] = useState('');
  const [limitStr, setLimitStr] = useState('');
  const [stopStr, setStopStr] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmEnabledAt, setConfirmEnabledAt] = useState<number>(0);
  const [now, setNow] = useState<number>(() => Date.now());
  const [toast, setToast] = useState<Toast | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);

  const { lastEvent } = useEventStream(['trade_tick'], {
    assetIds: assetId !== null ? [assetId] : undefined,
  });

  useEffect(() => {
    if (!lastEvent || !isTradeTick(lastEvent)) return;
    if (
      assetId !== null &&
      typeof lastEvent.assetId === 'number' &&
      lastEvent.assetId !== assetId
    ) {
      return;
    }
    setLivePrice(lastEvent.price);
  }, [lastEvent, assetId]);

  useEffect(() => {
    setLivePrice(null);
  }, [assetId]);

  useEffect(() => {
    if (!modalOpen) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [modalOpen]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const qty = useMemo(() => {
    const v = parseFloat(qtyStr);
    return Number.isFinite(v) && v > 0 ? v : null;
  }, [qtyStr]);
  const limitPrice = useMemo(() => {
    const v = parseFloat(limitStr);
    return Number.isFinite(v) && v > 0 ? v : null;
  }, [limitStr]);

  const effectivePrice = useMemo(() => {
    if (type === 'LIMIT') return limitPrice;
    return livePrice;
  }, [type, limitPrice, livePrice]);

  const notional = useMemo(() => {
    if (qty === null || effectivePrice === null) return null;
    return qty * effectivePrice;
  }, [qty, effectivePrice]);

  const placeOrder = useMutation<OrderResponse, Error, void>({
    mutationFn: async () => {
      if (assetId === null || qty === null) throw new Error('missing fields');
      const body: Record<string, unknown> = {
        assetId,
        side,
        type,
        qty,
        confirmed: true,
      };
      if (type === 'LIMIT' && limitPrice !== null) body.limitPrice = limitPrice;
      if (type === 'STOP') {
        const v = parseFloat(stopStr);
        if (Number.isFinite(v) && v > 0) body.stopPrice = v;
      }
      return api.post<OrderResponse>('/api/orders', body);
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['positions'] });
      const status = res?.status ?? 'submitted';
      setToast({ kind: 'success', text: `ORDER ${status.toUpperCase()}` });
      setModalOpen(false);
    },
    onError: (err) => {
      setToast({ kind: 'error', text: err.message || 'ORDER FAILED' });
    },
  });

  if (assetId === null) {
    return (
      <div className="flex flex-col gap-2 p-4 border border-border-dim bg-bg-terminal items-center justify-center min-h-[300px]">
        <span className="pixel-font text-[11px] text-neon-amber glow">SELECT AN ASSET</span>
      </div>
    );
  }

  const canSubmit = qty !== null && (type !== 'LIMIT' || limitPrice !== null);
  const buyBtn =
    'bg-neon-green text-bg-void pixel-font text-[11px] py-3 glow disabled:opacity-40 disabled:cursor-not-allowed';
  const sellBtn =
    'bg-neon-red text-bg-void pixel-font text-[11px] py-3 glow disabled:opacity-40 disabled:cursor-not-allowed';

  const onOpenConfirm = () => {
    if (!canSubmit) return;
    setConfirmEnabledAt(Date.now() + 2000);
    setNow(Date.now());
    setModalOpen(true);
  };
  const confirmDisabled = now < confirmEnabledAt;
  const confirmRemaining = Math.max(0, Math.ceil((confirmEnabledAt - now) / 1000));

  const tabCls = (active: boolean, disabled = false) => {
    if (disabled) {
      return 'pixel-font text-[10px] px-3 py-1 border-2 text-text-dim border-border-dim opacity-50 cursor-not-allowed';
    }
    return active
      ? 'pixel-font text-[10px] px-3 py-1 border-2 bg-neon-cyan text-bg-void border-neon-cyan'
      : 'pixel-font text-[10px] px-3 py-1 border-2 text-text-secondary border-border-dim hover:border-neon-cyan hover:text-neon-cyan';
  };

  const sideCls = (active: boolean, sd: OrderSide) => {
    const base = 'pixel-font text-[10px] px-3 py-1 border-2';
    if (!active) return `${base} text-text-secondary border-border-dim hover:border-neon-cyan hover:text-neon-cyan`;
    return sd === 'buy'
      ? `${base} bg-neon-green text-bg-void border-neon-green`
      : `${base} bg-neon-red text-bg-void border-neon-red`;
  };

  return (
    <div className="flex flex-col gap-2 p-4 border border-border-dim bg-bg-terminal relative">
      {/* Type tabs */}
      <div className="flex gap-1 mb-2">
        <button type="button" className={tabCls(type === 'MARKET')} onClick={() => setType('MARKET')}>
          MARKET
        </button>
        <button type="button" className={tabCls(type === 'LIMIT')} onClick={() => setType('LIMIT')}>
          LIMIT
        </button>
        <button type="button" className={tabCls(false, true)} disabled aria-disabled>
          STOP
        </button>
      </div>

      {/* Side toggle */}
      <div className="flex gap-1">
        <button type="button" className={sideCls(side === 'buy', 'buy')} onClick={() => setSide('buy')}>
          BUY
        </button>
        <button type="button" className={sideCls(side === 'sell', 'sell')} onClick={() => setSide('sell')}>
          SELL
        </button>
      </div>

      {/* Qty */}
      <label className="flex flex-col gap-1 mt-2">
        <span className="pixel-font text-[8px] text-text-secondary uppercase">Qty</span>
        <input
          type="number"
          inputMode="decimal"
          step="0.0001"
          min="0"
          value={qtyStr}
          onChange={(e) => setQtyStr(e.target.value)}
          placeholder="0.0000"
          className="bg-bg-void border border-border-dim px-2 py-1 vt-font text-lg"
        />
      </label>

      {/* Limit price */}
      {type === 'LIMIT' && (
        <label className="flex flex-col gap-1">
          <span className="pixel-font text-[8px] text-text-secondary uppercase">Limit Price</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.0001"
            min="0"
            value={limitStr}
            onChange={(e) => setLimitStr(e.target.value)}
            placeholder="0.00"
            className="bg-bg-void border border-border-dim px-2 py-1 vt-font text-lg"
          />
        </label>
      )}

      {/* Stop price (disabled) */}
      {type === ('STOP' as OrderType) && (
        <label className="flex flex-col gap-1">
          <span className="pixel-font text-[8px] text-text-secondary uppercase">Stop Price</span>
          <input
            type="number"
            disabled
            value={stopStr}
            onChange={(e) => setStopStr(e.target.value)}
            className="bg-bg-void border border-border-dim px-2 py-1 vt-font text-lg opacity-50 cursor-not-allowed"
          />
        </label>
      )}

      {/* Notional preview */}
      <div className="flex items-center justify-between mt-2">
        <span className="pixel-font text-[8px] text-text-secondary uppercase">Notional</span>
        <span className="vt-font text-lg text-neon-cyan">
          {notional !== null ? fmtPrice(notional) : '—'}
        </span>
      </div>

      {/* Place button */}
      <button
        type="button"
        disabled={!canSubmit}
        onClick={onOpenConfirm}
        className={side === 'buy' ? buyBtn : sellBtn}
      >
        PLACE PAPER ORDER
      </button>

      {/* Paper badge */}
      <div className="mt-2 flex justify-center">
        <span className="border-2 border-neon-amber text-neon-amber pixel-font text-[9px] px-2 py-1 uppercase inline-block glow">
          Paper
        </span>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`absolute top-2 right-2 pixel-font text-[9px] px-3 py-2 border-2 ${
            toast.kind === 'success'
              ? 'border-neon-green text-neon-green'
              : 'border-neon-red text-neon-red'
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* Confirm modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 bg-bg-void/80 flex items-center justify-center z-50"
          onClick={() => {
            if (!placeOrder.isPending) setModalOpen(false);
          }}
        >
          <div
            className="bg-bg-terminal border-2 border-neon-cyan p-6 max-w-md flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="pixel-font text-[12px] text-neon-cyan glow uppercase">
              Confirm Paper Order
            </h2>
            <div className="flex flex-col gap-2 vt-font text-base">
              <div className="flex justify-between">
                <span className="text-text-secondary">ASSET ID</span>
                <span className="text-text-primary">{assetId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">SIDE</span>
                <span className={side === 'buy' ? 'text-neon-green' : 'text-neon-red'}>
                  {side.toUpperCase()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">TYPE</span>
                <span className="text-text-primary">{type}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">QTY</span>
                <span className="text-text-primary">{qty ?? '—'}</span>
              </div>
              {type === 'LIMIT' && (
                <div className="flex justify-between">
                  <span className="text-text-secondary">LIMIT</span>
                  <span className="text-text-primary">{fmtPrice(limitPrice)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-text-secondary">NOTIONAL</span>
                <span className="text-neon-cyan">{fmtPrice(notional)}</span>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                className="pixel-font text-[10px] px-4 py-2 border-2 border-border-dim text-text-secondary hover:border-neon-cyan hover:text-neon-cyan"
                disabled={placeOrder.isPending}
                onClick={() => setModalOpen(false)}
              >
                CANCEL
              </button>
              <button
                type="button"
                disabled={confirmDisabled || placeOrder.isPending}
                onClick={() => placeOrder.mutate()}
                className={`pixel-font text-[10px] px-4 py-2 border-2 ${
                  side === 'buy'
                    ? 'bg-neon-green text-bg-void border-neon-green'
                    : 'bg-neon-red text-bg-void border-neon-red'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {placeOrder.isPending
                  ? 'SUBMITTING…'
                  : confirmDisabled
                    ? `CONFIRM (${confirmRemaining}s)`
                    : 'CONFIRM'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default OrderEntry;
