'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, TIMEFRAMES, type Tf } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { Empty, Panel, PixelTitle, Stat, VoteDot } from '@/components/ui';
import { num, pct, price, shortSymbol } from '@/lib/format';

const CandleChart = dynamic(() => import('@/components/charts/CandleChart').then((m) => m.CandleChart), {
  ssr: false,
  loading: () => <div className="h-[360px]" />,
});

export default function MarketPage() {
  const qc = useQueryClient();
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [tf, setTf] = useState<Tf>('1h');

  const summary = useQuery({ queryKey: ['market-summary'], queryFn: api.summary, refetchInterval: 60_000 });
  const candles = useQuery({ queryKey: ['candles', symbol, tf], queryFn: () => api.candles(symbol, tf, 400) });
  const indicators = useQuery({ queryKey: ['indicators', symbol], queryFn: () => api.indicators(symbol, '1h') });

  useLive('candle', (e) => {
    if (e.symbol === symbol && e.tf === tf && e.closed) {
      void qc.invalidateQueries({ queryKey: ['candles', symbol, tf] });
    }
  });
  useLive('indicator', (e) => {
    if (e.symbol === symbol) void qc.invalidateQueries({ queryKey: ['indicators', symbol] });
  });

  const row = summary.data?.symbols.find((s) => s.symbol === symbol);
  const inds = indicators.data?.indicators ?? [];
  const funding = inds.find((i) => i.name === 'funding');
  const fearGreed = inds.find((i) => i.name === 'fear_greed');
  const priced = inds.filter((i) => i.name !== 'funding' && i.name !== 'fear_greed');

  return (
    <div className="space-y-4">
      <PixelTitle className="text-green">MARKET</PixelTitle>

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
          }
          bodyClassName="p-0"
        >
          <div className="grid grid-cols-2 gap-2 border-b border-line p-3 sm:grid-cols-4">
            <Stat label="last" value={price(row?.lastPrice ?? null)} />
            <Stat
              label="24h"
              value={pct(row?.changePct24h ?? null)}
              valueClass={
                row?.changePct24h === undefined || row?.changePct24h === null
                  ? 'text-muted'
                  : row.changePct24h >= 0
                    ? 'text-green'
                    : 'text-red'
              }
            />
            <Stat
              label="funding"
              value={funding?.value === null || funding?.value === undefined ? '—' : `${(funding.value * 100).toFixed(4)}%`}
            />
            <Stat label="fear & greed" value={fearGreed?.value === null || fearGreed?.value === undefined ? '—' : fearGreed.value} />
          </div>
          {(candles.data?.length ?? 0) === 0 ? (
            <Empty>no candles for {symbol} {tf}</Empty>
          ) : (
            <CandleChart candles={candles.data!} symbol={symbol} tf={tf} height={360} />
          )}
        </Panel>

        <Panel title="Indicators (1h)" bodyClassName="p-0">
          {priced.length === 0 ? (
            <Empty>no indicator values yet</Empty>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {priced.map((i) => (
                  <tr key={i.name} className="border-b border-line last:border-0">
                    <td className="px-3 py-1">{i.name}</td>
                    <td className="tnum px-3 py-1 text-right">{num(i.value, 4)}</td>
                    <td className="px-3 py-1 text-right">
                      <span className="inline-flex items-center gap-1.5">
                        <VoteDot vote={i.vote} />
                        <span
                          className={
                            i.vote === 'bull' ? 'text-green' : i.vote === 'bear' ? 'text-red' : 'text-muted'
                          }
                        >
                          {i.vote ?? '—'}
                        </span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
