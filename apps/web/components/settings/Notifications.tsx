'use client';

/**
 * Notifications section — the operator-facing half of `intel.thresholds`.
 *
 * That settings row also holds the IMPL-3a collector/indicator thresholds,
 * which have their own meaning and are NOT edited here; the save merges into
 * the stored object rather than replacing it, so nothing this form does not
 * render can be lost. Values fall back to the server defaults, because a row
 * written before these keys existed simply does not contain them.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Btn } from '@/components/ui';

const INTEL_KEY = 'intel.thresholds';

const TYPES = [
  { key: 'whale_big_move', label: 'whale big move', note: 'single move above the USD size below (P1)' },
  { key: 'news_burst', label: 'news burst', note: 'headline rate above the ratio below (P2)' },
  { key: 'macro_shock', label: 'macro shock', note: 'day move above the per-symbol % below (P2)' },
] as const;

const SHOCK_SYMBOLS = ['gold', 'oil', 'silver', 'dxy', 'vix'] as const;

interface Draft {
  whale_big_move_usd: number;
  news_burst_trigger_ratio: number;
  macro_shock_pct: Record<string, number>;
  notify: Record<string, boolean>;
}

const DEFAULTS: Draft = {
  whale_big_move_usd: 25_000_000,
  news_burst_trigger_ratio: 3,
  macro_shock_pct: { gold: 2, oil: 3, silver: 3, dxy: 1, vix: 15 },
  notify: { whale_big_move: true, news_burst: true, macro_shock: true },
};

function parseStored(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toDraft(stored: Record<string, unknown>): Draft {
  const numberOr = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const shock = (stored.macro_shock_pct ?? {}) as Record<string, unknown>;
  const notify = (stored.notify ?? {}) as Record<string, unknown>;
  return {
    whale_big_move_usd: numberOr(stored.whale_big_move_usd, DEFAULTS.whale_big_move_usd),
    news_burst_trigger_ratio: numberOr(
      stored.news_burst_trigger_ratio,
      DEFAULTS.news_burst_trigger_ratio,
    ),
    macro_shock_pct: Object.fromEntries(
      SHOCK_SYMBOLS.map((s) => [s, numberOr(shock[s], DEFAULTS.macro_shock_pct[s]!)]),
    ),
    notify: Object.fromEntries(
      TYPES.map((t) => [t.key, typeof notify[t.key] === 'boolean' ? (notify[t.key] as boolean) : true]),
    ),
  };
}

export function NotificationsSetting({ raw }: { raw: string | undefined }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(DEFAULTS);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(toDraft(parseStored(raw)));
  }, [raw]);

  const save = useMutation({
    mutationFn: () => api.putSetting(INTEL_KEY, JSON.stringify({ ...parseStored(raw), ...draft })),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['settings'] });
      window.setTimeout(() => setSaved(false), 2000);
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <section className="panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between border-b border-line px-3 py-2 text-left"
      >
        <span className="text-[11px] uppercase tracking-wider text-muted">Notifications</span>
        <span className="text-[11px] text-muted">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="space-y-4 p-3">
          <div className="space-y-1.5">
            {TYPES.map((t) => (
              <label key={t.key} className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={draft.notify[t.key] ?? true}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, notify: { ...d.notify, [t.key]: e.target.checked } }))
                  }
                  className="h-3 w-3 p-0"
                />
                {t.label}
                <span className="text-[10px] text-muted">{t.note}</span>
              </label>
            ))}
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block text-xs">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted">
                whale_big_move_usd
              </span>
              <input
                type="number"
                step="any"
                className="w-full py-0.5"
                value={String(draft.whale_big_move_usd)}
                onChange={(e) => setDraft((d) => ({ ...d, whale_big_move_usd: Number(e.target.value) }))}
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted">
                news_burst_trigger_ratio
              </span>
              <input
                type="number"
                step="any"
                className="w-full py-0.5"
                value={String(draft.news_burst_trigger_ratio)}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, news_burst_trigger_ratio: Number(e.target.value) }))
                }
              />
            </label>
            {SHOCK_SYMBOLS.map((s) => (
              <label key={s} className="block text-xs">
                <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted">
                  macro_shock_pct.{s}
                </span>
                <input
                  type="number"
                  step="any"
                  className="w-full py-0.5"
                  value={String(draft.macro_shock_pct[s] ?? 0)}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      macro_shock_pct: { ...d.macro_shock_pct, [s]: Number(e.target.value) },
                    }))
                  }
                />
              </label>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Btn tone="go" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? 'saving…' : 'save'}
            </Btn>
            {saved && <span className="text-[11px] text-green">saved</span>}
            {error && <span className="text-[11px] text-red">{error}</span>}
          </div>
          <p className="text-[10px] text-muted">
            Read live by the trigger engine — no restart. Turning a type off stops it firing entirely
            (no trigger_log row, no bot wake).
          </p>
        </div>
      )}
    </section>
  );
}
