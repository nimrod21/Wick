import Link from 'next/link';

export default function TradingLayout({ children }: { children: React.ReactNode }) {
  const tabs = [
    { href: '/trading/crypto',      label: 'CRYPTO' },
    { href: '/trading/metals',      label: 'METALS' },
    { href: '/trading/commodities', label: 'COMMOD' },
    { href: '/trading/stocks',      label: 'STOCKS' },
  ];
  return (
    <div className="space-y-4">
      <nav className="flex gap-2 border-b border-border-dim pb-2">
        {tabs.map(t => (
          <Link
            key={t.href}
            href={t.href}
            className="pixel-font text-[10px] text-text-secondary hover:text-neon-cyan px-3 py-2"
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
