'use client';

/**
 * Intel (IMPL-3b) — depth for the three non-TA sources. Everything shown
 * here is already wired into the indicator pipeline (IMPL-3a); this page is
 * where the raw rows behind those votes are readable.
 */

import { useState } from 'react';
import { PixelTitle } from '@/components/ui';
import { NewsTab } from '@/components/intel/NewsTab';
import { WhalesTab } from '@/components/intel/WhalesTab';
import { MacroTab } from '@/components/intel/MacroTab';

const TABS = [
  { id: 'news', label: 'NEWS' },
  { id: 'whales', label: 'WHALES' },
  { id: 'macro', label: 'MACRO' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function IntelPage() {
  const [tab, setTab] = useState<TabId>('news');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-4">
        <PixelTitle className="text-green">INTEL</PixelTitle>
        <div className="flex gap-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`border px-2 py-0.5 text-[11px] uppercase tracking-wider ${
                tab === t.id ? 'border-cyan text-cyan' : 'border-line text-muted hover:text-fg'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'news' ? <NewsTab /> : tab === 'whales' ? <WhalesTab /> : <MacroTab />}
    </div>
  );
}
