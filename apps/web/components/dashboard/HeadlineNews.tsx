'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface NewsItem {
  id: number;
  ts: number;
  source: string;
  title?: string;
  url?: string;
  summary?: string | null;
  tickers?: string[];
  sentiment?: number | null;
}

interface NewsResponse {
  events: NewsItem[];
}

const RECENCY_WINDOW_SEC = 6 * 3600;

function relTime(tsSec: number, nowMs: number): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000 - tsSec));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}

function sentimentLabel(s: number): string {
  const sign = s > 0 ? '+' : '';
  return `${sign}${s.toFixed(2)}`;
}

function sentimentCls(s: number): string {
  if (s > 0) return 'text-neon-green border-neon-green';
  if (s < 0) return 'text-neon-red border-neon-red';
  return 'text-text-dim border-border-dim';
}

function score(item: NewsItem, nowSec: number): number {
  const s = item.sentiment;
  if (s === null || s === undefined || !Number.isFinite(s)) return 0;
  const recency = Math.max(0, 1 - (nowSec - item.ts) / RECENCY_WINDOW_SEC);
  return Math.abs(s) * recency;
}

export function HeadlineNews() {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const query = useQuery<NewsResponse>({
    queryKey: ['headline-news'],
    queryFn: () => api.get<NewsResponse>('/api/news?limit=20'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const top = useMemo<NewsItem[]>(() => {
    const items = query.data?.events ?? [];
    const nowSec = Math.floor(now / 1000);
    const scored = items.map((it) => ({ it, s: score(it, nowSec) }));
    scored.sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s;
      return b.it.ts - a.it.ts;
    });
    return scored.slice(0, 5).map((x) => x.it);
  }, [query.data, now]);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="pixel-font text-[10px] text-text-secondary uppercase tracking-wider">
        HEADLINE NEWS
      </h3>
      {query.isLoading ? (
        <div className="vt-font text-sm text-text-dim">LOADING…</div>
      ) : query.isError ? (
        <div className="vt-font text-sm text-neon-red">
          FAILED: {(query.error as Error).message}
        </div>
      ) : top.length === 0 ? (
        <div className="vt-font text-sm text-text-dim">No news yet.</div>
      ) : (
        <div className="flex flex-col">
          {top.map((ev) => {
            const hasSent =
              ev.sentiment !== null &&
              ev.sentiment !== undefined &&
              Number.isFinite(ev.sentiment);
            const sentVal = ev.sentiment ?? 0;
            const content = (
              <>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="pixel-font text-[8px] text-neon-cyan uppercase tracking-wider truncate max-w-[100px]">
                    {ev.source}
                  </span>
                  {hasSent ? (
                    <span
                      className={`vt-font text-xs px-1 border ${sentimentCls(sentVal)}`}
                    >
                      {sentimentLabel(sentVal)}
                    </span>
                  ) : null}
                  <span className="vt-font text-[11px] text-text-dim ml-auto">
                    {relTime(ev.ts, now)}
                  </span>
                </div>
                <div
                  className="vt-font text-sm text-text-primary leading-snug"
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {ev.title || '(untitled)'}
                </div>
              </>
            );
            return (
              <div
                key={ev.id}
                className="flex flex-col gap-1 py-1.5 border-b border-border-dim last:border-b-0"
              >
                {ev.url ? (
                  <a
                    href={ev.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex flex-col gap-1 hover:opacity-80"
                  >
                    {content}
                  </a>
                ) : (
                  content
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default HeadlineNews;
