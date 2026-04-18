'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';

type Horizon = '1h' | '4h' | '24h';
const HORIZONS: readonly Horizon[] = ['1h', '4h', '24h'] as const;

interface ProbScore {
  id: number;
  ts: number;
  assetId: number;
  horizon: Horizon;
  bullishProb: number;
  confidence: number;
}

interface ProbResponse {
  score: ProbScore | null;
}

interface SignalRow {
  name: string;
  valueNormalized: number;
  weight: number;
  asOf: number;
}

interface SignalsResponse {
  score: { ts: number; bullishProb: number; confidence: number } | null;
  signals: SignalRow[];
}

interface Asset {
  id: number;
  symbol: string;
  displayName: string;
}

interface ProbabilityEventPayload {
  kind: string;
  assetId: number;
  horizon: Horizon;
  bullishProb: number;
  confidence: number;
  ts: number;
  id: number;
}

function probColor(p: number): string {
  if (p > 0.55) return 'bg-neon-green';
  if (p < 0.45) return 'bg-neon-red';
  return 'bg-neon-amber';
}

function probTextColor(p: number): string {
  if (p > 0.55) return 'text-neon-green';
  if (p < 0.45) return 'text-neon-red';
  return 'text-neon-amber';
}

function Bar({ horizon, score }: { horizon: Horizon; score: ProbScore | null }) {
  const p = score?.bullishProb ?? null;
  const conf = score?.confidence ?? null;
  const pct = p !== null ? Math.round(p * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="pixel-font text-[9px] text-text-secondary w-8 uppercase shrink-0">
        {horizon}
      </span>
      <div className="flex-1 h-5 bg-bg-void border border-border-dim relative">
        {p !== null ? (
          <div
            className={`absolute top-0 left-0 h-full ${probColor(p)}`}
            style={{ width: `${pct}%` }}
          />
        ) : null}
      </div>
      <span
        className={`vt-font text-xl w-14 text-right shrink-0 ${p !== null ? probTextColor(p) : 'text-text-dim'}`}
      >
        {p !== null ? `${pct}%` : '—'}
      </span>
    </div>
  );
}

function ConfidenceRow({ score }: { score: ProbScore | null }) {
  const conf = score?.confidence ?? null;
  if (conf === null) return null;
  return (
    <span className="pixel-font text-[8px] text-text-dim uppercase tracking-wider">
      conf {Math.round(conf * 100)}%
    </span>
  );
}

