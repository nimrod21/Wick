'use client';

import { useEffect, useState } from 'react';

export function DesktopOnlyGate() {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const check = () => setBlocked(window.innerWidth < 1024);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  if (!blocked) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-bg-void"
      role="alertdialog"
      aria-label="Desktop required"
    >
      <div className="pixel-font text-neon-cyan glow text-sm tracking-widest">
        COCKPIT
      </div>
      <div className="pixel-font text-neon-cyan glow text-xs text-center px-6 leading-relaxed">
        DESKTOP ONLY
      </div>
      <div className="vt-font text-text-secondary text-lg text-center px-6 max-w-md">
        This trading cockpit requires a minimum viewport width of 1024px.
      </div>
      <div className="vt-font text-text-dim text-sm">
        Current: <span className="text-neon-amber" suppressHydrationWarning>{typeof window !== 'undefined' ? window.innerWidth : 0}px</span>
      </div>
    </div>
  );
}
