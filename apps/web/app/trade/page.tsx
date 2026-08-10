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
import { api, fillReason, TIMEFRAMES, type ModelStat, type Tf } from '@/lib/api';
import { useLive } from '@/lib/sse';
import type { TradeMarker } from '@/components/charts/CandleChart';
import { AccountBox, OrderTicket } from '@/components/trade/OrderTicket';
import { OpenPositions, TradeHistory } from '@/components/trade/Positions';
import { Empty, Panel, PixelTitle, Stat } from '@/components/ui';
import { num, pct, shortSymbol } from '@/lib/format';

const CandleChart = dynamic(() => import('@/components/charts/CandleChart').then((m) => m.CandleChart), {
  ssr: false,
  loading: () => <div className="h-[360px]" />,
});

export default function TradePage() {
  const qc = useQueryClient();
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [tf, setTf] = useState<Tf>('1h');
  const [ghosts, setGhosts] = useState(true);
  const [live, setLive] = useState<Record<string, number>>({});

  const summary = useQuery({ queryKey: ['market-summary'], queryFn: api.summary, refetchInterval: 60_000 });
  const candles = useQuery({ queryKey: ['candles', symbol, tf], queryFn: () => api.candles(symbol, tf, 400) });
  const account = useQuery({
    queryKey: ['trade-account'],
    queryFn: () => api.tradeAccount(300),
    refetchInterval: 30_000,
  });
  const bots = useQuery({ queryKey: ['bots'], queryFn: api.bots, refetchInterval: 60_000 });
  const models = useQuery({ queryKey: ['models'], queryFn: api.models, refetchInterval: 120_000 });

  // Ghost markers come from the bots' own fill reader — no new endpoint.
  const botFills = useQueries({
    queries: (bots.data ?? []).map((b) => ({
      queryKey: ['bot-fills', b.id],
      queryFn: () => api.fills(b.id, 300),
      refetchInterval: 60_000,
    })),
  });
  const ghostSig = botFills.map((q) => `${q.data?.length ?? 0}:${q.dataUpdatedAt}`).join('|');

  useLive('tick', (e) => {
    setLive((s) => (s[e.symbol] === e.price ? s : { ...s, [e.symbol]: e.price }));
  });
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
      <div className="flex flex-wrap items-baseline gap-3">
        <PixelTitle className="text-green">TRADE</PixelTitle>
        <YouVsBots models={models.data} />
      </div>

      <div className="flex flex-wrap items-center gap-2 border border-line p-2">
        {(summary.data?.symbols ?? []).map((s) => (
          <button
            key={s.symbol}
            type="button"
            onClick={() => setSymbol(s.symbol)}
            className={`border px-2 py-0.5 text-[11px] ${
              s.symbol === symbol ? 'border-cyan text-cyan' : 'border-line text-muted hover:text-fg'
            }`}
          >
            {shortSymbol(s.symbol)}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
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

      <Panel title="Open positions" bodyClassName="p-0">
        {account.isError ? (
          <Empty>account unavailable — {String((account.error as Error).message)}</Empty>
        ) : (
          <OpenPositions positions={account.data?.positions ?? []} live={live} />
        )}
      </Panel>

      <Panel title="History" bodyClassName="max-h-[420px] overflow-y-auto p-0">
        <TradeHistory fills={account.data?.fills ?? []} />
      </Panel>
    </div>
  );
}

/**
 * You vs bots — the same 4h scoreboard the bots are judged on. Your manual
 * orders are decisions with provider `human`, so they land here for free once
 * the evaluator has scored them (4h after the order).
 */
function YouVsBots({ models }: { models: ModelStat[] | undefined }) {
  if (!models) return null;
  const you = models.find((m) => m.provider === 'human');
  // `code` is the SL/TP protector's own row — deterministic, nobody's judgement.
  const bots = models.filter((m) => m.provider !== 'human' && m.provider !== 'code');

  const wins = bots.reduce((a, m) => a + m.wins, 0);
  const losses = bots.reduce((a, m) => a + m.losses, 0);
  const scored = bots.filter((m) => m.meanScore !== null && m.evaluated > 0);
  const evaluated = scored.reduce((a, m) => a + m.evaluated, 0);
  const botMean =
    evaluated > 0
      ? scored.reduce((a, m) => a + (m.meanScore as number) * m.evaluated, 0) / evaluated
      : null;

  return (
    <span className="flex flex-wrap items-center gap-4 text-[11px]">
      <Side
        label="you"
        decisions={you?.decisions ?? 0}
        winRate={you?.winRate ?? null}
        meanScore={you?.meanScore ?? null}
      />
      <span className="text-muted">vs</span>
      <Side
        label="bots"
        decisions={bots.reduce((a, m) => a + m.decisions, 0)}
        winRate={wins + losses > 0 ? wins / (wins + losses) : null}
        meanScore={botMean}
      />
    </span>
  );
}

function Side({
  label,
  decisions,
  winRate,
  meanScore,
}: {
  label: string;
  decisions: number;
  winRate: number | null;
  meanScore: number | null;
}) {
  return (
    <span className="flex items-center gap-3">
      <Stat
        label={label}
        value={
          <span className={meanScore === null ? 'text-muted' : meanScore >= 0 ? 'text-green' : 'text-red'}>
            {winRate === null ? '—' : pct(winRate * 100, 0)} win · score {num(meanScore, 2)}
          </span>
        }
        sub={`${decisions} decision${decisions === 1 ? '' : 's'}`}
      />
    </span>
  );
}
