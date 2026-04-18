'use client';

import Link from 'next/link';
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

export function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 h-14 bg-bg-terminal border-b border-border-dim flex items-center px-4 gap-4 z-10">
      <div className="flex items-center gap-1">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="pixel-font text-[10px] text-text-secondary hover:text-neon-cyan px-2 py-1"
          >
            {tab.label}
          </Link>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-3">
        <LiveModeIndicator />
        <StatusDot />
        <LocalClock />
      </div>
    </nav>
  );
}
