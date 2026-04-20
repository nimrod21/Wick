'use client';

import { TopWhaleMovers } from '@/components/dashboard/TopWhaleMovers';
import { HeadlineNews } from '@/components/dashboard/HeadlineNews';
import { ActiveAlertsStrip } from '@/components/dashboard/ActiveAlertsStrip';
import { PaperPnL } from '@/components/dashboard/PaperPnL';
import { MacroWatch } from '@/components/dashboard/MacroWatch';

export function DigestPanel() {
  return (
    <div className="flex flex-col gap-3 border border-border-dim bg-bg-terminal p-3 h-[720px] overflow-y-auto">
      <h2 className="pixel-font text-[11px] text-neon-amber glow uppercase tracking-wider">
        Digest
      </h2>
      <PaperPnL />
      <ActiveAlertsStrip />
      <TopWhaleMovers />
      <HeadlineNews />
      <MacroWatch />
    </div>
  );
}

export default DigestPanel;
