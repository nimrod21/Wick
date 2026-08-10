'use client';

/**
 * TRADE — Luka as a trader (IMPL-4).
 *
 * Left: the selected symbol's chart carrying YOUR fills as full markers plus
 * BOT GHOSTS (tiny, dim, hover names the bot) that can be switched off.
 * Right: order ticket + account box. Below: open positions with live P&L and
 * editable SL/TP, then the full fill history.
 *
 * Everything runs on the same paper engine as the bots — the human account is
 * just a `bots` row with `kind:'human'`, so the SL/TP protector, equity
 * snapshots and the model scoreboard need no special case. "You vs bots" reads
 * the existing `/api/stats/models` scoreboard, where manual orders show up as
 * provider `human` because each filled order writes a normal decision row.
 */

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fillReason, TIMEFRAMES, type Tf } from '@/lib/api';
import { useLive, useLiveTicks } from '@/lib/sse';
import type { TradeMarker } from '@/components/charts/CandleChart';
import { WatchlistPanel } from '@/components/dashboard/WatchlistPanel';
import { AccountBox, OrderTicket } from '@/components/trade/OrderTicket';
import { OpenPositions, TradeHistory } from '@/components/trade/Positions';
import { Empty, Panel, PixelTitle } from '@/components/ui';

const CandleChart = dynamic(() => import('@/components/charts/CandleChart').then((m) => m.CandleChart), {
  ssr: false,
  loading: () => <div className="h-[360px]" />,
});

export default function TradePage() {
  const qc = useQueryClient();
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [tf, setTf] = useState<Tf>('1h');
  const [ghosts, setGhosts] = useState(true);
  // Batched (see useLiveTicks): a 50-symbol watchlist pushes ~100 ticks/s.
  // Open positions price off this; the watchlist panel shares the same feed.
  const ticks = useLiveTicks();

  const candles = useQuery({ queryKey: ['candles', symbol, tf], queryFn: () => api.candles(symbol, tf, 400) });
  const account = useQuery({
    queryKey: ['trade-account'],
    queryFn: () => api.tradeAccount(300),
    refetchInterval: 30_000,
  });
  const bots = useQuery({ queryKey: ['bots'], queryFn: api.bots, refetchInterval: 60_000 });

  // Ghost markers come from the bots' own fill reader — no new endpoint.
  const botFills = useQueries({
    queries: (bots.data ?? []).map((b) => ({
      queryKey: ['bot-fills', b.id],
      queryFn: () => api.fills(b.id, 300),
      refetchInterval: 60_000,
    })),
  });
  const ghostSig = botFills.map((q) => `${q.data?.length ?? 0}:${q.dataUpdatedAt}`).join('|');

  useLive('fill', (e) => {
    if (e.botId === account.data?.botId) void qc.invalidateQueries({ queryKey: ['trade-account'] });
  });
  useLive('candle', (e) => {
    if (e.symbol === symbol && e.tf === tf && e.closed) {
      void qc.invalidateQueries({ queryKey: ['candles', symbol, tf] });
    }
  });

  const markers = useMemo<TradeMarker[]>(() => {
    const mine: TradeMarker[] = (account.data?.fills ?? [])
      .filter((f) => f.symbol === symbol)
      .map((f) => ({ ts: f.ts, side: f.side, reason: fillReason(f), label: `you · ${f.side}` }));
    if (!ghosts) return mine;
    const theirs: TradeMarker[] = [];
    (bots.data ?? []).forEach((b, i) => {
      for (const f of botFills[i]?.data ?? []) {
        if (f.symbol !== symbol) continue;
        theirs.push({
          ts: f.ts,
          side: f.side,
          reason: 'trade',
          ghost: true,
          label: `${b.name} · ${f.side} ${f.qty.toFixed(4)}`,
        });
      }
    });
    return [...mine, ...theirs];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.data?.fills, bots.data, ghostSig, ghosts, symbol]);

  const priceLines = useMemo(() => {
    const p = account.data?.positions.find((x) => x.symbol === symbol);
    if (!p) return [];
    const lines: Array<{ price: number; title: string; tone: 'stop' | 'tp' }> = [];
    if (p.stopPrice !== null) lines.push({ price: p.stopPrice, title: 'SL', tone: 'stop' });
    if (p.tpPrice !== null) lines.push({ price: p.tpPrice, title: 'TP', tone: 'tp' });
    return lines;
  }, [account.data?.positions, symbol]);

  const ghostCount = markers.filter((m) => m.ghost).length;

  return (
    <div className="space-y-4">
      <PixelTitle className="text-green">TRADE</PixelTitle>

      {/* The dashboard's picker, verbatim (compact variant): one watchlist
          component for the whole app, one batched tick subscription. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <WatchlistPanel symbol={symbol} onSelectSymbol={setSymbol} variant="compact" />
        {/* items-start: columns hug their content — the chart panel must not
            stretch to the ticket column's height (it grew whenever the ticket
            showed a hint line, which read as the chart "moving"). */}
        <div className="grid min-w-0 flex-1 items-start gap-4 lg:grid-cols-[2fr_1fr]">
        <Panel
          title={`${symbol} — ${tf}`}
          right={
            <span className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setGhosts((g) => !g)}
                title="bot entries/exits as tiny dim arrows — hover names the bot"
                className={`border px-1 text-[10px] uppercase ${
                  ghosts ? 'border-cyan text-cyan' : 'border-line text-muted hover:text-fg'
                }`}
              >
                ghosts {ghosts ? `on (${ghostCount})` : 'off'}
              </button>
              <span className="flex gap-1">
                {TIMEFRAMES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTf(t)}
                    className={`px-1 text-[10px] ${t === tf ? 'text-cyan' : 'text-muted hover:text-fg'}`}
                  >
                    {t}
                  </button>
                ))}
              </span>
            </span>
          }
          bodyClassName="p-0"
        >
          {(candles.data?.length ?? 0) === 0 ? (
            <Empty>no candles for {symbol} {tf}</Empty>
          ) : (
            <CandleChart
              candles={candles.data!}
              symbol={symbol}
              tf={tf}
              markers={markers}
              priceLines={priceLines}
              height={380}
            />
          )}
        </Panel>

        <div className="space-y-4">
          <Panel title="Order ticket">
            <OrderTicket symbol={symbol} account={account.data} />
          </Panel>
          <Panel title={`Account — ${account.data?.name ?? 'you'}`}>
            <AccountBox account={account.data} />
          </Panel>
        </div>
        </div>
      </div>

      <Panel title="Open positions" bodyClassName="p-0">
        {account.isError ? (
          <Empty>account unavailable — {String((account.error as Error).message)}</Empty>
        ) : (
          <OpenPositions
            positions={account.data?.positions ?? []}
            live={Object.fromEntries(Object.entries(ticks).map(([sym, t]) => [sym, t.price]))}
          />
        )}
      </Panel>

      <Panel title="History" bodyClassName="max-h-[420px] overflow-y-auto p-0">
        <TradeHistory fills={account.data?.fills ?? []} />
      </Panel>
    </div>
  );
}
