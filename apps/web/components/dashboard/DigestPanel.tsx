'use client';

import type { ReactNode } from 'react';
import { TopWhaleMovers } from '@/components/dashboard/TopWhaleMovers';
import { HeadlineNews } from '@/components/dashboard/HeadlineNews';
import { ActiveAlertsStrip } from '@/components/dashboard/ActiveAlertsStrip';
import { PaperPnL } from '@/components/dashboard/PaperPnL';

function Cell({ children }: { children: ReactNode }) {
  return (
    <div className="border border-border-dim bg-bg-void/40 p-3 overflow-hidden">
      {children}
    </div>
  );
}

export function DigestPanel() {
  return (
    <div className="flex flex-col border-2 border-border-dim bg-bg-terminal h-[720px] overflow-hidden">
      <div className="px-3 py-2 border-b border-border-dim shrink-0">
        <h2 className="pixel-font text-[11px] text-neon-amber glow uppercase tracking-wider">
          Digest
        </h2>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-3">
          <Cell>
            <PaperPnL />
          </Cell>
          <Cell>
            <ActiveAlertsStrip />
          </Cell>
          <Cell>
            <TopWhaleMovers />
          </Cell>
          <Cell>
            <HeadlineNews />
          </Cell>
        </div>
      </div>
    </div>
  );
}

export default DigestPanel;
