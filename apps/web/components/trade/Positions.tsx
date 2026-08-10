'use client';

/**
 * Your open positions and your fill history (IMPL-4 /trade).
 *
 * P&L ticks off the live `tick` bus, not a poll: the page passes the newest
 * price per symbol in, so the number moves between refetches. SL/TP are
 * editable inline — the PATCH stores absolute levels off the average entry and
 * the protector (which reconciles `positions` every 5s) arms them for you,
 * asleep or not.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, fillReason, orderError, type BotPosition, type TradeFill } from '@/lib/api';
import { Btn, Empty } from '@/components/ui';
import { dateTime, price, shortSymbol, signClass, usd } from '@/lib/format';

const FIELD = 'w-16 border border-line bg-bg px-1 py-0.5 text-[11px] text-fg outline-none focus:border-cyan';

/** Percent distance of a level from the entry, for the editable inputs. */
function levelPct(entry: number, level: number | null, dir: 1 | -1): string {
  if (level === null || entry <= 0) return '';
  return (((level - entry) / entry) * 100 * dir).toFixed(2);
}

export function OpenPositions({
  positions,
  live,
}: {
  positions: BotPosition[];
  live: Record<string, number>;
}) {
  if (positions.length === 0) return <Empty>no open positions</Empty>;
  return (
    <table className="w-full text-xs">
      <thead className="text-[10px] uppercase tracking-wider text-muted">
        <tr className="border-b border-line">
          <th className="px-3 py-1 text-left">symbol</th>
          <th className="px-3 py-1 text-right">qty</th>
          <th className="px-3 py-1 text-right">entry</th>
          <th className="px-3 py-1 text-right">mark</th>
          <th className="px-3 py-1 text-right">value</th>
          <th className="px-3 py-1 text-right">p&amp;l</th>
          <th className="px-3 py-1 text-right">stop %</th>
          <th className="px-3 py-1 text-right">take %</th>
          <th className="px-3 py-1 text-right">since</th>
          <th className="px-3 py-1" />
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => (
          <PositionRow key={p.symbol} position={p} mark={live[p.symbol] ?? p.mid} />
        ))}
      </tbody>
    </table>
  );
}

function PositionRow({ position, mark }: { position: BotPosition; mark: number | null }) {
  const qc = useQueryClient();
  const [sl, setSl] = useState(levelPct(position.avgEntry, position.stopPrice, -1));
  const [tp, setTp] = useState(levelPct(position.avgEntry, position.tpPrice, 1));
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['trade-account'] });
  };

  const levels = useMutation({
    mutationFn: () =>
      api.tradeLevels(position.symbol, {
        sl_pct: sl === '' ? null : Number(sl),
        tp_pct: tp === '' ? null : Number(tp),
      }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => setError(orderError(e)),
  });

  const close = useMutation({
    mutationFn: () => api.tradeOrder({ symbol: position.symbol, side: 'sell', pct: 100 }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => setError(orderError(e)),
  });

  const value = mark === null ? null : position.qty * mark;
  const pnl = mark === null ? null : (mark - position.avgEntry) * position.qty;
  const pnlPct = mark === null ? null : ((mark - position.avgEntry) / position.avgEntry) * 100;

  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-3 py-1">{shortSymbol(position.symbol)}</td>
      <td className="tnum px-3 py-1 text-right">{position.qty.toFixed(6)}</td>
      <td className="tnum px-3 py-1 text-right">{price(position.avgEntry)}</td>
      <td className="tnum px-3 py-1 text-right" data-testid={`mark-${position.symbol}`}>
        {price(mark)}
      </td>
      <td className="tnum px-3 py-1 text-right">{usd(value)}</td>
      <td className={`tnum px-3 py-1 text-right ${signClass(pnl)}`} data-testid={`pnl-${position.symbol}`}>
        {usd(pnl)}
        {pnlPct === null ? '' : ` (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`}
      </td>
      <td className="px-3 py-1 text-right">
        <input
          className={FIELD}
          value={sl}
          aria-label={`stop percent for ${position.symbol}`}
          placeholder="—"
          onChange={(e) => setSl(e.target.value)}
        />
      </td>
      <td className="px-3 py-1 text-right">
        <input
          className={FIELD}
          value={tp}
          aria-label={`take profit percent for ${position.symbol}`}
          placeholder="—"
          onChange={(e) => setTp(e.target.value)}
        />
      </td>
      <td className="tnum px-3 py-1 text-right text-muted">{dateTime(position.openedTs)}</td>
      <td className="px-3 py-1 text-right">
        <span className="flex justify-end gap-1">
          <Btn disabled={levels.isPending} onClick={() => levels.mutate()} title="save SL/TP">
            save
          </Btn>
          <Btn tone="danger" disabled={close.isPending} onClick={() => close.mutate()}>
            close
          </Btn>
        </span>
        {error && <span className="block text-[10px] text-red">{error}</span>}
      </td>
    </tr>
  );
}

export function TradeHistory({ fills }: { fills: TradeFill[] }) {
  if (fills.length === 0) return <Empty>no trades yet</Empty>;
  return (
    <table className="w-full text-xs">
      <thead className="text-[10px] uppercase tracking-wider text-muted">
        <tr className="border-b border-line">
          <th className="px-3 py-1 text-left">when</th>
          <th className="px-3 py-1 text-left">side</th>
          <th className="px-3 py-1 text-left">symbol</th>
          <th className="px-3 py-1 text-right">qty</th>
          <th className="px-3 py-1 text-right">price</th>
          <th className="px-3 py-1 text-right">notional</th>
          <th className="px-3 py-1 text-right">fee+slip</th>
        </tr>
      </thead>
      <tbody>
        {fills.map((f) => {
          const reason = fillReason(f);
          return (
            <tr key={f.id} className="border-b border-line last:border-0">
              <td className="tnum px-3 py-1 text-muted">{dateTime(f.ts)}</td>
              <td className="px-3 py-1">
                <span
                  className={`border px-1 text-[10px] uppercase ${
                    reason === 'sl'
                      ? 'border-red text-red'
                      : reason === 'tp'
                        ? 'border-green text-green'
                        : f.side === 'buy'
                          ? 'border-green text-green'
                          : 'border-amber text-amber'
                  }`}
                >
                  {reason === 'trade' ? f.side : `${f.side} · ${reason}`}
                </span>
              </td>
              <td className="px-3 py-1">{shortSymbol(f.symbol)}</td>
              <td className="tnum px-3 py-1 text-right">{f.qty.toFixed(6)}</td>
              <td className="tnum px-3 py-1 text-right">{price(f.price)}</td>
              <td className="tnum px-3 py-1 text-right">{usd(f.qty * f.price)}</td>
              <td className="tnum px-3 py-1 text-right text-muted">{usd(f.fee + f.slip)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
