'use client';

/**
 * "Indicator choices" (IMPL-7) — the bot's own on/off decisions over time,
 * with what he said about each one. Wishes a code guard refused are in the
 * same stream, dimmed and struck: the point of the log is that we see what he
 * WANTED, not only what the frame let through.
 */

import type { IndicatorChange } from '@/lib/api';
import { Empty } from '@/components/ui';
import { dateTime } from '@/lib/format';

const SOURCE_LABEL: Record<IndicatorChange['source'], string> = {
  bot: 'his call',
  user: 'set by you',
  guard_veto: 'refused by the frame',
};

export function IndicatorChanges({
  changes,
  minActive,
}: {
  changes: IndicatorChange[];
  minActive: number;
}) {
  if (changes.length === 0) {
    return (
      <Empty>
        no indicator choices yet — he reviews his set on his own cadence (weekly by default)
      </Empty>
    );
  }
  return (
    <div>
      <ul className="divide-y divide-line">
        {changes.map((c) => {
          const vetoed = c.source === 'guard_veto';
          return (
            <li key={c.id} className={`flex gap-3 px-3 py-1.5 text-xs ${vetoed ? 'opacity-45' : ''}`}>
              <span className="tnum shrink-0 text-muted">{dateTime(c.ts)}</span>
              <span
                className={`shrink-0 border px-1 text-[10px] uppercase tracking-wider ${
                  vetoed
                    ? 'border-line text-muted line-through'
                    : c.action === 'on'
                      ? 'border-green text-green'
                      : 'border-amber text-amber'
                }`}
              >
                {c.indicator} {c.action}
              </span>
              <span className="min-w-0">
                <span className="text-muted">{SOURCE_LABEL[c.source]}</span>{' '}
                <span className={vetoed ? 'text-muted' : ''}>{c.reasoning ?? 'no reason given'}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-line px-3 py-1 text-[10px] text-muted">
        he owns the on/off; code only holds the frame — at least {minActive} indicators active, a few
        changes per review, one cooldown per indicator. Switched-off indicators keep voting in the
        background so their record keeps building.
      </p>
    </div>
  );
}
