'use client';

import type { TriggerRow } from '@/lib/api';
import { Empty } from '@/components/ui';
import { dateTime } from '@/lib/format';

/** trigger_log for this bot. Gated rows (fired=0) are dimmed (task 6.4). */
export function TriggerTab({ triggers }: { triggers: TriggerRow[] }) {
  if (triggers.length === 0) return <Empty>no trigger evaluations logged yet</Empty>;
  return (
    <ul className="max-h-[460px] overflow-y-auto text-xs">
      {triggers.map((t) => (
        <li
          key={t.id}
          className={`flex items-center gap-3 border-b border-line px-3 py-1 last:border-0 ${
            t.fired ? '' : 'opacity-40'
          }`}
        >
          <span className="tnum w-24 shrink-0 text-muted">{dateTime(t.ts)}</span>
          <span className="w-32 shrink-0">{t.type}</span>
          <span
            className={`w-14 shrink-0 border px-1 text-center text-[10px] uppercase ${
              t.fired ? 'border-green text-green' : 'border-line text-muted'
            }`}
          >
            {t.fired ? 'fired' : 'gated'}
          </span>
          <span className="truncate text-muted" title={t.detail ?? ''}>
            {t.detail ?? '—'}
          </span>
        </li>
      ))}
    </ul>
  );
}
