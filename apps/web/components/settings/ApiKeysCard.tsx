'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

type KeyStatus = 'connected' | 'missing' | 'invalid';

interface KeyEntry {
  service: string;
  status: KeyStatus;
  masked: string | null;
}

interface ServiceMeta {
  service: string;
  label: string;
  needsSecret: boolean;
  signupUrl: string;
}

// Signup URLs pulled from PLAN.md §9.
const SERVICES: ReadonlyArray<ServiceMeta> = [
  { service: 'binance',     label: 'Binance',      needsSecret: true,  signupUrl: 'https://binance.com/en/my/settings/api-management' },
  { service: 'twelvedata',  label: 'Twelve Data',  needsSecret: false, signupUrl: 'https://twelvedata.com/register' },
  { service: 'finnhub',     label: 'Finnhub',      needsSecret: false, signupUrl: 'https://finnhub.io/register' },
  { service: 'etherscan',   label: 'Etherscan',    needsSecret: false, signupUrl: 'https://etherscan.io/register' },
  { service: 'helius',      label: 'Helius',       needsSecret: false, signupUrl: 'https://helius.dev' },
  { service: 'cryptopanic', label: 'CryptoPanic',  needsSecret: false, signupUrl: 'https://cryptopanic.com/developers/api' },
  { service: 'fred',        label: 'FRED',         needsSecret: false, signupUrl: 'https://fred.stlouisfed.org/docs/api/api_key.html' },
  { service: 'alpaca',      label: 'Alpaca Paper', needsSecret: true,  signupUrl: 'https://alpaca.markets/paper' },
];

const STATUS_COLOR: Record<KeyStatus, string> = {
  connected: 'text-neon-cyan border-neon-cyan',
  missing:   'text-neon-amber border-neon-amber',
  invalid:   'text-neon-red border-neon-red',
};

function StatusBadge({ status }: { status: KeyStatus }) {
  return (
    <span
      className={`pixel-font text-[9px] uppercase border-2 px-2 py-1 ${STATUS_COLOR[status]}`}
    >
      {status}
    </span>
  );
}

function ServiceRow({ meta, entry }: { meta: ServiceMeta; entry: KeyEntry }) {
  const qc = useQueryClient();
  const [keyInput, setKeyInput]       = useState('');
  const [secretInput, setSecretInput] = useState('');
  const [toast, setToast]             = useState<string | null>(null);

  const saveMut = useMutation({
    mutationFn: (payload: { key: string; secret?: string }) =>
      api.put<{ ok: true }>(`/api/settings/keys/${meta.service}`, payload),
    onSuccess: () => {
      setKeyInput('');
      setSecretInput('');
      setToast('Saved');
      void qc.invalidateQueries({ queryKey: ['settings', 'keys'] });
    },
    onError: (err) => setToast(`Save failed: ${(err as Error).message}`),
  });

  const testMut = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; detail?: string }>(`/api/settings/keys/${meta.service}/test`, {}),
    onSuccess: (res) => setToast(res.ok ? 'Test OK' : `Test failed: ${res.detail ?? 'unknown'}`),
    onError: (err) => setToast(`Test error: ${(err as Error).message}`),
  });

  const canSave = meta.needsSecret ? keyInput.length > 0 && secretInput.length > 0 : keyInput.length > 0;

  return (
    <div className="border border-border-dim bg-bg-terminal p-3 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="mono-pixel-font text-neon-cyan text-xl" style={{ fontFamily: 'VT323, monospace' }}>
          {meta.label}
        </span>
        <StatusBadge status={entry.status} />
        <span className="text-text-dim text-xs ml-auto">{entry.masked ?? '—'}</span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="password"
          placeholder="API key"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          className="bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm flex-1 min-w-[160px]"
        />
        {meta.needsSecret && (
          <input
            type="password"
            placeholder="API secret"
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            className="bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm flex-1 min-w-[160px]"
          />
        )}
        <button
          type="button"
          disabled={!canSave || saveMut.isPending}
          onClick={() =>
            saveMut.mutate(meta.needsSecret ? { key: keyInput, secret: secretInput } : { key: keyInput })
          }
          className="pixel-font text-[10px] border-2 border-neon-cyan text-neon-cyan px-3 py-1 disabled:opacity-40"
        >
          {saveMut.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          disabled={entry.status === 'missing' || testMut.isPending}
          onClick={() => testMut.mutate()}
          className="pixel-font text-[10px] border-2 border-neon-magenta text-neon-magenta px-3 py-1 disabled:opacity-40"
        >
          {testMut.isPending ? 'Testing…' : 'Test'}
        </button>
        <a
          href={meta.signupUrl}
          target="_blank"
          rel="noreferrer"
          className="pixel-font text-[10px] text-text-secondary hover:text-neon-cyan underline"
        >
          signup
        </a>
      </div>

      {toast && <div className="text-xs text-text-secondary">{toast}</div>}
    </div>
  );
}

interface ServerKeyRow {
  service: string;
  present: boolean;
  masked: string | null;
  addedAt: number | null;
}

export function ApiKeysCard() {
  const { data, isLoading, error } = useQuery<{ services: ServerKeyRow[] }>({
    queryKey: ['settings', 'keys'],
    queryFn: () => api.get<{ services: ServerKeyRow[] }>('/api/settings/keys'),
  });

  const byService = useMemo(() => {
    const m = new Map<string, KeyEntry>();
    (data?.services ?? []).forEach((k) => {
      m.set(k.service, {
        service: k.service,
        status: k.present ? 'connected' : 'missing',
        masked: k.masked,
      });
    });
    return m;
  }, [data]);

  if (isLoading) return <div className="text-text-dim">Loading keys…</div>;
  if (error)     return <div className="text-neon-red">Failed to load keys: {(error as Error).message}</div>;

  return (
    <div className="flex flex-col gap-3">
      {SERVICES.map((meta) => {
        const entry = byService.get(meta.service) ?? { service: meta.service, status: 'missing' as const, masked: null };
        return <ServiceRow key={meta.service} meta={meta} entry={entry} />;
      })}
    </div>
  );
}
