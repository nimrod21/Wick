'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AlertCondition, AlertChannel, AlertRule } from '@cockpit/shared';
import { requestPermission, getPermission } from '@/lib/notifications';

// ── Types ─────────────────────────────────────────────────────────────

interface Asset {
  id: number;
  symbol: string;
  displayName: string | null;
  type: string;
  enabled: boolean;
}

type ConditionType = AlertCondition['type'];
type PriceMove = Extract<AlertCondition, { type: 'price_move' }>;
type PriceLevel = Extract<AlertCondition, { type: 'price_level' }>;
type WhaleTx = Extract<AlertCondition, { type: 'whale_tx' }>;
type NewsCond = Extract<AlertCondition, { type: 'news' }>;
type IndicatorLevel = Extract<AlertCondition, { type: 'indicator_level' }>;
type IndicatorCross = Extract<AlertCondition, { type: 'indicator_cross' }>;
type ProbabilityCond = Extract<AlertCondition, { type: 'probability' }>;

interface RuleBuilderProps {
  mode: 'new' | 'edit';
  ruleId: number | null;
  onClose: () => void;
}

// ── Defaults ──────────────────────────────────────────────────────────

const WINDOW_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '5m', value: 300 },
  { label: '15m', value: 900 },
  { label: '1h', value: 3600 },
  { label: '4h', value: 14400 },
];

const INDICATOR_SUGGESTIONS = [
  'fng_crypto',
  'dxy',
  'vix',
  'btc_dominance',
  'funding_rate',
  'open_interest',
] as const;

function defaultCondition(type: ConditionType, firstAssetId: number | null): AlertCondition {
  const asset = firstAssetId ?? 1;
  switch (type) {
    case 'price_move':
      return { type, assetId: asset, pctChange: 5, windowSeconds: 3600, direction: 'either' };
    case 'price_level':
      return { type, assetId: asset, operator: '>', value: 0 };
    case 'whale_tx':
      return { type, chain: 'eth', minUsd: 1_000_000, direction: 'either' };
    case 'news':
      return { type, keywordsAny: [], keywordsAll: [], tickers: [], minSentimentAbs: 0 };
    case 'indicator_level':
      return { type, name: 'fng_crypto', operator: '<', value: 30 };
    case 'indicator_cross':
      return { type, name: 'vix', direction: 'up', threshold: 30 };
    case 'probability':
      return { type, assetId: asset, horizon: '4h', operator: '>', value: 0.7 };
  }
}

// ── Component ─────────────────────────────────────────────────────────

interface AssetsResponse {
  assets: Asset[];
}

