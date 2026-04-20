'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

const SIGNAL_NAMES = [
  'fear_greed_level',
  'fear_greed_delta',
  'dxy_trend',
  'vix_level',
  'funding_rate',
  'open_interest_delta',
  'btc_dominance_trend',
  'whale_netflow_to_exchanges',
  'news_sentiment_aggregate',
  'price_momentum_1h',
  'price_momentum_4h',
  'price_momentum_24h',
  'rsi_14',
  'macd_histogram',
  'macd_line',
  'ema20_slope_4h',
  'ema200_distance',
] as const;

type SignalName = (typeof SIGNAL_NAMES)[number];
type Weights = Record<SignalName, number>;

interface WeightsResponse {
  weights: Weights;
}

export function WeightsEditor({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery<WeightsResponse>({
    queryKey: ['prob-weights'],
    queryFn: () => api.get<WeightsResponse>('/api/probability/weights'),
  });

  const [draft, setDraft] = useState<Weights | null>(null);
  useEffect(() => {
    if (data?.weights && draft === null) {
      setDraft({ ...data.weights });
    }
  }, [data, draft]);

  const mutation = useMutation({
    mutationFn: async (w: Weights) =>
      api.put<WeightsResponse>('/api/probability/weights', w),
    onSuccess: (resp) => {
      qc.setQueryData(['prob-weights'], resp);
      qc.invalidateQueries({ queryKey: ['prob-latest'] });
      qc.invalidateQueries({ queryKey: ['prob-signals'] });
      onClose();
    },
  });

  const working = draft ?? data?.weights ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-bg-terminal border-2 border-neon-purple shadow-[0_0_20px_var(--neon-purple)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-dim">
          <span className="pixel-font text-[10px] text-neon-purple glow uppercase">
            Signal Weights
          </span>
          <button
            type="button"
            className="pixel-font text-[10px] text-text-secondary hover:text-neon-red px-2 py-1 border border-border-dim"
            onClick={onClose}
          >
            X
          </button>
        </div>
        <div className="p-4 space-y-3 max-h-[70vh] overflow-y-auto">
          {working === null ? (
            <div className="vt-font text-neon-cyan glow">LOADING…</div>
          ) : (
            SIGNAL_NAMES.map((name) => {
              const v = working[name];
              return (
                <div key={name} className="flex items-center gap-3">
                  <span className="pixel-font text-[9px] text-text-secondary w-48 uppercase">
                    {name}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={5}
                    step={0.1}
                    value={v}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setDraft((prev) => {
                        const base = prev ?? { ...working };
                        return { ...base, [name]: next };
                      });
                    }}
                    className="flex-1 accent-neon-purple"
                  />
                  <span className="vt-font text-lg text-neon-purple glow w-10 text-right">
                    {v.toFixed(1)}
                  </span>
                </div>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-dim">
          <button
            type="button"
            onClick={() => setDraft(data?.weights ? { ...data.weights } : null)}
            className="pixel-font text-[9px] text-text-secondary hover:text-neon-cyan px-3 py-2 border border-border-dim"
          >
            RESET
          </button>
          <button
            type="button"
            disabled={!working || mutation.isPending}
            onClick={() => working && mutation.mutate(working)}
            className="pixel-font text-[9px] text-neon-green glow px-3 py-2 border-2 border-neon-green hover:bg-neon-green/10 disabled:opacity-50"
          >
            {mutation.isPending ? 'SAVING…' : 'SAVE'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default WeightsEditor;
