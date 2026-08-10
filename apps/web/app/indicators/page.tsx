'use client';

/**
 * Indicators (IMPL-2) — two views over the same registry:
 *   Live         what every indicator says right now, per symbol
 *   Track record whether it has been right, and what the learner did about it
 *
 * Both tabs read the indicator catalog from /api/stats/indicators, so the
 * page is driven by the server's INDICATOR_DEFS rather than any local list.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { Empty, PixelTitle } from '@/components/ui';
import { LiveGrid } from '@/components/indicators/LiveGrid';
import { TrackRecord } from '@/components/indicators/TrackRecord';

const TABS = [
  { id: 'live', label: 'LIVE' },
  { id: 'record', label: 'TRACK RECORD' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function IndicatorsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabId>('live');
  const [focus, setFocus] = useState<string | null>(null);

  const rollup = useQuery({
    queryKey: ['indicator-rollup'],
    queryFn: api.indicatorRollup,
    refetchInterval: 300_000,
  });

  // Stats only move on outcome evaluation / the daily recompute.
  useLive('outcome', () => {
    void qc.invalidateQueries({ queryKey: ['indicator-rollup'] });
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-4">
        <PixelTitle className="text-green">INDICATORS</PixelTitle>
        <div className="flex gap-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`border px-2 py-0.5 text-[11px] uppercase tracking-wider ${
                tab === t.id ? 'border-cyan text-cyan' : 'border-line text-muted hover:text-fg'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {rollup.isError && (
        <Empty>indicator registry unavailable — {String((rollup.error as Error).message)}</Empty>
      )}

      {tab === 'live' ? (
        <LiveGrid
          rollup={rollup.data}
          onPickIndicator={(indicator) => {
            setFocus(indicator);
            setTab('record');
          }}
        />
      ) : (
        <TrackRecord key={focus ?? 'all'} rollup={rollup.data} focus={focus} />
      )}
    </div>
  );
}
