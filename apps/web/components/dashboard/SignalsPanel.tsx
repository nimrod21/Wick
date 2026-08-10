'use client';

/**
 * SIGNALS NOW (IMPL-5) — the five loudest live votes across the whole board,
 * a teaser for /indicators.
 *
 * Ranking is `|conviction| · weight` (LAYOUT.md), resolved against data that
 * already exists rather than a new endpoint:
 *   conviction = the indicator's Laplace-smoothed hit rate from
 *                /api/stats/indicators — how often this vote has been right.
 *                Null (never scored) falls back to a 0.5 coin-flip prior so a
 *                brand-new indicator neither dominates nor disappears.
 *   weight     = the fleet's learned trust in it (null before any bot has a
 *                stats row → 1.0, the weight every indicator starts at).
 *   sign       = the vote itself; neutral/absent votes are not signals.
 *
 * Global-scope indicators (fear_greed, whale_flow, oil…) are stored against
 * every symbol, so they are collapsed to ONE row — otherwise a single macro
 * vote would fill all five slots seven times over.
 */

import Link from 'next/link';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Empty, Panel } from '@/components/ui';
import { shortSymbol } from '@/lib/format';

const TOP_N = 5;
const NO_SAMPLES_PRIOR = 0.5;
const DEFAULT_WEIGHT = 1;

interface Signal {
  key: string;
  indicator: string;
  /** Null for market-wide indicators — they belong to no single symbol. */
  symbol: string | null;
  vote: 'bull' | 'bear';
  strength: number;
  hitRate: number | null;
  samples: number;
}

export function SignalsPanel() {
  const summary = useQuery({ queryKey: ['market-summary'], queryFn: api.summary, refetchInterval: 60_000 });
  const rollup = useQuery({
    queryKey: ['indicator-rollup'],
    queryFn: api.indicatorRollup,
    refetchInterval: 120_000,
  });

  const signals = useMemo<Signal[]>(() => {
    const defs = rollup.data?.indicators ?? [];
    if (defs.length === 0) return [];
    const byName = new Map(defs.map((d) => [d.indicator, d]));
    const out: Signal[] = [];
    const seenGlobal = new Set<string>();

    for (const s of summary.data?.symbols ?? []) {
      for (const [indicator, vote] of Object.entries(s.votes)) {
        if (vote !== 'bull' && vote !== 'bear') continue;
        const def = byName.get(indicator);
        if (!def) continue;
        const global = def.scope === 'global';
        if (global && seenGlobal.has(indicator)) continue;
        if (global) seenGlobal.add(indicator);
        const conviction = def.hitRate ?? NO_SAMPLES_PRIOR;
        out.push({
          key: global ? indicator : `${s.symbol}|${indicator}`,
          indicator,
          symbol: global ? null : s.symbol,
          vote,
          strength: conviction * (def.weight ?? DEFAULT_WEIGHT),
          hitRate: def.hitRate,
          samples: def.samples,
        });
      }
    }
    return out.sort((a, b) => b.strength - a.strength).slice(0, TOP_N);
  }, [summary.data, rollup.data]);

  return (
    <Panel
      title="Signals now"
      right={
        <Link href="/indicators" className="text-[10px] uppercase tracking-wider text-muted hover:text-cyan">
          all indicators →
        </Link>
      }
      bodyClassName="p-0"
    >
      {rollup.isError ? (
        <Empty>indicator rollup unavailable</Empty>
      ) : signals.length === 0 ? (
        <Empty>{summary.isLoading || rollup.isLoading ? 'loading…' : 'every indicator is neutral right now'}</Empty>
      ) : (
        <ul>
          {signals.map((s) => (
            <li
              key={s.key}
              className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs last:border-0"
            >
              <span className={`w-10 shrink-0 text-[10px] uppercase ${s.vote === 'bull' ? 'text-green' : 'text-red'}`}>
                {s.vote}
              </span>
              <span
                className="w-20 shrink-0 truncate text-muted"
                title={s.symbol === null ? 'market-wide' : s.symbol}
              >
                {s.symbol === null ? 'ALL' : shortSymbol(s.symbol)}
              </span>
              <span className="min-w-0 flex-1 truncate text-right text-muted" title={s.indicator}>
                {s.indicator}
              </span>
              <span
                className="tnum shrink-0 text-[10px] text-muted"
                title={
                  s.hitRate === null
                    ? 'no scored samples yet — ranked on a coin-flip prior'
                    : `hit rate ${(s.hitRate * 100).toFixed(0)}% over ${s.samples} samples`
                }
              >
                {s.hitRate === null ? 'new' : `${(s.hitRate * 100).toFixed(0)}%`}
              </span>
              <span className="h-1.5 w-10 shrink-0 bg-line" aria-hidden>
                <span
                  className={`block h-full ${s.vote === 'bull' ? 'bg-green' : 'bg-red'}`}
                  style={{ width: `${Math.max(4, Math.min(100, (s.strength / 2) * 100))}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
