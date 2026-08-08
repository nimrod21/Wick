'use client';

/**
 * Provider panel (task 6.6): masked vault-backed key, enabled toggle,
 * rpm/rpd, today's usage bar (from `llm_usage`), and a one-call test button.
 *
 * enabled/rpm/rpd/models live in the `providers.registry` settings row, so
 * they are edited as a whole-array PUT — the server treats that row as data.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ProviderStatus, type ProviderTestResult } from '@/lib/api';
import { Btn, Empty, Panel, UsageBar } from '@/components/ui';

const REGISTRY_KEY = 'providers.registry';

interface RegistryRow {
  id: string;
  baseUrl?: string;
  models?: string[];
  rpm?: number;
  rpd?: number;
  enabled?: boolean;
}

export function ProvidersPanel() {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers, refetchInterval: 30_000 });
  const keys = useQuery({ queryKey: ['provider-keys'], queryFn: api.providerKeys });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [tests, setTests] = useState<Record<string, ProviderTestResult | 'running'>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['providers'] });
    void qc.invalidateQueries({ queryKey: ['provider-keys'] });
    void qc.invalidateQueries({ queryKey: ['settings'] });
  };

  const saveRegistry = useMutation({
    mutationFn: (rows: RegistryRow[]) => api.putSetting(REGISTRY_KEY, JSON.stringify(rows)),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });

  const setKey = useMutation({
    mutationFn: ({ provider, key }: { provider: string; key: string }) => api.setProviderKey(provider, key),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });

  const clearKey = useMutation({
    mutationFn: (provider: string) => api.deleteProviderKey(provider),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });

  const registry: RegistryRow[] = (() => {
    const raw = settings.data?.find((s) => s.key === REGISTRY_KEY)?.value;
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as RegistryRow[]) : [];
    } catch {
      return [];
    }
  })();

  const patchRegistry = (id: string, patch: Partial<RegistryRow>): void => {
    if (registry.length === 0) return;
    saveRegistry.mutate(registry.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const runTest = async (id: string): Promise<void> => {
    setTests((t) => ({ ...t, [id]: 'running' }));
    try {
      const res = await api.testProvider(id);
      setTests((t) => ({ ...t, [id]: res }));
      void qc.invalidateQueries({ queryKey: ['providers'] });
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, error: (e as Error).message } }));
    }
  };

  return (
    <Panel title="LLM providers" bodyClassName="p-0">
      {error && <p className="border-b border-line px-3 py-2 text-xs text-red">{error}</p>}
      {providers.isLoading && <Empty>loading providers…</Empty>}
      {(providers.data ?? []).map((p) => (
        <ProviderRow
          key={p.id}
          provider={p}
          masked={keys.data?.find((k) => k.provider === p.id)?.masked ?? null}
          test={tests[p.id]}
          onTest={() => void runTest(p.id)}
          onSaveKey={(key) => setKey.mutate({ provider: p.id, key })}
          onClearKey={() => clearKey.mutate(p.id)}
          onPatch={(patch) => patchRegistry(p.id, patch)}
        />
      ))}
    </Panel>
  );
}

function ProviderRow({
  provider,
  masked,
  test,
  onTest,
  onSaveKey,
  onClearKey,
  onPatch,
}: {
  provider: ProviderStatus;
  masked: string | null;
  test: ProviderTestResult | 'running' | undefined;
  onTest: () => void;
  onSaveKey: (key: string) => void;
  onClearKey: () => void;
  onPatch: (patch: Partial<RegistryRow>) => void;
}) {
  const [key, setKeyInput] = useState('');
  const [rpm, setRpm] = useState(String(provider.rpm));
  const [rpd, setRpd] = useState(String(provider.rpd));

  return (
    <div className="border-b border-line p-3 last:border-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-24 text-sm">{provider.id}</span>
        <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
          <input
            type="checkbox"
            checked={provider.enabled}
            onChange={(e) => onPatch({ enabled: e.target.checked })}
            className="h-3 w-3 p-0"
          />
          enabled
        </label>
        <span className="text-[10px] uppercase tracking-wider text-muted">
          key{' '}
          <span className={provider.hasKey ? 'text-green' : 'text-muted'}>{masked ?? (provider.hasKey ? 'set' : 'none')}</span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <UsageBar used={provider.calls} limit={provider.rpd} />
          {provider.errors > 0 && <span className="tnum text-[10px] text-red">{provider.errors} err</span>}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <input
          type="password"
          placeholder={provider.hasKey ? 'replace key…' : 'paste api key…'}
          value={key}
          onChange={(e) => setKeyInput(e.target.value)}
          className="w-56 py-0.5"
          autoComplete="off"
        />
        <Btn
          onClick={() => {
            if (key.trim().length === 0) return;
            onSaveKey(key.trim());
            setKeyInput('');
          }}
          disabled={key.trim().length === 0}
        >
          save key
        </Btn>
        {provider.hasKey && (
          <Btn tone="danger" onClick={onClearKey}>
            clear
          </Btn>
        )}

        <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
          rpm
          <input
            className="w-16 py-0.5 text-xs"
            value={rpm}
            onChange={(e) => setRpm(e.target.value)}
            onBlur={() => Number(rpm) > 0 && Number(rpm) !== provider.rpm && onPatch({ rpm: Number(rpm) })}
          />
        </label>
        <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
          rpd
          <input
            className="w-20 py-0.5 text-xs"
            value={rpd}
            onChange={(e) => setRpd(e.target.value)}
            onBlur={() => Number(rpd) > 0 && Number(rpd) !== provider.rpd && onPatch({ rpd: Number(rpd) })}
          />
        </label>

        <Btn onClick={onTest} disabled={test === 'running'}>
          {test === 'running' ? 'testing…' : 'test'}
        </Btn>
        {test && test !== 'running' && (
          <span className={`text-[11px] ${test.ok ? 'text-green' : 'text-red'}`}>
            {test.ok ? `${test.model} · ${test.latencyMs}ms` : test.error}
          </span>
        )}
      </div>

      <div className="mt-1 truncate text-[10px] text-muted" title={provider.models.join(', ')}>
        {provider.models.length > 0 ? provider.models.join(', ') : 'no model configured'} · {provider.baseUrl}
      </div>
    </div>
  );
}
