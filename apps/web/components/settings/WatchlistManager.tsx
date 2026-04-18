'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

type AssetType = 'crypto' | 'stock' | 'commodity' | 'etf';

interface Asset {
  id: number;
  symbol: string;
  display_name: string | null;
  type: AssetType;
  enabled: boolean;
}

interface SectionDef {
  title: string;
  types: AssetType[];
  defaultAddType: AssetType;
  addTypeOptions: AssetType[];
}

const SECTIONS: ReadonlyArray<SectionDef> = [
  { title: 'Crypto',      types: ['crypto'],              defaultAddType: 'crypto',    addTypeOptions: ['crypto'] },
  { title: 'Stocks',      types: ['stock'],               defaultAddType: 'stock',     addTypeOptions: ['stock'] },
  { title: 'Commodities', types: ['commodity', 'etf'],    defaultAddType: 'commodity', addTypeOptions: ['commodity', 'etf'] },
];

function useAssetsByTypes(types: AssetType[]) {
  return useQuery<Asset[]>({
    queryKey: ['assets', ...types],
    queryFn: async () => {
      const results = await Promise.all(types.map((t) => api.get<Asset[]>(`/api/assets?type=${t}`)));
      return results.flat();
    },
  });
}

function AssetRow({ asset, onChanged }: { asset: Asset; onChanged: () => void }) {
  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) =>
      api.put<Asset>(`/api/assets/${asset.id}`, { enabled }),
    onSuccess: onChanged,
  });
  const deleteMut = useMutation({
    mutationFn: () => api.del<void>(`/api/assets/${asset.id}`),
    onSuccess: onChanged,
  });

  return (
    <div className="flex items-center gap-3 border border-border-dim bg-bg-terminal px-3 py-2">
      <span className="pixel-font text-[11px] text-neon-cyan w-24">{asset.symbol}</span>
      <span className="text-text-secondary text-sm flex-1 truncate">{asset.display_name ?? asset.symbol}</span>
      <label className="flex items-center gap-2 text-xs text-text-dim cursor-pointer">
        <input
          type="checkbox"
          checked={asset.enabled}
          onChange={(e) => toggleMut.mutate(e.target.checked)}
          disabled={toggleMut.isPending}
        />
        enabled
      </label>
      <button
        type="button"
        onClick={() => deleteMut.mutate()}
        disabled={deleteMut.isPending}
        className="pixel-font text-[10px] border-2 border-neon-red text-neon-red px-2 py-1 disabled:opacity-40"
      >
        {deleteMut.isPending ? '…' : 'del'}
      </button>
    </div>
  );
}

function Section({ def }: { def: SectionDef }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useAssetsByTypes(def.types);
  const [symbol, setSymbol] = useState('');
  const [addType, setAddType] = useState<AssetType>(def.defaultAddType);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['assets', ...def.types] });
  };

  const addMut = useMutation({
    mutationFn: (payload: { symbol: string; type: AssetType }) =>
      api.post<Asset>('/api/assets', payload),
    onSuccess: () => {
      setSymbol('');
      invalidate();
    },
  });

  return (
    <section className="flex flex-col gap-2">
      <h3 className="pixel-font text-[11px] text-neon-magenta uppercase">{def.title}</h3>

      {isLoading && <div className="text-text-dim text-xs">Loading…</div>}
      {error && <div className="text-neon-red text-xs">Failed: {(error as Error).message}</div>}

      <div className="flex flex-col gap-1">
        {(data ?? []).map((a) => (
          <AssetRow key={a.id} asset={a} onChanged={invalidate} />
        ))}
        {data && data.length === 0 && <div className="text-text-dim text-xs">No assets yet.</div>}
      </div>

      <div className="flex items-center gap-2 mt-1">
        <input
          placeholder="symbol (e.g. BTCUSDT)"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          className="bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm flex-1"
        />
        {def.addTypeOptions.length > 1 && (
          <select
            value={addType}
            onChange={(e) => setAddType(e.target.value as AssetType)}
            className="bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
          >
            {def.addTypeOptions.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        )}
        <button
          type="button"
          disabled={!symbol || addMut.isPending}
          onClick={() => addMut.mutate({ symbol, type: addType })}
          className="pixel-font text-[10px] border-2 border-neon-cyan text-neon-cyan px-3 py-1 disabled:opacity-40"
        >
          {addMut.isPending ? '…' : 'add'}
        </button>
      </div>
    </section>
  );
}

export function WatchlistManager() {
  return (
    <div className="flex flex-col gap-6">
      {SECTIONS.map((def) => (
        <Section key={def.title} def={def} />
      ))}
    </div>
  );
}
