'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';
import { TxDetailDrawer, type WhaleTxEvent } from './TxDetailDrawer';

type Chain = 'eth' | 'sol' | 'btc';

interface EventsResponse {
  events: WhaleTxEvent[];
}

interface LiveTxStreamProps {
  chain: Chain;
}

type UsdFilter = 0 | 100_000 | 500_000 | 1_000_000 | 5_000_000;

const FILTER_OPTIONS: ReadonlyArray<{ value: UsdFilter; label: string }> = [
  { value: 0, label: 'ALL' },
  { value: 100_000, label: '>$100K' },
  { value: 500_000, label: '>$500K' },
  { value: 1_000_000, label: '>$1M' },
  { value: 5_000_000, label: '>$5M' },
];

function explorerUrl(chain: Chain, txHash: string): string {
  switch (chain) {
    case 'eth':
      return `https://etherscan.io/tx/${txHash}`;
    case 'sol':
      return `https://solscan.io/tx/${txHash}`;
    case 'btc':
      return `https://blockstream.info/tx/${txHash}`;
  }
}

function shortenAddress(addr: string): string {
  if (!addr) return '';
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 5)}…${addr.slice(-4)}`;
}

function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toFixed(3);
  return n.toFixed(6);
}

function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, Math.floor((now - ts) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function isWhaleTx(e: unknown): e is WhaleTxEvent {
  if (!e || typeof e !== 'object') return false;
  const o = e as { kind?: unknown; txHash?: unknown; chain?: unknown };
  return o.kind === 'whale_tx' && typeof o.txHash === 'string' && typeof o.chain === 'string';
}

export function LiveTxStream({ chain }: LiveTxStreamProps) {
  const [filter, setFilter] = useState<UsdFilter>(0);
  const [liveEvents, setLiveEvents] = useState<WhaleTxEvent[]>([]);
  const [selected, setSelected] = useState<WhaleTxEvent | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  const initialQuery = useQuery<EventsResponse>({
    queryKey: ['whale-events', chain],
    queryFn: () =>
      api.get<EventsResponse>(`/api/whales/events?chain=${chain}&limit=50`),
    staleTime: 10_000,
  });

  const { connected, lastEvent } = useEventStream(['whale_tx']);

  // Reset live buffer whenever chain changes.
  useEffect(() => {
    setLiveEvents([]);
  }, [chain]);

  useEffect(() => {
    if (!lastEvent || !isWhaleTx(lastEvent)) return;
    if (lastEvent.chain !== chain) return;
    setLiveEvents((prev) => {
      if (prev.some((e) => e.id === lastEvent.id)) return prev;
      return [lastEvent, ...prev].slice(0, 200);
    });
  }, [lastEvent, chain]);

  // Tick a clock once every 15s for relative time rendering.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const merged = useMemo<WhaleTxEvent[]>(() => {
    const initial = initialQuery.data?.events ?? [];
    const seen = new Set<string | number>();
    const out: WhaleTxEvent[] = [];
    for (const ev of [...liveEvents, ...initial]) {
      if (ev.chain !== chain) continue;
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      out.push(ev);
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }, [initialQuery.data, liveEvents, chain]);

  const filtered = useMemo<WhaleTxEvent[]>(() => {
    if (filter === 0) return merged;
    return merged.filter((e) => (e.usdValue ?? 0) >= filter);
  }, [merged, filter]);

  return (
    <div className="flex flex-col border border-border-dim bg-bg-terminal min-h-0 overflow-hidden">
      {/* Header with filters + live indicator */}
      <div className="flex items-center justify-between gap-2 px-2 py-2 border-b border-border-dim shrink-0">
        <div className="flex items-center gap-1 flex-wrap">
          {FILTER_OPTIONS.map((opt) => {
            const active = filter === opt.value;
            const cls = active
              ? 'pixel-font text-[9px] px-2 py-1 border-2 bg-neon-magenta text-bg-void border-neon-magenta'
              : 'pixel-font text-[9px] px-2 py-1 border-2 text-text-secondary border-border-dim hover:border-neon-magenta hover:text-neon-magenta';
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setFilter(opt.value)}
                className={cls}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span
            className={`inline-block w-2 h-2 ${connected ? 'bg-neon-green' : 'bg-neon-red'} ${connected ? 'blink' : ''}`}
          />
          <span className="pixel-font text-[8px] text-text-secondary uppercase">
            {connected ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>
      </div>

      {/* Stream */}
      <div className="flex-1 overflow-y-auto">
        {initialQuery.isLoading ? (
          <div className="vt-font text-text-dim text-sm px-3 py-2">LOADING…</div>
        ) : filtered.length === 0 ? (
          <div className="vt-font text-text-dim text-sm px-3 py-2">
            NO TRANSACTIONS {filter > 0 ? `ABOVE ${formatUsd(filter)}` : ''}
          </div>
        ) : (
          filtered.map((ev) => {
            const isOut = ev.direction === 'out';
            const arrow = isOut ? '↘' : '↗';
            const arrowCls = isOut ? 'text-neon-red' : 'text-neon-green';
            return (
              <button
                key={ev.id}
                type="button"
                onClick={() => setSelected(ev)}
                className="w-full text-left flex items-center gap-3 px-3 py-2 border-b border-border-dim hover:bg-bg-elevated"
              >
                <span className={`pixel-font text-[14px] ${arrowCls} shrink-0`}>
                  {arrow}
                </span>
                <span className="flex flex-col min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span
                      className="vt-font text-[14px] text-neon-cyan truncate"
                      title={ev.address}
                    >
                      {ev.label || shortenAddress(ev.address)}
                    </span>
                    <span className="vt-font text-[13px] text-text-primary truncate">
                      {formatAmount(ev.amount)} {ev.token}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="vt-font text-[12px] text-text-secondary uppercase">
                      {isOut ? 'TO' : 'FROM'}
                    </span>
                    <a
                      href={explorerUrl(ev.chain, ev.txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="vt-font text-[12px] text-text-secondary hover:text-neon-magenta underline truncate"
                      title={ev.counterpart}
                    >
                      {shortenAddress(ev.counterpart)}
                    </a>
                  </span>
                </span>
                <span className="flex flex-col items-end shrink-0">
                  <span className="vt-font text-[15px] text-neon-magenta glow">
                    {formatUsd(ev.usdValue)}
                  </span>
                  <span className="vt-font text-[11px] text-text-dim">
                    {relativeTime(ev.ts, now)}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>

      <TxDetailDrawer event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

export default LiveTxStream;
