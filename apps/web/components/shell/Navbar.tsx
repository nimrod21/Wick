'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { StatusDot } from './StatusDot';
import { LocalClock } from './LocalClock';

const TABS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'Dashboard', href: '/' },
  { label: 'Trading', href: '/trading/crypto' },
  { label: 'Whales', href: '/whales' },
  { label: 'News', href: '/news' },
  { label: 'Indicators', href: '/indicators' },
  { label: 'Alerts', href: '/alerts' },
  { label: 'Settings', href: '/settings' },
];

interface KvValue {
  key: string;
  value: string | null;
}

function LiveModeIndicator() {
  const q = useQuery<KvValue>({
    queryKey: ['runtime', 'kv', 'trading_mode'],
    queryFn: () => api.get<KvValue>('/api/runtime/kv/trading_mode'),
    refetchInterval: 5_000,
    retry: false,
  });
  if (q.data?.value !== 'live') return null;
  return (
    <span
      className="pixel-font text-[10px] px-2 py-1 border-2 bg-neon-red text-bg-void border-neon-red uppercase animate-pulse glow"
      title="Live trading active"
    >
      ● LIVE
    </span>
  );
}

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === '/') return pathname === '/';
  // /trading/crypto also highlights the "Trading" tab
  if (href.startsWith('/trading/')) {
    return pathname.startsWith('/trading/');
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Navbar() {
  const pathname = usePathname();
  return (
    <nav className="fixed top-0 left-0 right-0 h-14 bg-bg-terminal border-b-2 border-border-dim z-10">
      <div className="h-full flex items-center px-6 gap-6">
        <span className="pixel-font text-[11px] text-neon-cyan glow tracking-widest">COCKPIT</span>
        <div className="flex items-center gap-1">
          {TABS.map((tab) => {
            const active = isActive(pathname, tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={
                  active
                    ? 'pixel-font text-[9px] uppercase px-3 py-2 tracking-wider border-b-2 border-neon-cyan text-neon-cyan glow -mb-[2px]'
                    : 'pixel-font text-[9px] uppercase px-3 py-2 tracking-wider border-b-2 border-transparent text-text-secondary hover:text-neon-cyan transition-colors -mb-[2px]'
                }
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-4">
          <LiveModeIndicator />
          <StatusDot />
          <LocalClock />
        </div>
      </div>
    </nav>
  );
}
