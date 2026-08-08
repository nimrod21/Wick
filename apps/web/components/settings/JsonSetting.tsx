'use client';

/**
 * Collapsible editor for the JSON `settings` rows the server treats as data
 * (`guards.defaults`, `triggers.thresholds`). Numbers/booleans get typed
 * inputs; anything else (arrays like the SL clamp) stays raw JSON so the
 * editor never silently drops a field it does not understand.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Btn } from '@/components/ui';

type Json = Record<string, unknown>;

export function JsonSetting({
  settingKey,
  title,
  raw,
}: {
  settingKey: string;
  title: string;
  raw: string | undefined;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Json>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (raw === undefined) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') setDraft(parsed as Json);
    } catch {
      setError('stored value is not valid JSON');
    }
  }, [raw]);

  const save = useMutation({
    mutationFn: (value: Json) => api.putSetting(settingKey, JSON.stringify(value)),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      void qc.invalidateQueries({ queryKey: ['settings'] });
      window.setTimeout(() => setSaved(false), 2000);
    },
    onError: (e: Error) => setError(e.message),
  });

  const entries = Object.entries(draft);

  return (
    <section className="panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between border-b border-line px-3 py-2 text-left"
      >
        <span className="text-[11px] uppercase tracking-wider text-muted">{title}</span>
        <span className="text-[11px] text-muted">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="p-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map(([k, v]) => (
              <label key={k} className="block text-xs">
                <span className="mb-1 block text-[10px] uppercase tracking-wider text-muted">{k}</span>
                {typeof v === 'boolean' ? (
                  <input
                    type="checkbox"
                    checked={v}
                    onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.checked }))}
                    className="h-3 w-3 p-0"
                  />
                ) : typeof v === 'number' ? (
                  <input
                    type="number"
                    step="any"
                    className="w-full py-0.5"
                    value={String(v)}
                    onChange={(e) => setDraft((d) => ({ ...d, [k]: Number(e.target.value) }))}
                  />
                ) : (
                  <input
                    className="w-full py-0.5"
                    value={JSON.stringify(v)}
                    onChange={(e) => {
                      try {
                        const next: unknown = JSON.parse(e.target.value);
                        setDraft((d) => ({ ...d, [k]: next }));
                        setError(null);
                      } catch {
                        setError(`${k}: not valid JSON`);
                      }
                    }}
                  />
                )}
              </label>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Btn tone="go" onClick={() => save.mutate(draft)} disabled={save.isPending}>
              {save.isPending ? 'saving…' : 'save'}
            </Btn>
            {saved && <span className="text-[11px] text-green">saved</span>}
            {error && <span className="text-[11px] text-red">{error}</span>}
          </div>
          <p className="mt-2 text-[10px] text-muted">
            Applies to new bots and to the trigger engine. Existing bots keep their own config.
          </p>
        </div>
      )}
    </section>
  );
}
