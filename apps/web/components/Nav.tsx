'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PixelTitle } from '@/components/ui';
import { isConnected, onConnectionChange, useLive } from '@/lib/sse';

const LINKS = [
  { href: '/', label: 'DASH' },
  { href: '/market', label: 'MARKET' },
  { href: '/settings', label: 'SETTINGS' },
];

export function Nav() {
  const pathname = usePathname();
  const [live, setLive] = useState(false);

  // The nav is on every page, so this subscription is what keeps the single
  // EventSource open even on pages that consume no live data (settings).
  useLive('market_warm', () => undefined);

  useEffect(() => {
    setLive(isConnected());
    return onConnectionChange(setLive);
  }, []);

  return (
    <nav className="flex items-center gap-6 border-b border-line px-4 py-3">
      <Link href="/" className="text-green">
        <PixelTitle as="span">WICK</PixelTitle>
      </Link>
      <div className="flex items-center gap-4">
        {LINKS.map((l) => {
          const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`text-[11px] uppercase tracking-wider ${active ? 'text-cyan' : 'text-muted hover:text-fg'}`}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
      <span className="ml-auto flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
        <span className={`inline-block h-2 w-2 ${live ? 'bg-green' : 'bg-line'}`} aria-hidden />
        {live ? 'live' : 'offline'}
      </span>
    </nav>
  );
}
