'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEventStream } from '@/lib/sse';

type AnyEvent = {
  id?: number;
  kind: string;
  ts?: number;
  source?: string;
  assetId?: number;
  [k: string]: unknown;
};

type Filter = 'ALL' | 'WHALES' | 'NEWS' | 'IND' | 'PROB' | 'ALERT';

const MAX_ROWS = 200;

// Velocity-only default set. News moved to the HeadlineNews Digest widget;
// it's still reachable via the NEWS chip (or ALL) without changes here.
const DEFAULT_KINDS = new Set([
  'probability',
  'alert',
  'order_status',
  'whale_tx',
]);

// Kinds we subscribe to so the user can switch chips without reconnecting.
const TOPICS = [
  'trade_tick',
  'whale_tx',
  'news',
  'indicator',
  'probability',
  'alert',
  'order_status',
];

// Throttle trade_ticks: at most one tick per asset per this many ms.
const TRADE_TICK_MIN_INTERVAL_MS = 1000;

const KIND_COLOR: Record<string, string> = {
  whale_tx: 'text-neon-magenta',
  news: 'text-neon-cyan',
  indicator: 'text-neon-amber',
  probability: 'text-neon-purple',
  alert: 'text-neon-red',
  trade_tick: 'text-neon-green',
  order_status: 'text-neon-cyan',
};

const KIND_ICON: Record<string, string> = {
  whale_tx: '~',
  news: '#',
  indicator: '%',
  probability: '?',
  alert: '!',
  trade_tick: '*',
  order_status: '>',
};

function matches(filter: Filter, kind: string): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'WHALES') return kind === 'whale_tx';
  if (filter === 'NEWS') return kind === 'news';
  if (filter === 'IND') return kind === 'indicator';
  if (filter === 'PROB') return kind === 'probability';
  if (filter === 'ALERT') return kind === 'alert' || kind === 'order_status';
  return false;
}

function isInDefaultSet(filter: Filter, kind: string): boolean {
  // When no filter chip narrows the view (ALL), we still restrict the
  // stream to the velocity-only default set. Non-ALL chips explicitly
  // want a specific kind so we bypass the default filter for those.
  if (filter === 'ALL') return DEFAULT_KINDS.has(kind);
  return true;
}

function fmtCompactUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

function relTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function summarize(e: AnyEvent): string {
  switch (e.kind) {
    case 'whale_tx': {
      const token = typeof e.token === 'string' ? e.token : '';
      const dir = e.direction === 'out' ? '→exch' : e.direction === 'in' ? '←exch' : '';
      const usd = typeof e.usdValue === 'number' ? fmtCompactUsd(e.usdValue) : '';
      return `${token} ${dir} ${usd}`.trim();
    }
    case 'news': {
      const title = typeof e.title === 'string' ? e.title : '';
      return title.length > 80 ? `${title.slice(0, 77)}…` : title;
    }
    case 'indicator': {
      const name = typeof e.name === 'string' ? e.name : '';
      const value = typeof e.value === 'number' ? e.value.toFixed(2) : '';
      return `${name}=${value}`;
    }
    case 'probability': {
      const p = typeof e.bullishProb === 'number' ? Math.round(e.bullishProb * 100) : null;
      const h = typeof e.horizon === 'string' ? e.horizon : '';
      const asset = typeof e.assetId === 'number' ? `#${e.assetId}` : '';
      return `${asset} ${h} ${p !== null ? `${p}%` : ''}`.trim();
    }
    case 'alert': {
      const name = typeof e.ruleName === 'string' ? e.ruleName : 'rule';
      return `fired: ${name}`;
    }
    case 'trade_tick': {
      const asset = typeof e.assetId === 'number' ? `#${e.assetId}` : '';
      const price = typeof e.price === 'number' ? e.price.toFixed(2) : '';
      const side = typeof e.side === 'string' ? e.side.toUpperCase() : '';
      return `${asset} ${side} ${price}`.trim();
    }
    case 'order_status': {
      const status = typeof e.status === 'string' ? e.status.toUpperCase() : '';
      const asset = typeof e.assetId === 'number' ? `#${e.assetId}` : '';
      const side = typeof e.side === 'string' ? e.side.toUpperCase() : '';
      return `${asset} ${side} ${status}`.trim();
    }
    default:
      return JSON.stringify(e).slice(0, 80);
  }
}

