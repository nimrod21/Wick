'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Btn, Empty, Panel } from '@/components/ui';
import { shortSymbol } from '@/lib/format';

/**
 * Watchlist editor. Validation is the SERVER's job — it checks the symbol
 * against Binance exchangeInfo (spot, TRADING) before the insert, so a typo
 * comes back as a 400 with the reason rather than a silent dead symbol.
 */
export function WatchlistPanel() {
  const qc = useQueryClient();
  const assets = useQuery({ queryKey: ['assets'], queryFn: api.assets });
  const [symbol, setSymbol] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['assets'] });
    void qc.invalidateQueries({ queryKey: ['market-summary'] });
  };

  const add = useMutation({
    mutationFn: (s: string) => api.addAsset(s, shortSymbol(s)),
    onSuccess: () => {
      setSymbol('');
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: (s: string) => api.removeAsset(s),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Panel title="Watchlist" bodyClassName="p-3">
      <div className="flex flex-wrap gap-2">
        {(assets.data ?? []).map((a) => (
          <span key={a.symbol} className="flex items-center gap-2 border border-line px-2 py-1 text-xs">
            {a.symbol}
            <button
              type="button"
              onClick={() => remove.mutate(a.symbol)}
              className="text-muted hover:text-red"
              title={`remove ${a.symbol}`}
            >
              ✕
            </button>
          </span>
        ))}
        {assets.data && assets.data.length === 0 && <Empty>watchlist is empty</Empty>}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          className="w-40 py-0.5 text-xs"
          placeholder="e.g. DOGEUSDT"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        />
        <Btn
          onClick={() => symbol.trim() && add.mutate(symbol.trim())}
          disabled={symbol.trim().length === 0 || add.isPending}
        >
          {add.isPending ? 'checking…' : 'add'}
        </Btn>
        <span className="text-[10px] text-muted">validated against Binance exchangeInfo</span>
      </div>

      {error && <p className="mt-2 text-xs text-red">{error}</p>}
    </Panel>
  );
}
