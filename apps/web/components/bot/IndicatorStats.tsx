'use client';

import type { IndicatorStat } from '@/lib/api';
import { Empty, WeightBar } from '@/components/ui';

/**
 * Indicator stats table. A disabled indicator still records votes (the
 * "shadow" state, PLAN §11.2) — those rows are dimmed.
 */
export function IndicatorStats({ stats }: { stats: IndicatorStat[] }) {
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
        {stats.map((s) => (
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
            <td className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted">
              {s.enabled ? 'enabled' : 'shadow'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
