'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AlertCondition, AlertRule } from '@cockpit/shared';

interface AlertsResponse {
  rules: AlertRule[];
}

interface RuleListProps {
  onEdit: (id: number) => void;
}

function summariseCondition(c: AlertCondition): string {
  switch (c.type) {
    case 'price_move': {
      const win =
        c.windowSeconds >= 3600
          ? `${Math.round(c.windowSeconds / 3600)}h`
          : `${Math.round(c.windowSeconds / 60)}m`;
      const dir = c.direction === 'either' ? '±' : c.direction === 'up' ? '↑' : '↓';
      return `ASSET#${c.assetId} ${dir}${Math.abs(c.pctChange)}% / ${win}`;
    }
    case 'price_level':
      return `ASSET#${c.assetId} price ${c.operator} ${c.value}`;
    case 'whale_tx': {
      const chain = c.chain ?? 'any';
      const dir = c.direction && c.direction !== 'either' ? ` ${c.direction}` : '';
      return `whale tx ${chain}${dir} ≥ $${c.minUsd.toLocaleString()}`;
    }
    case 'news': {
      const parts: string[] = [];
      if (c.tickers?.length) parts.push(`tickers=${c.tickers.join('|')}`);
      if (c.keywordsAny?.length) parts.push(`any=${c.keywordsAny.join('|')}`);
      if (c.keywordsAll?.length) parts.push(`all=${c.keywordsAll.join('|')}`);
      if (c.minSentimentAbs != null) parts.push(`|sent|≥${c.minSentimentAbs}`);
      return `news ${parts.join(' ') || '(any)'}`;
    }
    case 'indicator_level':
      return `${c.name} ${c.operator} ${c.value}`;
    case 'indicator_cross':
      return `${c.name} cross ${c.direction} ${c.threshold}`;
    case 'probability':
      return `prob ASSET#${c.assetId} ${c.horizon} ${c.operator} ${c.value}`;
  }
}

export function RuleList({ onEdit }: RuleListProps) {
  const qc = useQueryClient();
  const query = useQuery<AlertsResponse>({
    queryKey: ['alerts'],
    queryFn: () => api.get<AlertsResponse>('/api/alerts'),
    staleTime: 5_000,
  });

  const patchMut = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: unknown }) => {
      const res = await fetch(`/api/alerts/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts'] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.del<{ ok: boolean }>(`/api/alerts/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts'] });
    },
  });

  const handleDelete = (id: number, name: string) => {
    if (typeof window === 'undefined') return;
    if (!window.confirm(`Delete rule "${name}"?`)) return;
    deleteMut.mutate(id);
  };

  return (
    <div className="flex flex-col border border-border-dim bg-bg-terminal min-h-0">
      <div className="px-3 py-2 border-b border-border-dim shrink-0">
        <h2 className="pixel-font text-[10px] text-neon-cyan glow uppercase">
          Rules ({query.data?.rules.length ?? 0})
        </h2>
      </div>
      <div className="flex-1 overflow-y-auto flex flex-col gap-1 p-2">
        {query.isLoading && (
          <div className="vt-font text-text-dim text-sm px-2 py-4">LOADING…</div>
        )}
        {query.error && (
          <div className="vt-font text-neon-red text-sm px-2 py-4">
            FAILED: {(query.error as Error).message}
          </div>
        )}
        {query.data?.rules.length === 0 && (
          <div className="vt-font text-text-dim text-sm px-2 py-4">
            No rules yet — click + NEW RULE above.
          </div>
        )}
        {query.data?.rules.map((rule) => {
          const summary = summariseCondition(rule.condition);
          return (
            <div
              key={rule.id}
              className={`flex items-center gap-2 px-2 py-2 border-2 ${
                rule.enabled
                  ? 'border-neon-cyan bg-bg-void'
                  : 'border-border-dim bg-bg-terminal opacity-50'
              }`}
            >
              <label className="flex items-center gap-1 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  disabled={patchMut.isPending}
                  onChange={(e) =>
                    patchMut.mutate({
                      id: rule.id,
                      body: { enabled: e.target.checked },
                    })
                  }
                />
              </label>
              <div className="flex-1 min-w-0 flex flex-col">
                <span className="pixel-font text-[10px] text-neon-cyan truncate">
                  {rule.name}
                </span>
                <span className="vt-font text-[12px] text-text-secondary truncate">
                  {summary}
                </span>
                <span className="vt-font text-[10px] text-text-dim">
                  cd {rule.cooldownSeconds}s · ch {rule.channels.join('+')}
                  {rule.lastFiredTs
                    ? ` · fired ${new Date(rule.lastFiredTs * 1000).toLocaleTimeString()}`
                    : ' · never fired'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onEdit(rule.id)}
                className="pixel-font text-[9px] px-2 py-1 border-2 border-neon-amber text-neon-amber"
              >
                EDIT
              </button>
              <button
                type="button"
                onClick={() => handleDelete(rule.id, rule.name)}
                disabled={deleteMut.isPending}
                className="pixel-font text-[9px] px-2 py-1 border-2 border-neon-red text-neon-red disabled:opacity-40"
              >
                DEL
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default RuleList;
