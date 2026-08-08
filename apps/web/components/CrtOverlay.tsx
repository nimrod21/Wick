'use client';

import { useCrt } from '@/lib/prefs';

/** Mounted only when the settings toggle is on (default OFF, PLAN §12). */
export function CrtOverlay() {
  const [on] = useCrt();
  if (!on) return null;
  return <div className="scanlines" aria-hidden />;
}
