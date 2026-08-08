'use client';

import type { JournalEntry } from '@/lib/api';
import { Empty } from '@/components/ui';
import { dateTime } from '@/lib/format';

/** Current lessons pinned on top, reflections streaming below (task 6.4). */
export function JournalTab({
  entries,
  lessons,
}: {
  entries: JournalEntry[];
  lessons: { text: string; updatedTs: number } | null;
}) {
  const bullets = lessons
    ? lessons.text.split('\n').map((l) => l.replace(/^[-*•]\s*/, '').trim()).filter(Boolean)
    : [];

  return (
    <div className="divide-y divide-line">
      <div className="p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted">standing lessons</span>
          <span className="text-[10px] text-muted">
            {lessons ? `updated ${dateTime(lessons.updatedTs)}` : ''}
          </span>
        </div>
        {bullets.length === 0 ? (
          <Empty>no lessons yet — compressed once a day from reflections</Empty>
        ) : (
          <ul className="space-y-1 text-xs">
            {bullets.map((b, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-cyan">›</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="p-3">
        <div className="mb-2 text-[10px] uppercase tracking-wider text-muted">reflections</div>
        {entries.length === 0 ? (
          <Empty>no reflections yet</Empty>
        ) : (
          <ul className="space-y-1 text-xs">
            {entries.map((e) => (
              <li key={e.id} className="flex gap-2">
                <span className="tnum shrink-0 text-muted">{dateTime(e.ts)}</span>
                <span className={e.kind === 'lesson' ? 'text-muted' : ''}>{e.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
