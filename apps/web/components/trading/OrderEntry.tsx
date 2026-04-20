'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';
import { useLiveModeStore } from '@/lib/store';
import { OpenOrdersPanel } from '@/components/trading/OpenOrdersPanel';
import { PositionsPanel } from '@/components/trading/PositionsPanel';

type OrderType = 'MARKET' | 'LIMIT' | 'STOP';
type OrderSide = 'buy' | 'sell';
type BottomTab = 'orders' | 'positions';

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

interface AssetShape {
  id: number;
  symbol: string;
  displayName: string | null;
  type: string;
  tradeableVia: 'ccxt' | 'alpaca' | null;
  tradeableSymbol: string | null;
}

interface OrderShape {
  id: number;
  clientOrderId?: string;
  broker?: 'paper' | 'ccxt' | 'alpaca' | string;
  assetId?: number;
  side?: 'buy' | 'sell';
  type?: 'market' | 'limit' | 'stop';
  qty?: number;
  limitPrice?: number | null;
  stopPrice?: number | null;
  status?: string;
  avgFillPrice?: number | null;
  error?: string | null;
}

interface OrderResponse {
  ok?: boolean;
  order?: OrderShape;
  error?: string;
  detail?: string;
  reason?: string;
  notional?: number;
  maxNotional?: number;
  issues?: unknown;
}

