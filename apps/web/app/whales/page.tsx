'use client';

import { useState } from 'react';
import { ChainTabs } from '@/components/whales/ChainTabs';
import { AddressManager } from '@/components/whales/AddressManager';
import { LiveTxStream } from '@/components/whales/LiveTxStream';

export default function WhalesPage() {
  const [chain, setChain] = useState<'eth' | 'sol' | 'btc'>('eth');
  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-8rem)]">
      <div className="flex items-center justify-between">
        <h1 className="pixel-font text-neon-magenta glow text-xs">WHALE TRACKER</h1>
        <ChainTabs activeChain={chain} onChange={setChain} />
      </div>
      <div className="grid grid-cols-[320px_1fr] gap-3 flex-1 min-h-0">
        <AddressManager chain={chain} />
        <LiveTxStream chain={chain} />
      </div>
    </div>
  );
}
