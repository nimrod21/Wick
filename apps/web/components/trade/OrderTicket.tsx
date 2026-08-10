'use client';

/**
 * Order ticket + account box (IMPL-4 /trade).
 *
 * The ticket is deliberately thin: it posts to `/api/trade/order` and shows
 * whatever the engine says. No client-side risk rules — the human is allowed
 * to microtrade; only the engine's hard limits (min $10 notional, enough cash,
 * an actual position to sell) can refuse an order.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, orderError, type TradeAccount } from '@/lib/api';
import { Btn, Stat } from '@/components/ui';
import { pct, shortSymbol, usd } from '@/lib/format';

const FIELD =
  'w-full border border-line bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-cyan';

export function OrderTicket({ symbol, account }: { symbol: string; account?: TradeAccount }) {
  const qc = useQueryClient();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [sizeMode, setSizeMode] = useState<'usd' | 'pct'>('usd');
  const [size, setSize] = useState('100');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const place = useMutation({
    mutationFn: () => {
      const n = Number(size);
      if (!Number.isFinite(n) || n <= 0) throw new Error('size must be a positive number');
      return api.tradeOrder({
        symbol,
        side,
        ...(sizeMode === 'usd' ? { notional: n } : { pct: n }),
        sl_pct: sl === '' ? null : Number(sl),
        tp_pct: tp === '' ? null : Number(tp),
      });
    },
    onSuccess: (res) => {
      setError(null);
      setOk(`${side} filled — ${res.fill.qty.toFixed(6)} ${shortSymbol(symbol)} @ ${res.fill.price.toFixed(2)}`);
      void qc.invalidateQueries({ queryKey: ['trade-account'] });
    },
    onError: (e) => {
      setOk(null);
      setError(orderError(e));
    },
  });

  const position = account?.positions.find((p) => p.symbol === symbol);
  const sizeHint =
    sizeMode === 'usd'
      ? `min ${usd(account?.minNotional ?? 10, 0)}`
      : side === 'buy'
        ? '% of cash'
        : '% of position';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-fg">{shortSymbol(symbol)}</span>
        <span className="text-[10px] text-muted">
          {position ? `holding ${position.qty.toFixed(6)}` : 'no position'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setSide('buy')}
          className={`border px-2 py-1 text-[11px] uppercase tracking-wider ${
            side === 'buy' ? 'border-green bg-green text-bg' : 'border-line text-muted hover:text-fg'
          }`}
        >
          buy
        </button>
        <button
          type="button"
          onClick={() => setSide('sell')}
          className={`border px-2 py-1 text-[11px] uppercase tracking-wider ${
            side === 'sell' ? 'border-red bg-red text-bg' : 'border-line text-muted hover:text-fg'
          }`}
        >
          sell
        </button>
      </div>

      <label className="block">
        <span className="text-[10px] uppercase tracking-wider text-muted">size ({sizeHint})</span>
        <span className="mt-1 flex gap-1">
          <input
            className={FIELD}
            inputMode="decimal"
            value={size}
            aria-label="order size"
            onChange={(e) => setSize(e.target.value)}
          />
          {(['usd', 'pct'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setSizeMode(m)}
              className={`border px-2 text-[11px] ${
                sizeMode === m ? 'border-cyan text-cyan' : 'border-line text-muted hover:text-fg'
              }`}
            >
              {m === 'usd' ? '$' : '%'}
            </button>
          ))}
        </span>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-muted">stop %</span>
          <input
            className={FIELD}
            inputMode="decimal"
            placeholder="none"
            aria-label="stop loss percent"
            value={sl}
            onChange={(e) => setSl(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-muted">take %</span>
          <input
            className={FIELD}
            inputMode="decimal"
            placeholder="none"
            aria-label="take profit percent"
            value={tp}
            onChange={(e) => setTp(e.target.value)}
          />
        </label>
      </div>

      <Btn
        tone={side === 'buy' ? 'go' : 'danger'}
        disabled={place.isPending}
        onClick={() => place.mutate()}
      >
        {place.isPending ? 'sending…' : `${side} ${shortSymbol(symbol)}`}
      </Btn>

      {error && <p className="text-[11px] text-red">{error}</p>}
      {ok && !error && <p className="text-[11px] text-green">{ok}</p>}
      {side === 'sell' && (
        <p className="text-[10px] text-muted">
          selling closes part of the position; a remainder under $0.50 closes it fully
        </p>
      )}
    </div>
  );
}

export function AccountBox({ account }: { account?: TradeAccount }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('1000');
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['trade-account'] });
  };

  const deposit = useMutation({
    mutationFn: () => api.tradeDeposit(Number(amount)),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => setError(orderError(e)),
  });

  const reset = useMutation({
    mutationFn: () => api.tradeReset(),
    onSuccess: () => {
      setError(null);
      setConfirmReset(false);
      refresh();
    },
    onError: (e) => setError(orderError(e)),
  });

  const pnl =
    account === undefined || account.equity === null
      ? null
      : account.equity - account.bankrollStart;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="cash" value={usd(account?.cash ?? null)} />
        <Stat
          label="equity"
          value={usd(account?.equity ?? null)}
          sub={
            pnl === null
              ? undefined
              : `${pnl >= 0 ? '+' : ''}${usd(pnl)} vs ${usd(account?.bankrollStart ?? null, 0)} in`
          }
          valueClass={pnl === null ? '' : pnl >= 0 ? 'text-green' : 'text-red'}
        />
        <Stat label="drawdown" value={pct(account?.drawdownPct ?? null)} />
        <Stat label="open positions" value={account?.positions.length ?? '—'} />
      </div>

      <div className="flex gap-1">
        <input
          className={FIELD}
          inputMode="decimal"
          aria-label="deposit amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Btn disabled={deposit.isPending} onClick={() => deposit.mutate()}>
          add funds
        </Btn>
      </div>

      {confirmReset ? (
        <div className="space-y-1 border border-amber p-2">
          <p className="text-[11px] text-amber">
            reset flattens every position at mid and restores cash to{' '}
            {usd(account?.bankrollStart ?? null, 0)}. Fills and decisions stay — that history is real.
          </p>
          <div className="flex gap-2">
            <Btn tone="danger" disabled={reset.isPending} onClick={() => reset.mutate()}>
              confirm reset
            </Btn>
            <Btn onClick={() => setConfirmReset(false)}>cancel</Btn>
          </div>
        </div>
      ) : (
        <Btn tone="warn" onClick={() => setConfirmReset(true)}>
          reset account
        </Btn>
      )}

      {error && <p className="text-[11px] text-red">{error}</p>}
    </div>
  );
}
