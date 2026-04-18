'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';
import {
  FilterSidebar,
  type NewsFilterValue,
} from '@/components/news/FilterSidebar';
import { NewsCard, type NewsEventLike } from '@/components/news/NewsCard';
import { NewsDrawer } from '@/components/news/NewsDrawer';

interface NewsResponse {
  events: NewsEventLike[];
}

function buildQuery(filter: NewsFilterValue): string {
  const params = new URLSearchParams();
  params.set('limit', '50');
  if (filter.tickers.length > 0) {
    params.set('tickers', filter.tickers.join(','));
  }
  if (filter.sources.length > 0) {
    params.set('sources', filter.sources.join(','));
  }
  const [minSent, maxSent] = filter.sentRange;
  if (minSent > -1) params.set('minSentiment', String(minSent));
  if (maxSent < 1) params.set('maxSentiment', String(maxSent));
  return params.toString();
}

function isNewsEvent(e: unknown): e is NewsEventLike {
  if (!e || typeof e !== 'object') return false;
  const o = e as { kind?: unknown; title?: unknown; url?: unknown };
  return (
    o.kind === 'news' &&
    typeof o.title === 'string' &&
    typeof o.url === 'string'
  );
}

function matchesFilter(e: NewsEventLike, f: NewsFilterValue): boolean {
  if (f.tickers.length > 0) {
    const t = e.tickers ?? [];
    const hit = f.tickers.some((x) => t.includes(x));
    if (!hit) return false;
  }
  if (f.sources.length > 0) {
    if (!f.sources.some((s) => e.source === s || e.source?.endsWith(`:${s}`))) {
      return false;
    }
  }
  const [min, max] = f.sentRange;
  if (min > -1 || max < 1) {
    const sent = e.sentiment;
    if (sent === null || sent === undefined) return false;
    if (sent < min || sent > max) return false;
  }
  return true;
}

export default function NewsPage() {
  const [filter, setFilter] = useState<NewsFilterValue>({
    tickers: [],
    sources: [],
    sentRange: [-1, 1],
  });
  const [liveEvents, setLiveEvents] = useState<NewsEventLike[]>([]);
  const [selected, setSelected] = useState<NewsEventLike | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  const queryString = useMemo(() => buildQuery(filter), [filter]);

  const initialQuery = useQuery<NewsResponse>({
    queryKey: ['news', queryString],
    queryFn: () => api.get<NewsResponse>(`/api/news?${queryString}`),
    staleTime: 15_000,
  });

  const { connected, lastEvent } = useEventStream(['news']);

  useEffect(() => {
    if (!lastEvent || !isNewsEvent(lastEvent)) return;
    setLiveEvents((prev) => {
      if (prev.some((e) => e.id === lastEvent.id)) return prev;
      return [lastEvent, ...prev].slice(0, 200);
    });
  }, [lastEvent]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Reset live buffer when filter changes — initial fetch replaces the view.
  useEffect(() => {
    setLiveEvents([]);
  }, [queryString]);

  const merged = useMemo<NewsEventLike[]>(() => {
    const initial = initialQuery.data?.events ?? [];
    const seen = new Set<number>();
    const out: NewsEventLike[] = [];
    for (const ev of [...liveEvents, ...initial]) {
      if (seen.has(ev.id)) continue;
      if (!matchesFilter(ev, filter)) continue;
      seen.add(ev.id);
      out.push(ev);
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }, [initialQuery.data, liveEvents, filter]);

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-8rem)]">
      <div className="flex items-center justify-between">
        <h1 className="pixel-font text-neon-amber glow text-xs">NEWS FEED</h1>
        <div className="flex items-center gap-1">
          <span
            className={`inline-block w-2 h-2 ${connected ? 'bg-neon-green' : 'bg-neon-red'} ${connected ? 'blink' : ''}`}
          />
          <span className="pixel-font text-[8px] text-text-secondary uppercase">
            {connected ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-[18rem_1fr] gap-3 flex-1 min-h-0">
        <FilterSidebar value={filter} onChange={setFilter} />

        <div className="flex flex-col gap-2 overflow-y-auto min-h-0 pr-1">
          {initialQuery.isLoading ? (
            <div className="vt-font text-text-dim text-sm px-2 py-4">
              LOADING…
            </div>
          ) : merged.length === 0 ? (
            <div className="vt-font text-text-dim text-sm px-2 py-4">
              NO NEWS MATCHING FILTERS
            </div>
          ) : (
            merged.map((ev) => (
              <NewsCard
                key={ev.id}
                event={ev}
                onOpen={setSelected}
                now={now}
              />
            ))
          )}
        </div>
      </div>

      <NewsDrawer event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
