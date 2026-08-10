'use client';

/**
 * Intel · News — the full headline feed behind the `news_sentiment` /
 * `news_burst` indicators.
 *
 * Sentiment is the lexicon score in [-1,1] and is NULLABLE: null means the
 * headline contained no sentiment word at all. That is rendered gray ("no
 * read"), never as a zero — a missing opinion is not a neutral one.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { Empty, Panel } from '@/components/ui';
import { dateTime } from '@/lib/format';

function SentimentBadge({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <span
        className="inline-block border border-line px-1 text-[10px] uppercase text-muted"
        title="no sentiment word in this headline — no read"
      >
        no read
      </span>
    );
  }
  const cls =
    score > 0.05 ? 'border-green text-green' : score < -0.05 ? 'border-red text-red' : 'border-line text-muted';
  return (
    <span className={`tnum inline-block border px-1 text-[10px] ${cls}`} title="lexicon sentiment (-1..+1)">
      {score > 0 ? '+' : ''}
      {score.toFixed(2)}
    </span>
  );
}

export function NewsTab() {
  const qc = useQueryClient();
  const [asset, setAsset] = useState('');
  const [source, setSource] = useState('');

  const news = useQuery({
    queryKey: ['intel-news', asset, source],
    queryFn: () => api.news({ asset: asset || undefined, source: source || undefined }),
    refetchInterval: 120_000,
  });

  useLive('news', () => {
    void qc.invalidateQueries({ queryKey: ['intel-news'] });
  });

  const items = news.data?.items ?? [];

  return (
    <Panel
      title={`News — ${items.length} headline${items.length === 1 ? '' : 's'}`}
      right={
        <div className="flex items-center gap-2">
          <select
            className="py-0.5 text-[11px]"
            value={asset}
            onChange={(e) => setAsset(e.target.value)}
            aria-label="filter by asset"
          >
            <option value="">all assets</option>
            {(news.data?.assets ?? []).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select
            className="py-0.5 text-[11px]"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            aria-label="filter by source"
          >
            <option value="">all sources</option>
            {(news.data?.sources ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      }
      bodyClassName="max-h-[640px] overflow-y-auto p-0"
    >
      {news.isError ? (
        <Empty>news unavailable — {String((news.error as Error).message)}</Empty>
      ) : items.length === 0 ? (
        <Empty>{news.isLoading ? 'loading…' : 'no headlines match these filters'}</Empty>
      ) : (
        <ul>
          {items.map((n) => (
            <li key={n.id} className="flex items-start gap-3 border-b border-line px-3 py-2 text-xs last:border-0">
              <span className="tnum w-24 shrink-0 text-muted">{dateTime(n.ts)}</span>
              <span className="w-24 shrink-0 truncate uppercase text-muted">{n.source}</span>
              <a
                href={n.url}
                target="_blank"
                rel="noreferrer noopener"
                className="min-w-0 flex-1 hover:text-cyan"
              >
                {n.title}
              </a>
              <span className="flex shrink-0 items-center gap-1">
                {n.assets.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAsset(a)}
                    className="border border-line px-1 text-[10px] text-cyan hover:border-cyan"
                    title={`filter by ${a}`}
                  >
                    {a}
                  </button>
                ))}
                <SentimentBadge score={n.sentiment} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
