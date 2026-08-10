'use client';

import type { IndicatorChange, IndicatorStat } from '@/lib/api';
import { Empty, WeightBar } from '@/components/ui';
import { dateTime } from '@/lib/format';

/**
 * Indicator stats table. Since IMPL-7 the on/off is the BOT's choice, not the
 * system's: the state cell shows ON/OFF with his last stated reason on hover,
 * and — when `onToggle` is passed — doubles as Luka's override button. An OFF
 * indicator still records votes in the background (the "shadow" state), which
 * is why those rows are dimmed rather than hidden.
 */
export function IndicatorStats({
  stats,
  lastChange,
  onToggle,
  busy,
}: {
  stats: IndicatorStat[];
  /** Newest change per indicator — the reason behind the current state. */
  lastChange?: Map<string, IndicatorChange>;
  /** Present = the state cell becomes a manual on/off (source 'user'). */
  onToggle?: (indicator: string, enabled: boolean) => void;
  busy?: string | null;
}) {
  if (stats.length === 0) {
    return <Empty>no samples yet — stats appear once decisions are evaluated</Empty>;
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-muted">
          <th className="px-3 py-1 font-normal">indicator</th>
          <th className="px-3 py-1 font-normal">samples</th>
          <th className="px-3 py-1 font-normal">hit-rate</th>
          <th className="px-3 py-1 font-normal">weight</th>
          <th className="px-3 py-1 font-normal">state</th>
        </tr>
      </thead>
      <tbody>
        {stats.map((s) => {
          const change = lastChange?.get(s.indicator);
          const why = change
            ? `${change.source === 'user' ? 'set by you' : 'his call'} ${dateTime(change.ts)} — ${change.reasoning ?? 'no reason given'}`
            : 'never changed — trusted by default';
          const label = s.enabled ? 'on' : 'off';
          return (
            <tr key={s.indicator} className={`border-b border-line last:border-0 ${s.enabled ? '' : 'opacity-40'}`}>
              <td className="px-3 py-1">{s.indicator}</td>
              <td className="tnum px-3 py-1 text-muted">
                {s.samples} <span className="text-[10px]">({s.hits} hit)</span>
              </td>
              <td className="tnum px-3 py-1">
                {s.hitRate === null ? (
                  <span className="text-muted">—</span>
                ) : (
                  <span className={s.hitRate >= 0.5 ? 'text-green' : 'text-muted'}>
                    {(s.hitRate * 100).toFixed(0)}%
                  </span>
                )}
              </td>
              <td className="px-3 py-1">
                <WeightBar weight={s.weight} />
              </td>
              <td className="px-3 py-1 text-[10px] uppercase tracking-wider">
                {onToggle === undefined ? (
                  <span className={s.enabled ? 'text-green' : 'text-muted'} title={why}>
                    {label}
                  </span>
                ) : (
                  <button
                    type="button"
                    title={`${why} — click to switch ${s.enabled ? 'off' : 'on'}`}
                    disabled={busy === s.indicator}
                    onClick={() => onToggle(s.indicator, !s.enabled)}
                    className={`border px-1 uppercase tracking-wider disabled:opacity-40 ${
                      s.enabled ? 'border-green text-green' : 'border-line text-muted'
                    } hover:border-cyan hover:text-cyan`}
                  >
                    {busy === s.indicator ? '…' : label}
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
