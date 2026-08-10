'use client';

/**
 * NEWS teaser (IMPL-5): the five freshest headlines with their asset tags,
 * linking into Intel / News for filters and the full feed.
 *
 * With an `asset` (IMPL-6C: the dashboard's selected symbol) it shows that
 * asset's tagged headlines — and falls back to the market feed when the
 * tagger has nothing for it, which is the normal case for the long tail of a
 * 50-symbol watchlist. The fallback says so rather than showing an empty box.
 *
 * Sentiment stays nullable here for the same reason it is on the Intel tab —
 * a headline with no sentiment word has no read, which is not the same as a
 * neutral one, so it renders as a dim dot rather than a zero.
 */

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { Empty, Panel } from '@/components/ui';
import { ago } from '@/lib/format';

const TOP_N = 9;

function sentimentClass(score: number | null): string {
  if (score === null) return 'bg-line';
  return score > 0.05 ? 'bg-green' : score < -0.05 ? 'bg-red' : 'bg-line';
}

export function NewsPanel({ asset }: { asset?: string }) {
  const qc = useQueryClient();
  const market = useQuery({
    queryKey: ['intel-news', 'dashboard'],
    queryFn: () => api.news({ limit: TOP_N }),
    refetchInterval: 120_000,
  });
  const tagged = useQuery({
    queryKey: ['intel-news', 'tagged', asset],
    queryFn: () => api.news({ asset, limit: TOP_N }),
    refetchInterval: 120_000,
    enabled: asset !== undefined,
  });

  useLive('news', () => {
    void qc.invalidateQueries({ queryKey: ['intel-news'] });
  });

  const news = asset !== undefined && (tagged.data?.items.length ?? 0) > 0 ? tagged : market;
  const items = news.data?.items ?? [];
  const untagged = asset !== undefined && tagged.isSuccess && tagged.data.items.length === 0;

  return (
    <Panel
      title={untagged ? `News — no ${asset} tags` : asset !== undefined ? `News — ${asset}` : 'News'}
      right={
        <Link href="/intel?tab=news" className="text-[10px] uppercase tracking-wider text-muted hover:text-cyan">
          full feed →
        </Link>
      }
      bodyClassName="p-0"
    >
      {news.isError ? (
        <Empty>news unavailable</Empty>
      ) : items.length === 0 ? (
        <Empty>{news.isLoading ? 'loading…' : 'no headlines yet'}</Empty>
      ) : (
        <ul>
          {items.map((n) => (
            <li key={n.id} className="flex items-start gap-2 border-b border-line px-3 py-1.5 text-xs last:border-0">
              <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 ${sentimentClass(n.sentiment)}`}
                title={n.sentiment === null ? 'no sentiment word — no read' : `sentiment ${n.sentiment.toFixed(2)}`}
                aria-hidden
              />
              <span className="tnum w-8 shrink-0 text-muted">{ago(n.ts)}</span>
              <a
                href={n.url}
                target="_blank"
                rel="noreferrer noopener"
                className="min-w-0 flex-1 line-clamp-2 hover:text-cyan"
                title={`${n.source} — ${n.title}`}
              >
                {n.title}
              </a>
              <span className="flex shrink-0 flex-wrap gap-1">
                {n.assets.slice(0, 2).map((a) => (
                  <span key={a} className="border border-line px-1 text-[10px] text-cyan">
                    {a}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
