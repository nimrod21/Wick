'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';
import type { AlertFiring, AlertRule } from '@cockpit/shared';

interface RulesResponse {
  rules: AlertRule[];
}

interface FiringsResponse {
  firings: AlertFiring[];
}

interface AlertEventLike {
  kind?: string;
  id?: number;
  ts?: number;
  ruleId?: number;
  ruleName?: string;
}

const DAY_SECONDS = 24 * 60 * 60;

function isAlertEvent(e: unknown): e is AlertEventLike {
  if (!e || typeof e !== 'object') return false;
  return (e as { kind?: unknown }).kind === 'alert';
}

function relTime(tsSec: number, nowMs: number): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000 - tsSec));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}

function extractSymbol(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  if (typeof p.symbol === 'string') return p.symbol;
  if (typeof p.ticker === 'string') return p.ticker;
  if (Array.isArray(p.tickers) && typeof p.tickers[0] === 'string') return p.tickers[0];
  if (typeof p.chain === 'string') return String(p.chain).toUpperCase();
  return '';
}

export function ActiveAlertsStrip() {
  const [now, setNow] = useState<number>(() => Date.now());
  const [sinceLoad, setSinceLoad] = useState<number>(0);
  const [seenIds] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const rulesQuery = useQuery<RulesResponse>({
    queryKey: ['alerts-rules-strip'],
    queryFn: () => api.get<RulesResponse>('/api/alerts'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const firingsQuery = useQuery<FiringsResponse>({
    queryKey: ['alerts-firings-strip'],
    queryFn: () => api.get<FiringsResponse>('/api/alerts/firings?limit=20'),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const { lastEvent } = useEventStream(['alert']);

  useEffect(() => {
    if (!isAlertEvent(lastEvent)) return;
    const id = typeof lastEvent.id === 'number' ? lastEvent.id : undefined;
    if (id !== undefined) {
      if (seenIds.has(id)) return;
      seenIds.add(id);
    }
    setSinceLoad((n) => n + 1);
  }, [lastEvent, seenIds]);

  const rulesMissing = rulesQuery.isError;
  const firingsMissing = firingsQuery.isError;

  const enabledCount = useMemo<number>(() => {
    const rules = rulesQuery.data?.rules ?? [];
    return rules.filter((r) => r.enabled).length;
  }, [rulesQuery.data]);

  const ruleNameById = useMemo<Map<number, string>>(() => {
    const m = new Map<number, string>();
    for (const r of rulesQuery.data?.rules ?? []) m.set(r.id, r.name);
    return m;
  }, [rulesQuery.data]);

  const recent = useMemo<AlertFiring[]>(() => {
    const firings = firingsQuery.data?.firings ?? [];
    const cutoff = Math.floor(now / 1000) - DAY_SECONDS;
    return firings.filter((f) => f.ts >= cutoff).slice(0, 3);
  }, [firingsQuery.data, now]);

  const firedLast24h = useMemo<number>(() => {
    const firings = firingsQuery.data?.firings ?? [];
    const cutoff = Math.floor(now / 1000) - DAY_SECONDS;
    return firings.filter((f) => f.ts >= cutoff).length;
  }, [firingsQuery.data, now]);

  const notWired = rulesMissing && firingsMissing;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="pixel-font text-[10px] text-text-secondary uppercase tracking-wider">
          ACTIVE ALERTS
        </h3>
        {notWired ? (
          <span className="pixel-font text-[9px] text-neon-amber px-2 py-1 border border-neon-amber">
            NOT WIRED
          </span>
        ) : null}
      </div>

      <div className="vt-font text-xs text-text-secondary flex items-center gap-2 flex-wrap">
        <span>
          RULES:{' '}
          <span className="text-neon-cyan">
            {rulesMissing ? '—' : enabledCount}
          </span>{' '}
          ACTIVE
        </span>
        <span className="text-text-dim">·</span>
        <span>
          FIRED (24H):{' '}
          <span className="text-neon-amber">
            {firingsMissing ? '—' : firedLast24h}
          </span>
        </span>
        <span className="text-text-dim">·</span>
        <span>
          SINCE LOAD: <span className="text-neon-magenta">{sinceLoad}</span>
        </span>
      </div>

      {firingsQuery.isLoading ? (
        <div className="vt-font text-sm text-text-dim">LOADING…</div>
      ) : recent.length === 0 ? (
        <div className="vt-font text-sm text-text-dim">No firings in last 24h.</div>
      ) : (
        <div className="flex flex-col">
          {recent.map((f) => {
            const name = ruleNameById.get(f.ruleId) ?? `RULE#${f.ruleId}`;
            const symbol = extractSymbol(f.payload);
            return (
              <div
                key={f.id}
                className="flex items-center gap-2 py-1 border-b border-border-dim last:border-b-0"
              >
                <span className="vt-font text-xs text-text-primary font-bold truncate flex-1 min-w-0">
                  {name}
                </span>
                {symbol ? (
                  <span className="pixel-font text-[9px] text-neon-cyan uppercase shrink-0">
                    {symbol}
                  </span>
                ) : null}
                <span className="vt-font text-[11px] text-text-dim shrink-0">
                  {relTime(f.ts, now)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ActiveAlertsStrip;