function SignalsModal({
  asset,
  onClose,
}: {
  asset: Asset;
  onClose: () => void;
}) {
  const [horizon, setHorizon] = useState<Horizon>('1h');
  const { data, isLoading } = useQuery<SignalsResponse>({
    queryKey: ['prob-signals', asset.id, horizon],
    queryFn: () =>
      api.get<SignalsResponse>(
        `/api/probability/signals?assetId=${asset.id}&horizon=${horizon}`,
      ),
  });
  const signals = data?.signals ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-bg-terminal border-2 border-neon-purple shadow-[0_0_20px_var(--neon-purple)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-dim">
          <div className="flex items-baseline gap-3">
            <span className="pixel-font text-[10px] text-neon-purple glow">
              {asset.symbol} SIGNALS
            </span>
            <span className="vt-font text-text-secondary text-lg">
              {asset.displayName}
            </span>
          </div>
          <button
            type="button"
            className="pixel-font text-[10px] text-text-secondary hover:text-neon-red px-2 py-1 border border-border-dim"
            onClick={onClose}
          >
            X
          </button>
        </div>
        <div className="flex gap-2 px-4 py-2 border-b border-border-dim">
          {HORIZONS.map((h) => (
            <button
              type="button"
              key={h}
              className={`pixel-font text-[9px] px-2 py-1 border ${
                horizon === h
                  ? 'border-neon-purple text-neon-purple glow'
                  : 'border-border-dim text-text-secondary hover:text-neon-cyan'
              }`}
              onClick={() => setHorizon(h)}
            >
              {h.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="p-4 space-y-2">
          {isLoading ? (
            <div className="vt-font text-neon-cyan glow">LOADING…</div>
          ) : signals.length === 0 ? (
            <div className="vt-font text-text-dim">
              No signals yet. Probability engine may still be warming up.
            </div>
          ) : (
            signals.map((s) => {
              const pct = Math.round(s.valueNormalized * 100);
              const color = probTextColor(0.5 + s.valueNormalized / 2);
              const barColor = probColor(0.5 + s.valueNormalized / 2);
              const width = Math.abs(pct);
              return (
                <div key={s.name} className="flex items-center gap-2 text-sm">
                  <span className="pixel-font text-[9px] text-text-secondary w-44 uppercase">
                    {s.name}
                  </span>
                  <div className="flex-1 h-3 bg-bg-void border border-border-dim relative">
                    <div
                      className={`absolute top-0 h-full ${barColor}`}
                      style={{
                        width: `${width / 2}%`,
                        left: s.valueNormalized >= 0 ? '50%' : `${50 - width / 2}%`,
                      }}
                    />
                    <div className="absolute left-1/2 top-0 h-full w-px bg-border-dim" />
                  </div>
                  <span className={`vt-font text-sm w-12 text-right ${color}`}>
                    {pct > 0 ? `+${pct}` : pct}
                  </span>
                  <span className="pixel-font text-[8px] text-text-dim w-10 text-right">
                    w:{s.weight.toFixed(1)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export function ProbabilityCard({ asset }: { asset: Asset }) {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);

  const q1h = useQuery<ProbResponse>({
    queryKey: ['prob-latest', asset.id, '1h'],
    queryFn: () =>
      api.get<ProbResponse>(`/api/probability?assetId=${asset.id}&horizon=1h`),
    refetchInterval: 60_000,
  });
  const q4h = useQuery<ProbResponse>({
    queryKey: ['prob-latest', asset.id, '4h'],
    queryFn: () =>
      api.get<ProbResponse>(`/api/probability?assetId=${asset.id}&horizon=4h`),
    refetchInterval: 60_000,
  });
  const q24h = useQuery<ProbResponse>({
    queryKey: ['prob-latest', asset.id, '24h'],
    queryFn: () =>
      api.get<ProbResponse>(`/api/probability?assetId=${asset.id}&horizon=24h`),
    refetchInterval: 60_000,
  });

  // Live updates from SSE.
  const { lastEvent } = useEventStream(['probability'], { assetIds: [asset.id] });
  useEffect(() => {
    if (!lastEvent) return;
    const evt = lastEvent as ProbabilityEventPayload;
    if (evt.kind !== 'probability' || evt.assetId !== asset.id) return;
    qc.setQueryData<ProbResponse>(
      ['prob-latest', asset.id, evt.horizon],
      {
        score: {
          id: evt.id,
          ts: evt.ts,
          assetId: evt.assetId,
          horizon: evt.horizon,
          bullishProb: evt.bullishProb,
          confidence: evt.confidence,
        },
      },
    );
  }, [lastEvent, asset.id, qc]);

  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="block w-full text-left bg-bg-terminal border-2 border-border-dim hover:border-neon-purple p-4 transition-colors"
      >
        <div className="flex items-baseline justify-between mb-1">
          <span className="pixel-font text-[11px] text-neon-cyan glow">{asset.symbol}</span>
          <span className="vt-font text-base text-text-secondary">{asset.displayName}</span>
        </div>
        <div className="mb-3 h-4">
          <ConfidenceRow
            score={q1h.data?.score ?? q4h.data?.score ?? q24h.data?.score ?? null}
          />
        </div>
        <div className="space-y-2.5">
          <Bar horizon="1h" score={q1h.data?.score ?? null} />
          <Bar horizon="4h" score={q4h.data?.score ?? null} />
          <Bar horizon="24h" score={q24h.data?.score ?? null} />
        </div>
      </button>
      {modalOpen ? (
        <SignalsModal asset={asset} onClose={() => setModalOpen(false)} />
      ) : null}
    </>
  );
}

export default ProbabilityCard;
