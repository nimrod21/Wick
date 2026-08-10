'use client';

/**
 * Virtualized decision log (IMPL-4 pitfall 3: thousands of rows after a few
 * weeks). Hand-rolled windowing — no new dependency. Row heights are
 * variable (a row grows when expanded), so offsets are prefix-summed and the
 * first visible row is found by binary search.
 *
 * No wait-wall (IMPL-5): a bot that waits is doing its job, but a run of 14
 * identical waits is one fact, not fourteen. Consecutive waits collapse into a
 * single counter row that expands on click. Filtering to `wait` turns the
 * collapse off — you asked to see them.
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
/** A lone wait is not a wall — only runs of this many or more collapse. */
const COLLAPSE_MIN = 2;

type ActionFilter = 'all' | 'buy' | 'sell' | 'wait';
type StatusFilter = 'all' | 'executed' | 'vetoed' | 'llm_failed';

type Row =
  | { kind: 'decision'; key: string; decision: DecisionRow }
  | { kind: 'waits'; key: string; count: number; fromTs: number; toTs: number };

/**
 * Fold consecutive waits into counter rows. Groups the caller has expanded
 * are emitted as their individual decisions instead, so the virtualizer's
 * prefix sums stay a plain function of the row list.
 */
function foldWaits(decisions: DecisionRow[], opened: Set<string>, collapse: boolean): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < decisions.length; ) {
    const d = decisions[i]!;
    if (!collapse || d.action !== 'wait') {
      out.push({ kind: 'decision', key: `d${d.id}`, decision: d });
      i += 1;
      continue;
    }
    let j = i;
    while (j < decisions.length && decisions[j]!.action === 'wait') j += 1;
    const run = decisions.slice(i, j);
    // Keyed on the run's first decision: stable while the log grows at the top.
    const key = `w${run[0]!.id}`;
    const counter: Row = {
      kind: 'waits',
      key,
      count: run.length,
      fromTs: run[run.length - 1]!.ts,
      toTs: run[0]!.ts,
    };
    if (run.length < COLLAPSE_MIN) {
      for (const w of run) out.push({ kind: 'decision', key: `d${w.id}`, decision: w });
    } else if (opened.has(key)) {
      out.push(counter); // header first — it is also the "collapse again" control
      for (const w of run) out.push({ kind: 'decision', key: `d${w.id}`, decision: w });
    } else {
      out.push(counter);
    }
    i = j;
  }
  return out;
}

export function DecisionLog({ decisions }: { decisions: DecisionRow[] }) {
  const [action, setAction] = useState<ActionFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [openWaits, setOpenWaits] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () =>
      decisions.filter(
        (d) => (action === 'all' || d.action === action) && (status === 'all' || d.status === status),
      ),
    [decisions, action, status],
  );

  const rows = useMemo(
    () => foldWaits(filtered, openWaits, action !== 'wait'),
    [filtered, openWaits, action],
  );

  const waitCount = useMemo(() => filtered.filter((d) => d.action === 'wait').length, [filtered]);

  const offsets = useMemo(() => {
    const out = new Array<number>(rows.length + 1);
    out[0] = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      out[i + 1] = out[i]! + (r.kind === 'decision' && expanded.has(r.decision.id) ? ROW_H + DETAIL_H : ROW_H);
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

  const toggleWaits = (key: string): void =>
    setOpenWaits((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2 text-[11px]">
        <Filter label="action" value={action} onChange={setAction} options={['all', 'buy', 'sell', 'wait']} />
        <Filter label="status" value={status} onChange={setStatus} options={['all', 'executed', 'vetoed', 'llm_failed']} />
        <span className="ml-auto text-muted">
          {filtered.length} decisions
          {action !== 'wait' && waitCount > 0 ? ` · ${waitCount} waits` : ''}
        </span>
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
            {rows.slice(start, end).map((row, i) => {
              const index = start + i;
              if (row.kind === 'waits') {
                const open = openWaits.has(row.key);
                return (
                  <button
                    key={row.key}
                    type="button"
                    onClick={() => toggleWaits(row.key)}
                    style={{ position: 'absolute', top: offsets[index], left: 0, right: 0, height: ROW_H }}
                    className="flex w-full items-center gap-2 border-b border-line px-3 text-left text-xs text-muted hover:bg-bg hover:text-fg"
                    title={`${dateTime(row.fromTs)} → ${dateTime(row.toTs)}`}
                  >
                    <span className="w-3">{open ? '▾' : '▸'}</span>
                    <span>
                      … {row.count} wait{row.count === 1 ? '' : 's'} {open ? 'expanded' : 'collapsed'}
                    </span>
                  </button>
                );
              }
              const d = row.decision;
              const isOpen = expanded.has(d.id);
              return (
                <div
                  key={row.key}
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
