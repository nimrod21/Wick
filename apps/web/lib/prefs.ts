'use client';

/**
 * Local UI preferences (browser-only; nothing here belongs on the server):
 * the CRT scanline overlay (default OFF per PLAN §12) and the starred
 * symbols that pin themselves to the front of every symbol list.
 */

import { useEffect, useState } from 'react';

const CRT_KEY = 'wick.crt';
const FAV_KEY = 'wick.favorites';

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

// ── starred symbols (IMPL-6B) ──────────────────────────────────────────
// Purely a view preference over the server's watchlist: starring reorders
// chips and pickers, it never adds or removes an asset.

const favListeners = new Set<(favs: string[]) => void>();

function readFavorites(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(FAV_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Starred symbols plus a toggle. Empty until mounted (localStorage is not
 * readable during SSR), so the first client render matches the server's.
 */
export function useFavorites(): [Set<string>, (symbol: string) => void] {
  const [favs, setFavs] = useState<string[]>([]);
  useEffect(() => {
    setFavs(readFavorites());
    favListeners.add(setFavs);
    return () => {
      favListeners.delete(setFavs);
    };
  }, []);

  const toggle = (symbol: string): void => {
    const current = readFavorites();
    const next = current.includes(symbol)
      ? current.filter((s) => s !== symbol)
      : [...current, symbol];
    window.localStorage.setItem(FAV_KEY, JSON.stringify(next));
    for (const l of favListeners) l(next);
  };

  return [new Set(favs), toggle];
}

/** Starred rows first; everything keeps the server's order (sort is stable). */
export function favoritesFirst<T>(rows: T[], favs: Set<string>, key: (row: T) => string): T[] {
  if (favs.size === 0) return rows;
  return [...rows].sort((a, b) => Number(favs.has(key(b))) - Number(favs.has(key(a))));
}