export function EventFirehose() {
  const { lastEvent, connected } = useEventStream(TOPICS);
  const [rows, setRows] = useState<AnyEvent[]>([]);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [now, setNow] = useState<number>(() => Math.floor(Date.now() / 1000));
  const seenRef = useRef<Set<string>>(new Set());
  // Per-asset trade_tick throttle state. Keyed by assetId; value is the
  // last-accepted wall-clock timestamp in ms. A Map avoids the churn of
  // rewriting an object ref on every tick.
  const lastTradeTickMsRef = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!lastEvent || typeof lastEvent !== 'object') return;
    const e = lastEvent as AnyEvent;
    if (!e.kind || !TOPICS.includes(e.kind)) return;

    // Trade_tick throttle: drop any tick for an asset we've already
    // admitted within TRADE_TICK_MIN_INTERVAL_MS. Keeps the Firehose
    // readable even when BTC/ETH are ticking many times per second.
    if (e.kind === 'trade_tick' && typeof e.assetId === 'number') {
      const nowMs = Date.now();
      const last = lastTradeTickMsRef.current.get(e.assetId) ?? 0;
      if (nowMs - last < TRADE_TICK_MIN_INTERVAL_MS) return;
      lastTradeTickMsRef.current.set(e.assetId, nowMs);
    }

    const key = `${e.kind}:${e.id ?? Math.random()}:${e.ts ?? ''}`;
    if (seenRef.current.has(key)) return;
    seenRef.current.add(key);
    if (seenRef.current.size > MAX_ROWS * 2) {
      // Prune tracker periodically so it doesn't grow without bound.
      const keep = [...seenRef.current].slice(-MAX_ROWS);
      seenRef.current = new Set(keep);
    }
    setRows((prev) => {
      const next = [e, ...prev];
      return next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next;
    });
  }, [lastEvent]);

  const filtered = useMemo(
    () => rows.filter((r) => matches(filter, r.kind) && isInDefaultSet(filter, r.kind)),
    [rows, filter],
  );

  const filters: Filter[] = ['ALL', 'WHALES', 'NEWS', 'IND', 'PROB', 'ALERT'];

  return (
    <div className="bg-bg-terminal border-2 border-border-dim h-full flex flex-col">
      <div className="px-3 py-2 border-b border-border-dim flex items-center justify-between">
        <span className="pixel-font text-[10px] text-neon-magenta glow uppercase">Firehose</span>
        <span
          className={`pixel-font text-[8px] uppercase ${connected ? 'text-neon-green' : 'text-neon-red'}`}
        >
          {connected ? 'LIVE' : 'OFFLINE'}
        </span>
      </div>
      <div className="px-3 py-2 flex gap-1 flex-wrap border-b border-border-dim">
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`pixel-font text-[8px] px-2 py-1 border ${
              filter === f
                ? 'border-neon-cyan text-neon-cyan glow'
                : 'border-border-dim text-text-secondary hover:text-neon-cyan'
            }`}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="p-3 vt-font text-text-dim text-sm">
            Waiting for events… (scores, whale txs, news, alerts, indicators)
          </div>
        ) : (
          <ul className="divide-y divide-border-dim">
            {filtered.map((e, i) => {
              const color = KIND_COLOR[e.kind] ?? 'text-text-primary';
              const icon = KIND_ICON[e.kind] ?? '>';
              const ts = typeof e.ts === 'number' ? e.ts : now;
              return (
                <li
                  key={`${e.kind}-${e.id ?? i}-${ts}`}
                  className="px-3 py-2 grid grid-cols-[16px_90px_1fr_auto] items-center gap-3 hover:bg-bg-elevated"
                >
                  <span className={`pixel-font text-[10px] ${color} glow text-center`}>
                    {icon}
                  </span>
                  <span className={`pixel-font text-[8px] uppercase ${color} tracking-wider truncate`}>
                    {e.kind}
                  </span>
                  <span className="vt-font text-sm text-text-primary truncate">
                    {summarize(e)}
                  </span>
                  <span className="pixel-font text-[8px] text-text-dim text-right tabular-nums w-10 shrink-0">
                    {relTime(ts, now)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default EventFirehose;
