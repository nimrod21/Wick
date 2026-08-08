'use client';

/**
 * Local UI preferences (browser-only; nothing here belongs on the server).
 * Currently just the CRT scanline overlay — default OFF per PLAN §12.
 */

import { useEffect, useState } from 'react';

const CRT_KEY = 'wick.crt';

const listeners = new Set<(on: boolean) => void>();

export function getCrt(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(CRT_KEY) === '1';
}

export function setCrt(on: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CRT_KEY, on ? '1' : '0');
  for (const l of listeners) l(on);
}

/** `undefined` until mounted, so SSR and the first client render agree. */
export function useCrt(): [boolean | undefined, (on: boolean) => void] {
  const [on, setOn] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    setOn(getCrt());
    const l = (next: boolean): void => setOn(next);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return [on, setCrt];
}
