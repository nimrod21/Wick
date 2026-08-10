'use client';

/**
 * `[+ New bot]` card (IMPL-1). Collapsed it is an empty dashed frame; expanded
 * it is the create form — name, bankroll, personality, provider order, cadence,
 * symbols. Validation mirrors the server's `createSchema`/`configSchema` in
 * api/bots.ts so a typo never reaches the DB.
 *
 * Provider order is picked as a *primary* provider from /api/providers; the
 * rest keep registry order behind it. Full reordering already exists on the
 * bot detail page's config drawer, so this stays one dropdown.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api, TIMEFRAMES } from '@/lib/api';
import { Btn } from '@/components/ui';

const FormSchema = z.object({
  name: z.string().min(1, 'name is required').max(60),
  bankroll: z.number().positive('bankroll must be positive').max(10_000_000),
  personality: z.string().max(500),
  cadence_tf: z.enum(TIMEFRAMES),
  symbols: z.array(z.string().min(1)).min(1, 'at least one symbol'),
  provider_order: z.array(z.string().min(1)),
});

export function NewBotCard() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers, enabled: open });
  const assets = useQuery({ queryKey: ['assets'], queryFn: api.assets, enabled: open });

  const [form, setForm] = useState({
    name: '',
    bankroll: '1000',
    personality: '',
    cadence_tf: '1h',
    symbols: '',
    primaryProvider: '',
  });
  const set = (key: keyof typeof form, value: string): void =>
    setForm((f) => ({ ...f, [key]: value }));

  // Symbols default to the whole active watchlist; providers to registry order.
  const defaultSymbols = (assets.data ?? []).filter((a) => a.active).map((a) => a.symbol);
  const providerIds = (providers.data ?? []).map((p) => p.id);
  const symbolsValue = form.symbols || defaultSymbols.join(', ');

  const create = useMutation({
    mutationFn: async () => {
      const symbols = symbolsValue.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      const primary = form.primaryProvider;
      const order = primary
        ? [primary, ...providerIds.filter((p) => p !== primary)]
        : providerIds;
      const parsed = FormSchema.safeParse({
        name: form.name.trim(),
        bankroll: Number(form.bankroll),
        personality: form.personality.trim(),
        cadence_tf: form.cadence_tf,
        symbols,
        provider_order: order,
      });
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · '));
      }
      const { name, bankroll, ...config } = parsed.data;
      return api.createBot({
        name,
        bankroll,
        // An empty personality/provider list means "use the server defaults".
        config: {
          cadence_tf: config.cadence_tf,
          symbols: config.symbols,
          ...(config.personality ? { personality: config.personality } : {}),
          ...(config.provider_order.length > 0 ? { provider_order: config.provider_order } : {}),
        },
      });
    },
    onSuccess: () => {
      setErrors([]);
      setOpen(false);
      setForm((f) => ({ ...f, name: '', personality: '', symbols: '', primaryProvider: '' }));
      void qc.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: (e: Error) => setErrors([e.message]),
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="panel flex min-h-[180px] w-full items-center justify-center border-dashed text-xs uppercase tracking-wider text-muted hover:border-cyan hover:text-cyan"
      >
        + new bot
      </button>
    );
  }

  return (
    <div className="panel space-y-3 p-3 text-xs">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] uppercase tracking-wider text-muted">new bot</h2>
        <Btn onClick={() => setOpen(false)}>close</Btn>
      </div>

      {errors.length > 0 && (
        <ul className="border border-red p-2 text-red">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <Field label="name">
        <input className="w-full" value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
      </Field>

      <Field label="bankroll ($)">
        <input
          type="number"
          min="1"
          step="100"
          className="w-full"
          value={form.bankroll}
          onChange={(e) => set('bankroll', e.target.value)}
        />
      </Field>

      <Field label="personality">
        <textarea
          className="h-20 w-full"
          placeholder="e.g. Patient trend-follower — only acts when trend, momentum and volume agree."
          value={form.personality}
          onChange={(e) => set('personality', e.target.value)}
        />
      </Field>

      <Field label="primary provider">
        <select
          className="w-full"
          value={form.primaryProvider}
          onChange={(e) => set('primaryProvider', e.target.value)}
        >
          <option value="">registry order ({providerIds.length} providers)</option>
          {(providers.data ?? []).map((p) => (
            <option key={p.id} value={p.id} disabled={!p.enabled}>
              {p.id}
              {p.hasKey ? '' : ' (no key)'}
            </option>
          ))}
        </select>
      </Field>

      <Field label="cadence">
        <select
          className="w-full"
          value={form.cadence_tf}
          onChange={(e) => set('cadence_tf', e.target.value)}
        >
          {TIMEFRAMES.map((tf) => (
            <option key={tf} value={tf}>
              {tf}
            </option>
          ))}
        </select>
      </Field>

      <Field label="symbols (comma separated — defaults to the watchlist)">
        <input className="w-full" value={symbolsValue} onChange={(e) => set('symbols', e.target.value)} />
      </Field>

      <div className="flex gap-2 pt-1">
        <Btn tone="go" onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? 'creating…' : 'create bot'}
        </Btn>
        <Btn onClick={() => setOpen(false)}>cancel</Btn>
      </div>
      <p className="text-[10px] text-muted">created stopped — press start on its card when ready</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted">{label}</span>
      {children}
    </label>
  );
}