export function RuleBuilder({ mode, ruleId, onClose }: RuleBuilderProps) {
  const qc = useQueryClient();

  const assetsQuery = useQuery<AssetsResponse>({
    queryKey: ['assets', 'all'],
    queryFn: () => api.get<AssetsResponse>('/api/assets'),
    staleTime: 60_000,
  });
  const assets = assetsQuery.data?.assets ?? [];
  const firstAssetId = assets[0]?.id ?? null;

  const existingQuery = useQuery<{ rule: AlertRule }>({
    queryKey: ['alerts', ruleId],
    queryFn: () => api.get<{ rule: AlertRule }>(`/api/alerts/${ruleId}`),
    enabled: mode === 'edit' && ruleId !== null,
  });
  const existing = existingQuery.data?.rule;

  const [name, setName] = useState('');
  const [condition, setCondition] = useState<AlertCondition>(
    () => defaultCondition('price_move', null),
  );
  const [channels, setChannels] = useState<AlertChannel[]>(['browser']);
  const [cooldownSeconds, setCooldownSeconds] = useState<number>(300);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>('default');

  useEffect(() => {
    setNotifPermission(getPermission());
  }, []);

  // Hydrate when editing
  useEffect(() => {
    if (mode === 'edit' && existing) {
      setName(existing.name);
      setCondition(existing.condition);
      setChannels(existing.channels.length ? existing.channels : ['browser']);
      setCooldownSeconds(existing.cooldownSeconds);
    }
  }, [mode, existing]);

  // Initialise default condition once assets load (new mode only).
  useEffect(() => {
    if (mode !== 'new') return;
    if (firstAssetId === null) return;
    setCondition((prev) => {
      if (prev.type === 'price_move' || prev.type === 'price_level' || prev.type === 'probability') {
        if (prev.assetId === 0 || prev.assetId === 1) {
          return { ...prev, assetId: firstAssetId } as AlertCondition;
        }
      }
      return prev;
    });
  }, [firstAssetId, mode]);

  // ESC to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const createMut = useMutation({
    mutationFn: (body: unknown) => api.post<{ ok: boolean }>('/api/alerts', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      onClose();
    },
  });

  // `api` only exposes GET/POST/PUT/DELETE — the server speaks PATCH for
  // rule updates, so we wire a dedicated mutation here.
  const patchMut = useMutation({
    mutationFn: async (body: unknown) => {
      const res = await fetch(`/api/alerts/${ruleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      onClose();
    },
  });

  const submit = () => {
    const body = { name, condition, channels, cooldownSeconds };
    if (mode === 'new') {
      createMut.mutate(body);
    } else if (ruleId !== null) {
      patchMut.mutate(body);
    }
  };

  const isPending = createMut.isPending || patchMut.isPending;

  // ── Type switcher ───────────────────────────────────────────────
  const setType = (type: ConditionType) => {
    setCondition(defaultCondition(type, firstAssetId));
  };

  const toggleChannel = (ch: AlertChannel) => {
    setChannels((prev) => {
      if (prev.includes(ch)) {
        const next = prev.filter((c) => c !== ch);
        return next.length ? next : prev; // always keep at least one
      }
      return [...prev, ch];
    });
  };

  const askBrowserPermission = async () => {
    const p = await requestPermission();
    setNotifPermission(p);
  };

  return (
    <>
      <div className="fixed inset-0 bg-bg-void/70 z-40" onClick={onClose} />
      <div
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(560px,95vw)] max-h-[90vh] overflow-y-auto bg-bg-terminal border-2 border-neon-cyan shadow-[0_0_24px_var(--neon-cyan)] z-50"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-dim">
          <h2 className="pixel-font text-[11px] text-neon-cyan glow uppercase">
            {mode === 'new' ? 'New Alert Rule' : 'Edit Alert Rule'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="pixel-font text-[9px] px-2 py-1 border-2 border-border-dim text-text-secondary hover:border-neon-red hover:text-neon-red"
          >
            CLOSE
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4">
          {/* Name */}
          <Field label="NAME">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="BTC 5% drop 1h"
              className="w-full bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
            />
          </Field>

          {/* Condition type */}
          <Field label="CONDITION TYPE">
            <select
              value={condition.type}
              onChange={(e) => setType(e.target.value as ConditionType)}
              className="w-full bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
            >
              <option value="price_move">price_move</option>
              <option value="price_level">price_level</option>
              <option value="whale_tx">whale_tx</option>
              <option value="news">news</option>
              <option value="indicator_level">indicator_level</option>
              <option value="indicator_cross">indicator_cross</option>
              <option value="probability">probability</option>
            </select>
          </Field>

          {/* Per-type sub-form */}
          <div className="border border-border-dim p-3 flex flex-col gap-3">
            <SubForm
              condition={condition}
              onChange={setCondition}
              assets={assets}
            />
          </div>

          {/* Channels */}
          <Field label="CHANNELS">
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={channels.includes('browser')}
                  onChange={() => toggleChannel('browser')}
                />
                <span className="pixel-font text-[9px]">BROWSER</span>
                {notifPermission === 'granted' ? (
                  <span className="pixel-font text-[8px] text-neon-green">PERMISSION OK</span>
                ) : notifPermission === 'denied' ? (
                  <span className="pixel-font text-[8px] text-neon-red">DENIED</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void askBrowserPermission()}
                    className="pixel-font text-[8px] px-2 py-0.5 border border-neon-amber text-neon-amber"
                  >
                    ENABLE
                  </button>
                )}
              </label>
              <label className="flex items-center gap-2 text-xs text-text-dim">
                <input
                  type="checkbox"
                  checked={channels.includes('telegram')}
                  disabled
                  readOnly
                />
                <span className="pixel-font text-[9px]">TELEGRAM</span>
                <span className="pixel-font text-[8px] text-text-dim">(TODO: Phase 8.5)</span>
              </label>
            </div>
          </Field>

          {/* Cooldown */}
          <Field label="COOLDOWN (SECONDS)">
            <input
              type="number"
              value={cooldownSeconds}
              min={0}
              onChange={(e) => setCooldownSeconds(Number(e.target.value))}
              className="w-32 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
            />
          </Field>

          {/* Submit */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-dim">
            <button
              type="button"
              onClick={onClose}
              className="pixel-font text-[10px] px-3 py-1 border-2 border-border-dim text-text-secondary"
            >
              CANCEL
            </button>
            <button
              type="button"
              disabled={!name.trim() || isPending}
              onClick={submit}
              className="pixel-font text-[10px] px-3 py-1 border-2 border-neon-cyan text-neon-cyan disabled:opacity-40"
            >
              {isPending ? 'SAVING…' : mode === 'new' ? 'CREATE' : 'SAVE'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="pixel-font text-[9px] text-text-secondary uppercase">{label}</label>
      {children}
    </div>
  );
}

function SubForm({
  condition,
  onChange,
  assets,
}: {
  condition: AlertCondition;
  onChange: (c: AlertCondition) => void;
  assets: Asset[];
}) {
  switch (condition.type) {
    case 'price_move':
      return <PriceMoveForm c={condition} onChange={onChange} assets={assets} />;
    case 'price_level':
      return <PriceLevelForm c={condition} onChange={onChange} assets={assets} />;
    case 'whale_tx':
      return <WhaleTxForm c={condition} onChange={onChange} />;
    case 'news':
      return <NewsForm c={condition} onChange={onChange} />;
    case 'indicator_level':
      return <IndicatorLevelForm c={condition} onChange={onChange} />;
    case 'indicator_cross':
      return <IndicatorCrossForm c={condition} onChange={onChange} />;
    case 'probability':
      return <ProbabilityForm c={condition} onChange={onChange} assets={assets} />;
  }
}

function AssetSelect({
  value,
  onChange,
  assets,
}: {
  value: number;
  onChange: (id: number) => void;
  assets: Asset[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
    >
      {assets.length === 0 && <option value={0}>loading…</option>}
      {assets.map((a) => (
        <option key={a.id} value={a.id}>
          {a.symbol} — {a.displayName ?? a.symbol}
        </option>
      ))}
    </select>
  );
}

function PriceMoveForm({
  c,
  onChange,
  assets,
}: {
  c: PriceMove;
  onChange: (c: AlertCondition) => void;
  assets: Asset[];
}) {
  return (
    <>
      <Field label="ASSET">
        <AssetSelect value={c.assetId} onChange={(id) => onChange({ ...c, assetId: id })} assets={assets} />
      </Field>
      <Field label="% CHANGE">
        <input
          type="number"
          step="0.1"
          value={c.pctChange}
          onChange={(e) => onChange({ ...c, pctChange: Number(e.target.value) })}
          className="w-32 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        />
      </Field>
      <Field label="WINDOW">
        <select
          value={c.windowSeconds}
          onChange={(e) => onChange({ ...c, windowSeconds: Number(e.target.value) })}
          className="w-32 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        >
          {WINDOW_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="DIRECTION">
        <select
          value={c.direction}
          onChange={(e) => onChange({ ...c, direction: e.target.value as PriceMove['direction'] })}
          className="w-32 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        >
          <option value="up">up</option>
          <option value="down">down</option>
          <option value="either">either</option>
        </select>
      </Field>
    </>
  );
}

function PriceLevelForm({
  c,
  onChange,
  assets,
}: {
  c: PriceLevel;
  onChange: (c: AlertCondition) => void;
  assets: Asset[];
}) {
  return (
    <>
      <Field label="ASSET">
        <AssetSelect value={c.assetId} onChange={(id) => onChange({ ...c, assetId: id })} assets={assets} />
      </Field>
      <Field label="OPERATOR">
        <select
          value={c.operator}
          onChange={(e) => onChange({ ...c, operator: e.target.value as PriceLevel['operator'] })}
          className="w-32 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        >
          <option value=">">{'>'}</option>
          <option value="<">{'<'}</option>
          <option value=">=">{'>='}</option>
          <option value="<=">{'<='}</option>
        </select>
      </Field>
      <Field label="VALUE">
        <input
          type="number"
          step="any"
          value={c.value}
          onChange={(e) => onChange({ ...c, value: Number(e.target.value) })}
          className="w-40 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        />
      </Field>
    </>
  );
}

function WhaleTxForm({ c, onChange }: { c: WhaleTx; onChange: (c: AlertCondition) => void }) {
  return (
    <>
      <Field label="CHAIN">
        <select
          value={c.chain ?? 'all'}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'all') {
              const { chain: _chain, ...rest } = c;
              void _chain;
              onChange({ ...rest, type: 'whale_tx' } as AlertCondition);
            } else {
              onChange({ ...c, chain: v as 'eth' | 'sol' | 'btc' });
            }
          }}
          className="w-32 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        >
          <option value="all">all</option>
          <option value="eth">eth</option>
          <option value="sol">sol</option>
          <option value="btc">btc</option>
        </select>
      </Field>
      <Field label="MIN USD">
        <input
          type="number"
          step="1000"
          value={c.minUsd}
          onChange={(e) => onChange({ ...c, minUsd: Number(e.target.value) })}
          className="w-40 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        />
      </Field>
      <Field label="DIRECTION">
        <select
          value={c.direction ?? 'either'}
          onChange={(e) => onChange({ ...c, direction: e.target.value as WhaleTx['direction'] })}
          className="w-32 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        >
          <option value="in">in</option>
          <option value="out">out</option>
          <option value="either">either</option>
        </select>
      </Field>
    </>
  );
}

function CsvInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string[] | undefined;
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState<string>((value ?? []).join(', '));
  useEffect(() => {
    setText((value ?? []).join(', '));
  }, [value]);
  return (
    <Field label={label}>
      <input
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const parts = text
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          onChange(parts);
        }}
        className="w-full bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
      />
    </Field>
  );
}

function NewsForm({ c, onChange }: { c: NewsCond; onChange: (c: AlertCondition) => void }) {
  return (
    <>
      <CsvInput
        label="KEYWORDS ANY (comma-sep)"
        value={c.keywordsAny}
        onChange={(v) => onChange({ ...c, keywordsAny: v })}
        placeholder="hack, exploit, halt"
      />
      <CsvInput
        label="KEYWORDS ALL"
        value={c.keywordsAll}
        onChange={(v) => onChange({ ...c, keywordsAll: v })}
        placeholder="sec, approved"
      />
      <CsvInput
        label="TICKERS"
        value={c.tickers}
        onChange={(v) => onChange({ ...c, tickers: v.map((s) => s.toUpperCase()) })}
        placeholder="BTC, ETH"
      />
      <Field label="MIN |SENTIMENT| (0..1)">
        <input
          type="number"
          step="0.05"
          min="0"
          max="1"
          value={c.minSentimentAbs ?? 0}
          onChange={(e) => onChange({ ...c, minSentimentAbs: Number(e.target.value) })}
          className="w-32 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        />
      </Field>
    </>
  );
}

function IndicatorNameInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-2 items-center">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
      />
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value);
        }}
        className="bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
      >
        <option value="">preset…</option>
        {INDICATOR_SUGGESTIONS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </div>
  );
}

function IndicatorLevelForm({
  c,
  onChange,
}: {
  c: IndicatorLevel;
  onChange: (c: AlertCondition) => void;
}) {
  return (
    <>
      <Field label="NAME">
        <IndicatorNameInput value={c.name} onChange={(v) => onChange({ ...c, name: v })} />
      </Field>
      <Field label="OPERATOR">
        <select
          value={c.operator}
          onChange={(e) => onChange({ ...c, operator: e.target.value as IndicatorLevel['operator'] })}
          className="w-32 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        >
          <option value=">">{'>'}</option>
          <option value="<">{'<'}</option>
        </select>
      </Field>
      <Field label="VALUE">
        <input
          type="number"
          step="any"
          value={c.value}
          onChange={(e) => onChange({ ...c, value: Number(e.target.value) })}
          className="w-40 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        />
      </Field>
    </>
  );
}

function IndicatorCrossForm({
  c,
  onChange,
}: {
  c: IndicatorCross;
  onChange: (c: AlertCondition) => void;
}) {
  return (
    <>
      <Field label="NAME">
        <IndicatorNameInput value={c.name} onChange={(v) => onChange({ ...c, name: v })} />
      </Field>
      <Field label="DIRECTION">
        <select
          value={c.direction}
          onChange={(e) => onChange({ ...c, direction: e.target.value as IndicatorCross['direction'] })}
          className="w-32 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        >
          <option value="up">up</option>
          <option value="down">down</option>
        </select>
      </Field>
      <Field label="THRESHOLD">
        <input
          type="number"
          step="any"
          value={c.threshold}
          onChange={(e) => onChange({ ...c, threshold: Number(e.target.value) })}
          className="w-40 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        />
      </Field>
    </>
  );
}

function ProbabilityForm({
  c,
  onChange,
  assets,
}: {
  c: ProbabilityCond;
  onChange: (c: AlertCondition) => void;
  assets: Asset[];
}) {
  return (
    <>
      <Field label="ASSET">
        <AssetSelect value={c.assetId} onChange={(id) => onChange({ ...c, assetId: id })} assets={assets} />
      </Field>
      <Field label="HORIZON">
        <select
          value={c.horizon}
          onChange={(e) => onChange({ ...c, horizon: e.target.value as ProbabilityCond['horizon'] })}
          className="w-32 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        >
          <option value="1h">1h</option>
          <option value="4h">4h</option>
          <option value="24h">24h</option>
        </select>
      </Field>
      <Field label="OPERATOR">
        <select
          value={c.operator}
          onChange={(e) => onChange({ ...c, operator: e.target.value as ProbabilityCond['operator'] })}
          className="w-32 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        >
          <option value=">">{'>'}</option>
          <option value="<">{'<'}</option>
        </select>
      </Field>
      <Field label="VALUE (0..1)">
        <input
          type="number"
          step="0.05"
          min="0"
          max="1"
          value={c.value}
          onChange={(e) => onChange({ ...c, value: Number(e.target.value) })}
          className="w-40 bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm"
        />
      </Field>
    </>
  );
}

export default RuleBuilder;
