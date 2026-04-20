'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { WhaleTxEvent } from '../whales/TxDetailDrawer';

interface EventsResponse {
  events: WhaleTxEvent[];
}

const DAY_SECONDS = 24 * 60 * 60;
const MIN_USD = 100_000;

const CHAIN_COLOR: Record<WhaleTxEvent['chain'], string> = {
  eth: 'text-neon-cyan border-neon-cyan',
  sol: 'text-neon-purple border-neon-purple',
  btc: 'text-neon-amber border-neon-amber',
};

function shorten(addr: string): string {
  if (!addr) return '';
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function relTime(tsSec: number, nowMs: number): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000 - tsSec));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}

export function TopWhaleMovers() {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const query = useQuery<EventsResponse>({
    queryKey: ['top-whale-movers'],
    queryFn: () => api.get<EventsResponse>('/api/whales/events?limit=100'),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const top = useMemo<WhaleTxEvent[]>(() => {
    const events = query.data?.events ?? [];
    const cutoff = Math.floor(now / 1000) - DAY_SECONDS;
    return events
      .filter((e) => e.ts >= cutoff && (e.usdValue ?? 0) >= MIN_USD)
      .slice()
      .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))
      .slice(0, 5);
  }, [query.data, now]);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="pixel-font text-[10px] text-text-secondary uppercase tracking-wider">
        TOP WHALE MOVERS (24H)
      </h3>
      {query.isLoading ? (
        <div className="vt-font text-sm text-text-dim">LOADING…</div>
      ) : query.isError ? (
        <div className="vt-font text-sm text-neon-red">
          FAILED: {(query.error as Error).message}
        </div>
      ) : top.length === 0 ? (
        <div className="vt-font text-sm text-text-dim">No whale activity in last 24h.</div>
      ) : (
        <div className="flex flex-col">
          {top.map((ev) => {
            const isOut = ev.direction === 'out';
            // direction='in' = whale received (withdrawal from CEX = bullish ↑)
            // direction='out' = whale sent (deposit to CEX = bearish ↓)
            const arrow = isOut ? '↓' : '↑';
            const arrowCls = isOut ? 'text-neon-red' : 'text-neon-green';
            const chainCls = CHAIN_COLOR[ev.chain] ?? 'text-text-secondary border-border-dim';
            const fromLabel = isOut ? ev.label || shorten(ev.address) : shorten(ev.counterpart);
            const toLabel = isOut ? shorten(ev.counterpart) : ev.label || shorten(ev.address);
            return (
              <div
                key={ev.id}
                className="flex items-center gap-2 py-1 border-b border-border-dim last:border-b-0"
              >
                <span
                  className={`pixel-font text-[9px] px-1.5 py-0.5 border-2 uppercase ${chainCls}`}
                >
                  {ev.chain}
                </span>
                <span className="vt-font text-sm text-neon-magenta glow shrink-0 w-16">
                  {formatUsd(ev.usdValue)}
                </span>
                <span className={`pixel-font text-[12px] ${arrowCls} shrink-0`}>{arrow}</span>
                <span
                  className="vt-font text-xs text-text-secondary truncate flex-1 min-w-0"
                  title={`${ev.address} → ${ev.counterpart}`}
                >
                  {fromLabel} → {toLabel}
                </span>
                <span className="vt-font text-[11px] text-text-dim shrink-0">
                  {relTime(ev.ts, now)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default TopWhaleMovers;
