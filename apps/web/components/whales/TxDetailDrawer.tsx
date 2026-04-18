'use client';

import { useEffect } from 'react';

export type WhaleChain = 'eth' | 'sol' | 'btc';

export interface WhaleTxEvent {
  id: string | number;
  ts: number;
  source: string;
  kind: 'whale_tx';
  chain: WhaleChain;
  address: string;
  direction: 'in' | 'out';
  token: string;
  amount: number;
  usdValue: number | null;
  counterpart: string;
  txHash: string;
  label: string | null;
}

interface TxDetailDrawerProps {
  event: WhaleTxEvent | null;
  onClose: () => void;
}

function explorerUrl(chain: WhaleChain, txHash: string): string {
  switch (chain) {
    case 'eth':
      return `https://etherscan.io/tx/${txHash}`;
    case 'sol':
      return `https://solscan.io/tx/${txHash}`;
    case 'btc':
      return `https://blockstream.info/tx/${txHash}`;
  }
}

export function TxDetailDrawer({ event, onClose }: TxDetailDrawerProps) {
  // Close on ESC.
  useEffect(() => {
    if (!event) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [event, onClose]);

  if (!event) return null;

  const pretty = JSON.stringify(event, null, 2);

  return (
    <>
      <div
        className="fixed inset-0 bg-bg-void/70 z-40"
        onClick={onClose}
      />
      <aside
        className="fixed top-0 right-0 h-full w-96 bg-bg-terminal border-l-2 border-neon-magenta z-50 flex flex-col shadow-[0_0_16px_var(--neon-magenta)]"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border-dim shrink-0">
          <h2 className="pixel-font text-[10px] text-neon-magenta glow uppercase">
            TX Detail
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="pixel-font text-[9px] px-2 py-1 border-2 border-border-dim text-text-secondary hover:border-neon-red hover:text-neon-red"
          >
            CLOSE
          </button>
        </div>

        <div className="flex-1 overflow-y-auto flex flex-col gap-3 p-3">
          <div className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Chain
            </span>
            <span className="vt-font text-[14px] text-neon-cyan uppercase">
              {event.chain}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Explorer
            </span>
            <a
              href={explorerUrl(event.chain, event.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="vt-font text-[14px] text-neon-magenta hover:underline break-all"
            >
              {event.txHash}
            </a>
          </div>

          <div className="flex flex-col gap-1">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Payload
            </span>
            <pre className="vt-font text-[12px] text-text-primary bg-bg-void border border-border-dim p-2 whitespace-pre-wrap break-all">
              {pretty}
            </pre>
          </div>

          {/* TODO: render scheduled snapshots (price/orderbook captures) once
              the snapshots API lands in a later phase. */}
          <div className="flex flex-col gap-1 opacity-60">
            <span className="pixel-font text-[8px] text-text-secondary uppercase">
              Snapshots
            </span>
            <span className="vt-font text-[12px] text-text-dim">
              (coming soon — snapshots are scheduled server-side)
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}

export default TxDetailDrawer;
