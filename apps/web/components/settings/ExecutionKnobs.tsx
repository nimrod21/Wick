'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface KvValue {
  key: string;
  value: string | null;
}

function useKv(key: string) {
  return useQuery<KvValue>({
    queryKey: ['runtime', 'kv', key],
    queryFn: () => api.get<KvValue>(`/api/runtime/kv/${key}`),
    retry: false,
    staleTime: 15_000,
  });
}

function usePutKv(key: string) {
  const qc = useQueryClient();
  return useMutation<KvValue, Error, string>({
    mutationFn: (value: string) => api.put<KvValue>(`/api/runtime/kv/${key}`, { value }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['runtime', 'kv', key] });
    },
  });
}

function KillSwitchRow() {
  const q = useKv('kill_switch');
  const m = usePutKv('kill_switch');
  const on = q.data?.value === 'true';

  const toggle = () => {
    m.mutate(on ? 'false' : 'true');
  };

  return (
    <div className="flex items-center gap-4 border border-border-dim bg-bg-terminal p-3">
      <div className="flex flex-col">
        <span className="pixel-font text-[11px] text-neon-red uppercase glow">Kill Switch</span>
        <span className="text-text-dim text-xs">Blocks all new orders when active.</span>
      </div>
      <button
        type="button"
        onClick={toggle}
        disabled={m.isPending || q.isLoading}
        className={
          on
            ? 'ml-auto pixel-font text-[14px] px-6 py-3 border-4 border-neon-red bg-neon-red text-bg-void glow uppercase disabled:opacity-60'
            : 'ml-auto pixel-font text-[14px] px-6 py-3 border-4 border-neon-red text-neon-red glow uppercase disabled:opacity-60'
        }
      >
        {m.isPending ? '…' : on ? 'ACTIVE' : 'OFF'}
      </button>
    </div>
  );
}

interface NumberRowProps {
  kvKey: string;
  label: string;
  description: string;
  placeholder: string;
  integer?: boolean;
  allowNegative?: boolean;
}

function NumberRow({ kvKey, label, description, placeholder, integer, allowNegative }: NumberRowProps) {
  const q = useKv(kvKey);
  const m = usePutKv(kvKey);
  const [input, setInput] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const currentValue = q.data?.value ?? null;

  useEffect(() => {
    setInput(currentValue ?? '');
  }, [currentValue]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3_000);
    return () => clearTimeout(id);
  }, [toast]);

  const parse = (raw: string): number | null => {
    const v = integer ? parseInt(raw, 10) : parseFloat(raw);
    if (!Number.isFinite(v)) return null;
    if (!allowNegative && v < 0) return null;
    return v;
  };

  const onSave = () => {
    const parsed = parse(input);
    if (parsed === null) {
      setToast('Invalid number');
      return;
    }
    m.mutate(String(parsed), {
      onSuccess: () => setToast('Saved'),
      onError: (err) => setToast(`Failed: ${err.message}`),
    });
  };

  return (
    <div className="flex items-center gap-3 border border-border-dim bg-bg-terminal p-3">
      <div className="flex flex-col flex-1">
        <span className="pixel-font text-[10px] text-neon-cyan uppercase">{label}</span>
        <span className="text-text-dim text-xs">{description}</span>
      </div>
      <input
        type="number"
        inputMode={integer ? 'numeric' : 'decimal'}
        step={integer ? '1' : '0.01'}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={placeholder}
        className="bg-bg-void border border-border-dim px-2 py-1 vt-font text-base w-32 text-right"
      />
      <button
        type="button"
        disabled={m.isPending || input === (currentValue ?? '')}
        onClick={onSave}
        className="pixel-font text-[10px] border-2 border-neon-cyan text-neon-cyan px-3 py-1 disabled:opacity-40"
      >
        {m.isPending ? 'Saving…' : 'Save'}
      </button>
      {toast && <span className="text-xs text-text-secondary ml-2">{toast}</span>}
    </div>
  );
}

function TradingModeRow() {
  const q = useKv('trading_mode');
  const m = usePutKv('trading_mode');
  const mode = q.data?.value === 'live' ? 'live' : 'paper';

  // Live is Phase 10 — disable toggle for now.
  const liveDisabled = true;

  return (
    <div className="flex items-center gap-3 border border-border-dim bg-bg-terminal p-3">
      <div className="flex flex-col flex-1">
        <span className="pixel-font text-[10px] text-neon-cyan uppercase">Trading Mode</span>
        <span className="text-text-dim text-xs">Paper uses the paper broker. Live is Phase 10.</span>
      </div>
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => m.mutate('paper')}
          disabled={m.isPending}
          className={
            mode === 'paper'
              ? 'pixel-font text-[10px] px-3 py-1 border-2 bg-neon-amber text-bg-void border-neon-amber'
              : 'pixel-font text-[10px] px-3 py-1 border-2 text-text-secondary border-border-dim hover:border-neon-cyan hover:text-neon-cyan disabled:opacity-40'
          }
        >
          PAPER
        </button>
        <button
          type="button"
          disabled={liveDisabled}
          title={liveDisabled ? 'Live trading arrives in Phase 10' : ''}
          className={
            'pixel-font text-[10px] px-3 py-1 border-2 text-text-dim border-border-dim opacity-50 cursor-not-allowed'
          }
        >
          LIVE
        </button>
      </div>
    </div>
  );
}

export function ExecutionKnobs() {
  return (
    <div className="flex flex-col gap-3">
      <KillSwitchRow />
      <NumberRow
        kvKey="max_order_notional"
        label="Max Order Notional ($)"
        description="Per-order USD notional cap."
        placeholder="500"
      />
      <NumberRow
        kvKey="max_open_positions_per_asset"
        label="Max Open Positions / Asset"
        description="How many concurrent legs per asset."
        placeholder="1"
        integer
      />
      <NumberRow
        kvKey="daily_loss_cap"
        label="Daily Loss Cap ($)"
        description="Negative. If today's PnL hits this, new orders blocked."
        placeholder="-1000"
        allowNegative
      />
      <NumberRow
        kvKey="order_cooldown_seconds"
        label="Order Cooldown (s)"
        description="Minimum seconds between orders on the same asset."
        placeholder="10"
        integer
      />
      <TradingModeRow />
    </div>
  );
}

export default ExecutionKnobs;
