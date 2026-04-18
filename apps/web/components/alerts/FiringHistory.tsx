'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';
import type { AlertChannel, AlertFiring, AlertRule } from '@cockpit/shared';

interface FiringsResponse {
  firings: AlertFiring[];
}
interface AlertsResponse {
  rules: AlertRule[];
}

interface AlertEventLike {
  kind?: string;
  id: number;
  ts: number;
  ruleId: number;
  ruleName: string;
  payload: unknown;
}

function isAlertEvent(e: unknown): e is AlertEventLike {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    o.kind === 'alert' &&
    typeof o.id === 'number' &&
    typeof o.ts === 'number' &&
    typeof o.ruleId === 'number' &&
    typeof o.ruleName === 'string'
  );
}

function fmtTs(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtTsFull(ts: number): string {
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function channelClass(status: 'ok' | 'failed' | undefined): string {
  if (status === 'ok') return 'text-neon-green';
  if (status === 'failed') return 'text-neon-red';
  return 'text-text-dim';
}

export function FiringHistory() {
  const [filterRuleId, setFilterRuleId] = useState<number | 'all'>('all');
  const [selected, setSelected] = useState<AlertFiring | null>(null);
  const [liveFirings, setLiveFirings] = useState<AlertFiring[]>([]);

  const firingsQuery = useQuery<FiringsResponse>({
    queryKey: ['alert-firings', filterRuleId],
    queryFn: () => {
      const qs = new URLSearchParams({ limit: '50' });
      if (filterRuleId !== 'all') qs.set('ruleId', String(filterRuleId));
      return api.get<FiringsResponse>(`/api/alerts/firings?${qs.toString()}`);
    },
    staleTime: 5_000,
  });

  const rulesQuery = useQuery<AlertsResponse>({
    queryKey: ['alerts'],
    queryFn: () => api.get<AlertsResponse>('/api/alerts'),
    staleTime: 5_000,
  });

  const { lastEvent } = useEventStream(['alert']);

  // Reset live buffer when filter changes.
  useEffect(() => {
    setLiveFirings([]);
  }, [filterRuleId]);

  // Prepend incoming SSE alerts as synthetic firing entries.
  useEffect(() => {
    if (!lastEvent || !isAlertEvent(lastEvent)) return;
    const evt = lastEvent;
    if (filterRuleId !== 'all' && evt.ruleId !== filterRuleId) return;
    setLiveFirings((prev) => {
      if (prev.some((f) => f.id === evt.id)) return prev;
      const synthetic: AlertFiring = {
        id: evt.id,
        ruleId: evt.ruleId,
        ts: evt.ts,
        payload: evt.payload,
        delivered: null,
      };
      return [synthetic, ...prev].slice(0, 200);
    });
  }, [lastEvent, filterRuleId]);

  const ruleNameById = useMemo<Map<number, string>>(() => {
    const m = new Map<number, string>();
    for (const r of rulesQuery.data?.rules ?? []) m.set(r.id, r.name);
    return m;
  }, [rulesQuery.data]);

  const merged = useMemo<AlertFiring[]>(() => {
    const initial = firingsQuery.data?.firings ?? [];
    const seen = new Set<number>();
    const out: AlertFiring[] = [];
    for (const f of [...liveFirings, ...initial]) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
    }
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, 200);
  }, [firingsQuery.data, liveFirings]);

  return (
    <div className="flex flex-col border border-border-dim bg-bg-terminal min-h-0">
      <div className="px-3 py-2 border-b border-border-dim shrink-0 flex items-center gap-2">
        <h2 className="pixel-font text-[10px] text-neon-amber glow uppercase">
          Firing History
        </h2>
        <select
          value={filterRuleId}
          onChange={(e) =>
            setFilterRuleId(e.target.value === 'all' ? 'all' : Number(e.target.value))
          }
          className="ml-auto bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-xs"
        >
          <option value="all">All rules</option>
          {rulesQuery.data?.rules.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-1 p-2">
        {firingsQuery.isLoading && (
          <div className="vt-font text-text-dim text-sm px-2 py-4">LOADING…</div>
        )}
        {firingsQuery.error && (
          <div className="vt-font text-neon-red text-sm px-2 py-4">
            FAILED: {(firingsQuery.error as Error).message}
          </div>
        )}
        {!firingsQuery.isLoading && merged.length === 0 && (
          <div className="vt-font text-text-dim text-sm px-2 py-4">
            No firings yet.
          </div>
        )}
        {merged.map((f) => {
          const ruleName = ruleNameById.get(f.ruleId) ?? `RULE#${f.ruleId}`;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setSelected(f)}
              className="text-left px-2 py-2 border-l-2 border-neon-amber bg-bg-void hover:bg-bg-terminal flex flex-col gap-0.5"
            >
              <div className="flex items-center gap-2">
                <span className="pixel-font text-[9px] text-neon-amber">
                  {fmtTs(f.ts)}
                </span>
                <span className="pixel-font text-[10px] text-neon-cyan truncate">
                  {ruleName}
                </span>
              </div>
              <span className="vt-font text-[12px] text-text-secondary truncate">
                {summarisePayload(f.payload)}
              </span>
            </button>
          );
        })}
      </div>

      <FiringDetailDrawer
        firing={selected}
        ruleName={
          selected ? (ruleNameById.get(selected.ruleId) ?? `RULE#${selected.ruleId}`) : ''
        }
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function summarisePayload(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload.slice(0, 160);
  try {
    return JSON.stringify(payload).slice(0, 160);
  } catch {
    return '';
  }
}

function FiringDetailDrawer({
  firing,
  ruleName,
  onClose,
}: {
  firing: AlertFiring | null;
  ruleName: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!firing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [firing, onClose]);

  if (!firing) return null;

  const delivered = (firing.delivered ?? {}) as Partial<
    Record<AlertChannel, 'ok' | 'failed'>
  >;
  const pretty = JSON.stringify(firing.payload, null, 2);

  return (
    <>
      <div className="fixed inset-0 bg-bg-void/70 z-40" onClick={onClose} />
      <aside
        className="fixed top-0 right-0 h-full w-96 bg-bg-terminal border-l-2 border-neon-amber z-50 flex flex-col shadow-[0_0_16px_var(--neon-amber)]"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border-dim shrink-0">
          <h2 className="pixel-font text-[10px] text-neon-amber glow uppercase">
            Firing Detail
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="pixel-font text-[9px] px-2 py-1 border-2 border-border-dim text-text-secondary hover:border-neon-red hover:text-neon-red"
          >
            CLOSE
          </button>
        </div>

        <div className="flex-1 overflow-y-auto flex flex-col gap-3 p-3">
          <div className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Rule
            </span>
            <span className="vt-font text-[14px] text-neon-cyan">{ruleName}</span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Fired
            </span>
            <span className="vt-font text-[13px] text-text-secondary">
              {fmtTsFull(firing.ts)}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Delivered
            </span>
            <div className="flex gap-2">
              {(['browser', 'telegram'] as AlertChannel[]).map((ch) => {
                const status = delivered[ch];
                return (
                  <span
                    key={ch}
                    className={`pixel-font text-[9px] px-2 py-1 border-2 border-border-dim ${channelClass(
                      status,
                    )}`}
                  >
                    {ch}: {status ?? '—'}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Payload
            </span>
            <pre className="vt-font text-[12px] text-text-primary bg-bg-void border border-border-dim p-2 whitespace-pre-wrap break-all">
              {pretty}
            </pre>
          </div>
        </div>
      </aside>
    </>
  );
}

export default FiringHistory;
