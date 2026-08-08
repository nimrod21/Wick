'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type MarketSymbol } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { Panel, VoteDot, Empty } from '@/components/ui';
import { pct, price, shortSymbol } from '@/lib/format';

interface Live {
  price: number;
  dir: 'up' | 'down';
  seq: number;
}

export function MarketStrip() {
  const { data, isError } = useQuery({
    queryKey: ['market-summary'],
    queryFn: api.summary,
    refetchInterval: 60_000,
  });
  const [live, setLive] = useState<Record<string, Live>>({});
  const lastRef = useRef<Record<string, number>>({});

  useLive('tick', (e) => {
    const prev = lastRef.current[e.symbol];
    lastRef.current[e.symbol] = e.price;
    if (prev === undefined || prev === e.price) {
      setLive((s) => ({ ...s, [e.symbol]: { price: e.price, dir: s[e.symbol]?.dir ?? 'up', seq: (s[e.symbol]?.seq ?? 0) + 1 } }));
      return;
    }
    setLive((s) => ({
      ...s,
      [e.symbol]: { price: e.price, dir: e.price > prev ? 'up' : 'down', seq: (s[e.symbol]?.seq ?? 0) + 1 },
    }));
  });

  const symbols = data?.symbols ?? [];

  return (
    <Panel
      title="Market"
      right={
        <span className="text-[10px] uppercase tracking-wider text-muted">
          {data ? (data.warm ? 'warm' : 'warming…') : ''}
        </span>
      }
      bodyClassName="grid grid-cols-2 gap-px bg-line sm:grid-cols-4 lg:grid-cols-7"
    >
      {isError && <Empty>market summary unavailable</Empty>}
      {symbols.map((s) => (
        <Ticker key={s.symbol} symbol={s} live={live[s.symbol]} />
      ))}
      {!isError && symbols.length === 0 && <Empty>no symbols</Empty>}
    </Panel>
  );
}

function Ticker({ symbol, live }: { symbol: MarketSymbol; live: Live | undefined }) {
  const flashRef = useRef<HTMLDivElement>(null);
  const seenSeq = useRef(0);

  useEffect(() => {
    if (!live || live.seq === seenSeq.current) return;
    seenSeq.current = live.seq;
    const el = flashRef.current;
    if (!el) return;
    const cls = live.dir === 'up' ? 'flash-up' : 'flash-down';
    el.classList.remove('flash-up', 'flash-down');
    // force reflow so the animation restarts on consecutive ticks
    void el.offsetWidth;
    el.classList.add(cls);
  }, [live]);

  const shown = live?.price ?? symbol.lastPrice;
  const votes = Object.entries(symbol.votes);

  return (
    <div ref={flashRef} className="bg-panel px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted">{shortSymbol(symbol.symbol)}</span>
        <span
          className={`tnum text-[11px] ${
            symbol.changePct24h === null ? 'text-muted' : symbol.changePct24h >= 0 ? 'text-green' : 'text-red'
          }`}
        >
          {pct(symbol.changePct24h, 2)}
        </span>
      </div>
      <div className="tnum text-sm">{price(shown)}</div>
      <div className="mt-1 flex gap-1" title={votes.map(([k, v]) => `${k}: ${v ?? 'n/a'}`).join('\n')}>
        {votes.map(([name, vote]) => (
          <VoteDot key={name} vote={vote} />
        ))}
      </div>
    </div>
  );
}
