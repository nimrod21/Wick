'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEventStream } from '@/lib/sse';

type AnyEvent = {
  id?: number;
  kind: string;
  ts?: number;
  source?: string;
  [k: string]: unknown;
};

type Filter = 'ALL' | 'WHALES' | 'NEWS' | 'IND' | 'PROB' | 'ALERT';

const MAX_ROWS = 200;

const TOPICS = ['whale_tx', 'news', 'indicator', 'probability', 'alert'];

const KIND_COLOR: Record<string, string> = {
  whale_tx: 'text-neon-magenta',
  news: 'text-neon-cyan',
  indicator: 'text-neon-amber',
  probability: 'text-neon-purple',
  alert: 'text-neon-red',
};

const KIND_ICON: Record<string, string> = {
  whale_tx: '~',
  news: '#',
  indicator: '%',
  probability: '?',
  alert: '!',
};

function matches(filter: Filter, kind: string): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'WHALES') return kind === 'whale_tx';
  if (filter === 'NEWS') return kind === 'news';
  if (filter === 'IND') return kind === 'indicator';
  if (filter === 'PROB') return kind === 'probability';
  if (filter === 'ALERT') return kind === 'alert';
  return false;
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

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!lastEvent || typeof lastEvent !== 'object') return;
    const e = lastEvent as AnyEvent;
    if (!e.kind || !TOPICS.includes(e.kind)) return;
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

  const filtered = useMemo(() => rows.filter((r) => matches(filter, r.kind)), [rows, filter]);

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
