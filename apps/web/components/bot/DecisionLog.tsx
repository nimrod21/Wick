'use client';

/**
 * Virtualized decision log (IMPL-4 pitfall 3: thousands of rows after a few
 * weeks). Hand-rolled windowing — no new dependency. Row heights are
 * variable (a row grows when expanded), so offsets are prefix-summed and the
 * first visible row is found by binary search.
 */

import { useMemo, useRef, useState } from 'react';
import type { DecisionRow } from '@/lib/api';
import { ActionBadge, Empty, OutcomeBadge } from '@/components/ui';
import { dateTime, num, shortSymbol } from '@/lib/format';

const ROW_H = 30;
const DETAIL_H = 188;
const OVERSCAN = 6;
const VIEWPORT_H = 460;
const HORIZONS = ['1h', '4h', '24h'] as const;

type ActionFilter = 'all' | 'buy' | 'sell' | 'wait';
type StatusFilter = 'all' | 'executed' | 'vetoed' | 'llm_failed';

export function DecisionLog({ decisions }: { decisions: DecisionRow[] }) {
  const [action, setAction] = useState<ActionFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () =>
      decisions.filter(
        (d) => (action === 'all' || d.action === action) && (status === 'all' || d.status === status),
      ),
    [decisions, action, status],
  );

  const offsets = useMemo(() => {
    const out = new Array<number>(rows.length + 1);
    out[0] = 0;
    for (let i = 0; i < rows.length; i++) {
      out[i + 1] = out[i]! + (expanded.has(rows[i]!.id) ? ROW_H + DETAIL_H : ROW_H);
    }
    return out;
  }, [rows, expanded]);

  const total = offsets[rows.length] ?? 0;
  const start = Math.max(0, findIndex(offsets, scrollTop) - OVERSCAN);
  const end = Math.min(rows.length, findIndex(offsets, scrollTop + VIEWPORT_H) + OVERSCAN + 1);

  const toggle = (id: number): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2 text-[11px]">
        <Filter label="action" value={action} onChange={setAction} options={['all', 'buy', 'sell', 'wait']} />
        <Filter label="status" value={status} onChange={setStatus} options={['all', 'executed', 'vetoed', 'llm_failed']} />
        <span className="ml-auto text-muted">{rows.length} rows</span>
      </div>

      <div className="grid grid-cols-[80px_88px_56px_44px_48px_44px_1fr_150px] gap-2 border-b border-line px-3 py-1 text-[10px] uppercase tracking-wider text-muted">
        <span>time</span>
        <span>trigger</span>
        <span>action</span>
        <span>sym</span>
        <span>size</span>
        <span>conf</span>
        <span>provider / model</span>
        <span>outcome</span>
      </div>

      {rows.length === 0 ? (
        <Empty>no decisions yet</Empty>
      ) : (
        <div
          ref={boxRef}
          className="overflow-y-auto"
          style={{ height: VIEWPORT_H }}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div style={{ height: total, position: 'relative' }}>
            {rows.slice(start, end).map((d, i) => {
              const index = start + i;
              const isOpen = expanded.has(d.id);
              return (
                <div
                  key={d.id}
                  style={{ position: 'absolute', top: offsets[index], left: 0, right: 0 }}
                  className="border-b border-line"
                >
                  <button
                    type="button"
                    onClick={() => toggle(d.id)}
                    style={{ height: ROW_H }}
                    className="grid w-full grid-cols-[80px_88px_56px_44px_48px_44px_1fr_150px] items-center gap-2 px-3 text-left text-xs hover:bg-bg"
                  >
                    <span className="tnum text-muted">{dateTime(d.ts)}</span>
                    <span className="truncate text-muted" title={d.triggerDetail ?? ''}>
                      {d.triggerType ?? '—'}
                    </span>
                    <ActionBadge action={d.action} status={d.status} />
                    <span>{shortSymbol(d.symbol)}</span>
                    <span className="tnum text-muted">{d.sizePct === null ? '—' : `${d.sizePct}%`}</span>
                    <span className="tnum text-muted">{d.confidence === null ? '—' : d.confidence}</span>
                    <span className="truncate text-muted" title={`${d.provider ?? ''} ${d.model ?? ''}`}>
                      {d.provider ?? '—'}
                      {d.model ? ` · ${d.model}` : ''}
                    </span>
                    <span className="flex gap-1">
                      {HORIZONS.map((h) => (
                        <OutcomeBadge
                          key={h}
                          horizon={h}
                          score={d.outcomes[h]?.score ?? null}
                          fwdRetPct={d.outcomes[h]?.fwdRetPct ?? null}
                        />
                      ))}
                    </span>
                  </button>

                  {isOpen && (
                    <div style={{ height: DETAIL_H }} className="overflow-y-auto bg-bg px-3 py-2 text-xs">
                      <div className="mb-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <Detail label="status" value={d.status} />
                        <Detail label="veto" value={d.vetoReason ?? '—'} />
                        <Detail label="trigger detail" value={d.triggerDetail ?? '—'} />
                        <Detail
                          label="fwd ret (4h)"
                          value={d.outcomes['4h']?.fwdRetPct === undefined || d.outcomes['4h']?.fwdRetPct === null
                            ? '—'
                            : `${num(d.outcomes['4h'].fwdRetPct)}%`}
                        />
                      </div>
                      <div className="text-[10px] uppercase tracking-wider text-muted">reasoning</div>
                      <p className="whitespace-pre-wrap text-fg">{d.reasoning || '—'}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="truncate" title={value}>
        {value}
      </div>
    </div>
  );
}

function Filter<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: readonly T[];
}) {
  return (
    <label className="flex items-center gap-1 text-muted">
      <span className="uppercase tracking-wider">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className="py-0.5 text-xs">
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Largest i with offsets[i] <= y. */
function findIndex(offsets: number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
