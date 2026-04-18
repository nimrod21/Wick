'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { MacroStrip } from '@/components/dashboard/MacroStrip';
import { ProbabilityCard } from '@/components/dashboard/ProbabilityCard';
import { EventFirehose } from '@/components/dashboard/EventFirehose';
import { MiniChartGrid } from '@/components/dashboard/MiniChartGrid';
import { WeightsEditor } from '@/components/dashboard/WeightsEditor';

interface Asset {
  id: number;
  symbol: string;
  displayName: string;
  type: string;
  enabled: boolean;
}

interface AssetsResponse {
  assets: Asset[];
}

export default function DashboardPage() {
  const [weightsOpen, setWeightsOpen] = useState(false);

  const { data } = useQuery<AssetsResponse>({
    queryKey: ['dashboard-assets-crypto'],
    queryFn: () => api.get<AssetsResponse>('/api/assets?type=crypto'),
    staleTime: 5 * 60_000,
  });

  const assets = (data?.assets ?? []).filter((a) => a.enabled);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b-2 border-border-dim pb-3">
        <h1 className="pixel-font text-neon-cyan glow text-sm tracking-widest">DASHBOARD</h1>
        <span className="vt-font text-text-secondary text-base">
          Synthesis · probability fusion · live firehose
        </span>
      </div>

      <MacroStrip />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="pixel-font text-[11px] text-neon-purple glow uppercase tracking-wider">
              Probability Scores
            </h2>
            <button
              type="button"
              onClick={() => setWeightsOpen(true)}
              className="pixel-font text-[9px] text-neon-purple glow px-3 py-1 border-2 border-neon-purple hover:bg-neon-purple/10"
            >
              WEIGHTS
            </button>
          </div>
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
          >
            {assets.length === 0 ? (
              <div className="col-span-full bg-bg-terminal border-2 border-border-dim p-4 vt-font text-text-dim">
                No crypto assets enabled. Add some in Settings to score them here.
              </div>
            ) : (
              assets.map((a) => (
                <ProbabilityCard
                  key={a.id}
                  asset={{ id: a.id, symbol: a.symbol, displayName: a.displayName }}
                />
              ))
            )}
          </div>
        </div>

        <div className="lg:col-span-1 min-h-[500px] lg:min-h-0 lg:h-[calc(100vh-10rem)]">
          <EventFirehose />
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="pixel-font text-[11px] text-neon-cyan glow uppercase tracking-wider">
          Mini Charts (1h × 24)
        </h2>
        <MiniChartGrid />
      </div>

      {weightsOpen ? <WeightsEditor onClose={() => setWeightsOpen(false)} /> : null}
    </div>
  );
}