interface KvValue {
  key: string;
  value: string | null;
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

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function brokerRoute(asset: AssetShape | null | undefined): string {
  if (!asset) return 'paper';
  if (asset.tradeableVia === 'ccxt') return 'ccxt (paper)';
  if (asset.tradeableVia === 'alpaca') return 'alpaca (paper)';
  return 'paper';
}

function extractGuardMessage(err: Error): string {
  // Error messages come from api.request: "POST /api/orders -> 400 {json}"
  const m = err.message.match(/->\s*\d+\s+(.+)$/);
  const rest = m ? m[1] : err.message;
  try {
    const parsed = JSON.parse(rest) as OrderResponse;
    if (parsed.error) {
      // Common guard shapes:
      if (parsed.error === 'notional_exceeds_max' && parsed.notional && parsed.maxNotional) {
        return `BLOCKED: notional $${parsed.notional.toFixed(2)} exceeds max $${parsed.maxNotional.toFixed(2)}`;
      }
      if (parsed.error === 'kill_switch_active') return 'BLOCKED: kill switch active';
      if (parsed.error === 'max_positions_exceeded') return 'BLOCKED: max positions per asset exceeded';
      if (parsed.error === 'daily_loss_cap_reached') return 'BLOCKED: daily loss cap reached';
      if (parsed.error === 'cooldown_active') return 'BLOCKED: order cooldown active';
      if (parsed.error === 'confirmation_required') return 'BLOCKED: confirmation required';
      if (parsed.error === 'live_daily_order_cap_reached') return 'BLOCKED: daily live order cap reached';
      if (parsed.error === 'live_global_cooldown_active') return 'BLOCKED: global live cooldown active';
      if (parsed.error === 'first_per_asset_confirm_required')
        return 'BLOCKED: first live order per asset requires confirmation';
      return `BLOCKED: ${parsed.error}${parsed.detail ? ` — ${parsed.detail}` : ''}`;
    }
  } catch {
    /* fall through */
  }
  return rest || err.message;
}

interface Toast {
  kind: 'success' | 'error';
  text: string;
}

function useKvString(key: string) {
  return useQuery<KvValue>({
    queryKey: ['runtime', 'kv', key],
    queryFn: () => api.get<KvValue>(`/api/runtime/kv/${key}`),
    retry: false,
    staleTime: 15_000,
  });
}

function AccountBalanceHeader() {
  const crypto = useKvString('paper_balance_crypto');
  const stocks = useKvString('paper_balance_stocks');

  const cryptoNum = crypto.data?.value ? Number(crypto.data.value) : null;
  const stocksNum = stocks.data?.value ? Number(stocks.data.value) : null;

  return (
    <div className="flex items-center justify-between border border-border-dim bg-bg-terminal px-3 py-2">
      <div className="flex gap-4 vt-font text-base">
        <span>
          <span className="pixel-font text-[8px] text-text-secondary uppercase mr-2">
            Paper Crypto
          </span>
          <span className="text-neon-cyan">{fmtUsd(cryptoNum)}</span>
        </span>
        <span className="text-text-dim">·</span>
        <span>
          <span className="pixel-font text-[8px] text-text-secondary uppercase mr-2">
            Paper Stocks
          </span>
          <span className="text-neon-cyan">{fmtUsd(stocksNum)}</span>
        </span>
      </div>
      <span className="border-2 border-neon-amber text-neon-amber pixel-font text-[9px] px-2 py-1 uppercase inline-block glow">
        Paper
      </span>
    </div>
  );
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
  const [guardError, setGuardError] = useState<string | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>('orders');
  const [firstPerAssetChecked, setFirstPerAssetChecked] = useState(false);

  const liveConfirmedAssets = useLiveModeStore((s) => s.liveConfirmedAssets);
  const confirmAsset = useLiveModeStore((s) => s.confirmAsset);

  const tradingModeQ = useKvString('trading_mode');
  const isLive = tradingModeQ.data?.value === 'live';
  const needsFirstPerAsset =
    isLive && assetId !== null && !liveConfirmedAssets.has(assetId);

  const { lastEvent } = useEventStream(['trade_tick'], {
    assetIds: assetId !== null ? [assetId] : undefined,
  });

  const { data: assetsData } = useQuery<{ assets: AssetShape[] }>({
    queryKey: ['assets', 'all'],
    queryFn: () => api.get<{ assets: AssetShape[] }>('/api/assets'),
    staleTime: 60_000,
  });
  const asset = useMemo<AssetShape | null>(() => {
    if (assetId === null) return null;
    return assetsData?.assets.find((a) => a.id === assetId) ?? null;
  }, [assetsData, assetId]);

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
  const stopPrice = useMemo(() => {
    const v = parseFloat(stopStr);
    return Number.isFinite(v) && v > 0 ? v : null;
  }, [stopStr]);

  const effectivePrice = useMemo(() => {
    if (type === 'LIMIT') return limitPrice;
    if (type === 'STOP') return stopPrice;
    return livePrice;
  }, [type, limitPrice, stopPrice, livePrice]);

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
        type: type.toLowerCase(),
        qty,
        confirmed: true,
      };
      if (type === 'LIMIT' && limitPrice !== null) body.limitPrice = limitPrice;
      if (type === 'STOP' && stopPrice !== null) body.stopPrice = stopPrice;
      if (isLive && needsFirstPerAsset && firstPerAssetChecked) {
        body.firstPerAssetConfirmed = true;
      }
      return api.post<OrderResponse>('/api/orders', body);
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['positions'] });
      const status = res?.order?.status ?? 'submitted';
      setToast({ kind: 'success', text: `ORDER ${status.toUpperCase()}` });
      setGuardError(null);
      setModalOpen(false);
      if (isLive && assetId !== null && needsFirstPerAsset && firstPerAssetChecked) {
        confirmAsset(assetId);
      }
      setFirstPerAssetChecked(false);
    },
    onError: (err) => {
      const msg = extractGuardMessage(err);
      setGuardError(msg);
      setToast({ kind: 'error', text: msg });
    },
  });

  if (assetId === null) {
    return (
      <div className="flex flex-col gap-3">
        <AccountBalanceHeader />
        <div className="flex flex-col gap-2 p-4 border border-border-dim bg-bg-terminal opacity-50 pointer-events-none">
          <div className="flex gap-1 mb-2">
            <span className="pixel-font text-[10px] px-3 py-1 border-2 bg-neon-cyan text-bg-void border-neon-cyan">
              MARKET
            </span>
            <span className="pixel-font text-[10px] px-3 py-1 border-2 text-text-secondary border-border-dim">
              LIMIT
            </span>
            <span className="pixel-font text-[10px] px-3 py-1 border-2 text-text-secondary border-border-dim">
              STOP
            </span>
          </div>
          <div className="flex gap-1">
            <span className="pixel-font text-[10px] px-3 py-1 border-2 text-text-secondary border-border-dim">
              BUY
            </span>
            <span className="pixel-font text-[10px] px-3 py-1 border-2 text-text-secondary border-border-dim">
              SELL
            </span>
          </div>
          <div className="flex flex-col gap-1 mt-2">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">Qty</span>
            <div className="bg-bg-void border border-border-dim px-2 py-1 vt-font text-lg text-text-dim">
              0.0000
            </div>
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">Notional</span>
            <span className="vt-font text-lg text-text-dim">—</span>
          </div>
          <button
            type="button"
            disabled
            className="bg-neon-green text-bg-void pixel-font text-[11px] py-3 opacity-40 cursor-not-allowed"
          >
            PLACE PAPER ORDER
          </button>
        </div>
        <BottomTabs bottomTab={bottomTab} setBottomTab={setBottomTab} />
      </div>
    );
  }

  const canSubmit =
    qty !== null &&
    (type !== 'LIMIT' || limitPrice !== null) &&
    (type !== 'STOP' || stopPrice !== null);

  const buyBtn =
    'bg-neon-green text-bg-void pixel-font text-[11px] py-3 glow disabled:opacity-40 disabled:cursor-not-allowed';
  const sellBtn =
    'bg-neon-red text-bg-void pixel-font text-[11px] py-3 glow disabled:opacity-40 disabled:cursor-not-allowed';

  const onOpenConfirm = () => {
    if (!canSubmit) return;
    setGuardError(null);
    setFirstPerAssetChecked(false);
    setConfirmEnabledAt(Date.now() + 2000);
    setNow(Date.now());
    setModalOpen(true);
  };
  const confirmDisabled = now < confirmEnabledAt;
  const confirmRemaining = Math.max(0, Math.ceil((confirmEnabledAt - now) / 1000));

  const tabCls = (active: boolean) =>
    active
      ? 'pixel-font text-[10px] px-3 py-1 border-2 bg-neon-cyan text-bg-void border-neon-cyan'
      : 'pixel-font text-[10px] px-3 py-1 border-2 text-text-secondary border-border-dim hover:border-neon-cyan hover:text-neon-cyan';

  const sideCls = (active: boolean, sd: OrderSide) => {
    const base = 'pixel-font text-[10px] px-3 py-1 border-2';
    if (!active)
      return `${base} text-text-secondary border-border-dim hover:border-neon-cyan hover:text-neon-cyan`;
    return sd === 'buy'
      ? `${base} bg-neon-green text-bg-void border-neon-green`
      : `${base} bg-neon-red text-bg-void border-neon-red`;
  };

  const route = brokerRoute(asset);

  return (
    <div className="flex flex-col gap-3">
      <AccountBalanceHeader />

      <div className="flex flex-col gap-2 p-4 border border-border-dim bg-bg-terminal relative">
        {/* Type tabs */}
        <div className="flex gap-1 mb-2">
          <button type="button" className={tabCls(type === 'MARKET')} onClick={() => setType('MARKET')}>
            MARKET
          </button>
          <button type="button" className={tabCls(type === 'LIMIT')} onClick={() => setType('LIMIT')}>
            LIMIT
          </button>
          <button type="button" className={tabCls(type === 'STOP')} onClick={() => setType('STOP')}>
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

        {/* Stop price */}
        {type === 'STOP' && (
          <label className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">Stop Price</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.0001"
              min="0"
              value={stopStr}
              onChange={(e) => setStopStr(e.target.value)}
              placeholder="0.00"
              className="bg-bg-void border border-border-dim px-2 py-1 vt-font text-lg"
            />
          </label>
        )}

        {/* Notional preview */}
        <div className="flex items-center justify-between mt-2">
          <span className="pixel-font text-[8px] text-text-secondary uppercase">Notional</span>
          <span className="vt-font text-lg text-neon-cyan">
            {notional !== null ? fmtUsd(notional) : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="pixel-font text-[8px] text-text-secondary uppercase">Route</span>
          <span className="pixel-font text-[9px] text-neon-magenta">{route}</span>
        </div>

        {/* Persistent guard error below form */}
        {guardError && (
          <div className="border-2 border-neon-red text-neon-red pixel-font text-[9px] px-2 py-2 uppercase glow">
            {guardError}
          </div>
        )}

        {/* Place button */}
        <button
          type="button"
          disabled={!canSubmit}
          onClick={onOpenConfirm}
          className={side === 'buy' ? buyBtn : sellBtn}
        >
          {isLive ? 'PLACE LIVE ORDER' : 'PLACE PAPER ORDER'}
        </button>

        {/* Mode badge */}
        <div className="mt-2 flex justify-center">
          {isLive ? (
            <span className="border-2 border-neon-red text-neon-red pixel-font text-[9px] px-2 py-1 uppercase inline-block glow animate-pulse">
              ● Live
            </span>
          ) : (
            <span className="border-2 border-neon-amber text-neon-amber pixel-font text-[9px] px-2 py-1 uppercase inline-block glow">
              Paper
            </span>
          )}
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
              className="bg-bg-terminal border-2 border-neon-cyan p-6 max-w-md w-full flex flex-col gap-4"
              onClick={(e) => e.stopPropagation()}
            >
              <h2
                className={`pixel-font text-[12px] glow uppercase ${
                  isLive ? 'text-neon-red' : 'text-neon-cyan'
                }`}
              >
                {isLive ? 'Confirm LIVE Order' : 'Confirm Paper Order'}
              </h2>
              <div className="flex flex-col gap-2 vt-font text-base">
                <div className="flex justify-between">
                  <span className="text-text-secondary">ACTION</span>
                  <span className="text-text-primary">
                    {side.toUpperCase()} {type} {qty ?? '—'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">ASSET</span>
                  <span className="text-text-primary">
                    {asset?.symbol ?? `#${assetId}`}
                    {asset?.displayName && asset.displayName !== asset.symbol
                      ? ` — ${asset.displayName}`
                      : ''}
                  </span>
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
                {type === 'STOP' && (
                  <div className="flex justify-between">
                    <span className="text-text-secondary">STOP</span>
                    <span className="text-text-primary">{fmtPrice(stopPrice)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-text-secondary">NOTIONAL</span>
                  <span className="text-neon-cyan">{fmtUsd(notional)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary">ROUTE</span>
                  <span className="text-neon-magenta">{route}</span>
                </div>
              </div>

              {isLive && (
                <div className="border-2 border-neon-red text-neon-red pixel-font text-[10px] px-3 py-2 uppercase glow">
                  ● LIVE MODE — THIS ORDER WILL HIT THE EXCHANGE
                </div>
              )}

              {isLive && needsFirstPerAsset && (
                <label className="flex items-start gap-2 cursor-pointer border-2 border-neon-amber p-2">
                  <input
                    type="checkbox"
                    checked={firstPerAssetChecked}
                    onChange={(e) => setFirstPerAssetChecked(e.target.checked)}
                    className="mt-1"
                  />
                  <span className="pixel-font text-[10px] text-neon-amber uppercase leading-4">
                    I confirm my first live order on {asset?.symbol ?? `#${assetId}`}
                  </span>
                </label>
              )}

              {placeOrder.isError && guardError && (
                <div className="border-2 border-neon-red text-neon-red pixel-font text-[10px] px-3 py-2 uppercase glow">
                  {guardError}
                </div>
              )}

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
                  disabled={
                    confirmDisabled ||
                    placeOrder.isPending ||
                    (isLive && needsFirstPerAsset && !firstPerAssetChecked)
                  }
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

      <BottomTabs bottomTab={bottomTab} setBottomTab={setBottomTab} />
    </div>
  );
}

function BottomTabs({
  bottomTab,
  setBottomTab,
}: {
  bottomTab: BottomTab;
  setBottomTab: (t: BottomTab) => void;
}) {
  const tabCls = (active: boolean) =>
    active
      ? 'pixel-font text-[10px] px-3 py-1 border-2 bg-neon-cyan text-bg-void border-neon-cyan'
      : 'pixel-font text-[10px] px-3 py-1 border-2 text-text-secondary border-border-dim hover:border-neon-cyan hover:text-neon-cyan';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1">
        <button type="button" className={tabCls(bottomTab === 'orders')} onClick={() => setBottomTab('orders')}>
          OPEN ORDERS
        </button>
        <button
          type="button"
          className={tabCls(bottomTab === 'positions')}
          onClick={() => setBottomTab('positions')}
        >
          POSITIONS
        </button>
      </div>
      {bottomTab === 'orders' ? <OpenOrdersPanel /> : <PositionsPanel />}
    </div>
  );
}

export default OrderEntry;
