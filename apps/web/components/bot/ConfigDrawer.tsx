'use client';

/**
 * Bot config editor (task 6.4) — a drawer over the `config_json` fields,
 * zod-validated client-side before the PATCH so a typo never reaches the
 * guards. The schema mirrors the server's `configSchema` in api/bots.ts.
 */

import { useState } from 'react';
import { z } from 'zod';
import type { Bot, BotConfig } from '@/lib/api';
import { Btn } from '@/components/ui';

const ConfigFormSchema = z.object({
  cadence_tf: z.enum(['1m', '15m', '1h', '4h', '1d']),
  symbols: z.array(z.string().min(1)).min(1, 'at least one symbol'),
  provider_order: z.array(z.string().min(1)),
  personality: z.string().max(500),
  min_confidence: z.number().min(0).max(100),
  max_trades_day: z.number().int().min(0).max(100),
  cooldown_min: z.number().min(0),
  min_hold_min: z.number().min(0),
  max_pos_pct: z.number().min(1).max(100),
  drawdown_kill_pct: z.number().min(1).max(100),
  default_sl_pct: z.number().min(-15).max(-1),
  default_tp_pct: z.number().min(2).max(50),
  review_days: z.number().int().min(0).max(365),
});
export type ConfigForm = z.infer<typeof ConfigFormSchema>;

const NUMERIC_FIELDS: Array<{ key: keyof ConfigForm; label: string; step?: string }> = [
  { key: 'min_confidence', label: 'min confidence' },
  { key: 'max_trades_day', label: 'max trades / day' },
  { key: 'cooldown_min', label: 'cooldown (min)' },
  { key: 'min_hold_min', label: 'min hold (min)' },
  { key: 'max_pos_pct', label: 'max position %' },
  { key: 'drawdown_kill_pct', label: 'drawdown kill %' },
  { key: 'default_sl_pct', label: 'default SL %', step: '0.5' },
  { key: 'default_tp_pct', label: 'default TP %', step: '0.5' },
  // IMPL-7: days between his indicator portfolio reviews. 0 = follow the
  // global `review.config` cadence (weekly).
  { key: 'review_days', label: 'review every (days, 0=default)' },
];

export function ConfigDrawer({
  bot,
  onClose,
  onSave,
}: {
  bot: Bot;
  onClose: () => void;
  onSave: (patch: Partial<BotConfig>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    cadence_tf: bot.config.cadence_tf,
    symbols: bot.config.symbols.join(', '),
    provider_order: bot.config.provider_order.join(', '),
    personality: bot.config.personality,
    min_confidence: String(bot.config.min_confidence),
    max_trades_day: String(bot.config.max_trades_day),
    cooldown_min: String(bot.config.cooldown_min),
    min_hold_min: String(bot.config.min_hold_min),
    max_pos_pct: String(bot.config.max_pos_pct),
    drawdown_kill_pct: String(bot.config.drawdown_kill_pct),
    default_sl_pct: String(bot.config.default_sl_pct),
    default_tp_pct: String(bot.config.default_tp_pct),
    review_days: String(bot.config.review_days),
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof form, value: string): void =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async (): Promise<void> => {
    const candidate = {
      cadence_tf: form.cadence_tf,
      symbols: form.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
      provider_order: form.provider_order.split(',').map((s) => s.trim()).filter(Boolean),
      personality: form.personality,
      min_confidence: Number(form.min_confidence),
      max_trades_day: Number(form.max_trades_day),
      cooldown_min: Number(form.cooldown_min),
      min_hold_min: Number(form.min_hold_min),
      max_pos_pct: Number(form.max_pos_pct),
      drawdown_kill_pct: Number(form.drawdown_kill_pct),
      default_sl_pct: Number(form.default_sl_pct),
      default_tp_pct: Number(form.default_tp_pct),
      review_days: Number(form.review_days),
    };
    const parsed = ConfigFormSchema.safeParse(candidate);
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      await onSave(parsed.data);
      onClose();
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/60" role="dialog" aria-modal="true">
      <div className="h-full w-full max-w-md overflow-y-auto border-l border-line bg-panel p-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[11px] uppercase tracking-wider text-muted">config — {bot.name}</h2>
          <Btn onClick={onClose}>close</Btn>
        </div>

        {errors.length > 0 && (
          <ul className="mb-3 border border-red p-2 text-xs text-red">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <div className="space-y-3 text-xs">
          <Field label="cadence tf">
            <select value={form.cadence_tf} onChange={(e) => set('cadence_tf', e.target.value)} className="w-full">
              {['1m', '15m', '1h', '4h', '1d'].map((tf) => (
                <option key={tf} value={tf}>
                  {tf}
                </option>
              ))}
            </select>
          </Field>

          <Field label="symbols (comma separated)">
            <input className="w-full" value={form.symbols} onChange={(e) => set('symbols', e.target.value)} />
          </Field>

          <Field label="provider order (comma separated)">
            <input
              className="w-full"
              value={form.provider_order}
              onChange={(e) => set('provider_order', e.target.value)}
            />
          </Field>

          <Field label="personality">
            <textarea
              className="h-20 w-full"
              value={form.personality}
              onChange={(e) => set('personality', e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            {NUMERIC_FIELDS.map((f) => (
              <Field key={f.key} label={f.label}>
                <input
                  type="number"
                  step={f.step ?? '1'}
                  className="w-full"
                  value={form[f.key as keyof typeof form]}
                  onChange={(e) => set(f.key as keyof typeof form, e.target.value)}
                />
              </Field>
            ))}
          </div>

          <div className="flex gap-2 pt-2">
            <Btn tone="go" onClick={() => void submit()} disabled={saving}>
              {saving ? 'saving…' : 'save'}
            </Btn>
            <Btn onClick={onClose}>cancel</Btn>
          </div>
        </div>
      </div>
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
