'use client';

/**
 * Notification bell + P1 toasts (IMPL-3b).
 *
 * The trigger engine is the only source: history comes from `trigger_log`
 * via GET /api/notifications (grouped back into one row per real event) and
 * live arrivals come from the `trigger` SSE topic. Gated triggers are shown
 * too — a wake that did NOT happen is information, not noise — but only
 * priority-1 events raise a toast, and toasts are static (PLAN §12: motion
 * for data updates only, never decoration).
 *
 * "Read" is a browser-local watermark, not server state: this is one
 * operator's cockpit, and the bell must not write to the trading DB.
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLive } from '@/lib/sse';
import { dateTime } from '@/lib/format';

const SEEN_KEY = 'wick.notif.seen';
const TOAST_MS = 15_000;
const MAX_TOASTS = 3;

interface Toast {
  key: string;
  ts: number;
  type: string;
  detail: string;
  fired: boolean;
}

function priorityClass(priority: number): string {
  return priority === 1 ? 'text-amber' : priority === 2 ? 'text-cyan' : 'text-muted';
}

function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" aria-hidden>
      <path d="M3.5 6a3.5 3.5 0 0 1 7 0v3l1 2h-9l1-2V6Z" strokeWidth="1" />
      <path d="M5.5 11.5a1.5 1.5 0 0 0 3 0" strokeWidth="1" />
    </svg>
  );
}

export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(() => {
    const raw = window.localStorage.getItem(SEEN_KEY);
    setSeen(raw === null ? 0 : Number(raw));
    return () => {
      for (const t of timers.current) clearTimeout(t);
    };
  }, []);

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications(50),
    refetchInterval: 60_000,
  });

  useLive('trigger', (e) => {
    void qc.invalidateQueries({ queryKey: ['notifications'] });
    if (e.priority !== 1) return;
    const key = `${e.type}:${e.detail}`;
    setToasts((prev) =>
      prev.some((t) => t.key === key)
        ? prev
        : [{ key, ts: e.ts, type: e.type, detail: e.detail, fired: e.fired }, ...prev].slice(0, MAX_TOASTS),
    );
    timers.current.push(
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.key !== key)), TOAST_MS),
    );
  });

  const rows = notifications.data ?? [];
  const unread = seen === null ? 0 : rows.filter((n) => n.ts > seen).length;

  const toggle = (): void => {
    setOpen((wasOpen) => {
      if (!wasOpen) {
        const now = Date.now();
        window.localStorage.setItem(SEEN_KEY, String(now));
        setSeen(now);
      }
      return !wasOpen;
    });
  };

  return (
    <>
      <div className="relative">
        <button
          type="button"
          onClick={toggle}
          className={`flex items-center gap-1 border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
            unread > 0 ? 'border-amber text-amber' : 'border-line text-muted hover:text-fg'
          }`}
          title="notifications (trigger history)"
          aria-label={`notifications, ${unread} unread`}
        >
          <BellIcon />
          {unread > 0 && <span className="tnum">{unread > 99 ? '99+' : unread}</span>}
        </button>

        {open && (
          <>
            <button
              type="button"
              className="fixed inset-0 z-30 cursor-default"
              onClick={() => setOpen(false)}
              aria-label="close notifications"
            />
            <div className="panel absolute right-0 top-7 z-40 max-h-[420px] w-[440px] overflow-y-auto">
              <header className="flex items-center justify-between border-b border-line px-3 py-2">
                <span className="text-[11px] uppercase tracking-wider text-muted">
                  Triggers — last 48h
                </span>
                <span className="text-[10px] text-muted">{rows.length}</span>
              </header>
              {rows.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted">
                  {notifications.isLoading ? 'loading…' : 'no triggers yet'}
                </p>
              ) : (
                <ul>
                  {rows.map((n) => (
                    <li key={n.id} className="border-b border-line px-3 py-1.5 text-xs last:border-0">
                      <div className="flex items-baseline gap-2">
                        <span className="tnum shrink-0 text-muted">{dateTime(n.ts)}</span>
                        <span className={`shrink-0 uppercase ${priorityClass(n.priority)}`}>
                          P{n.priority} {n.type}
                        </span>
                        {!n.fired && (
                          <span className="shrink-0 border border-line px-1 text-[10px] uppercase text-muted">
                            gated
                          </span>
                        )}
                      </div>
                      <div className="truncate text-muted" title={n.detail ?? ''}>
                        {n.detail ?? '—'}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex w-[340px] flex-col gap-2">
          {toasts.map((t) => (
            <div key={t.key} className="panel border-amber p-2 text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="uppercase text-amber">P1 {t.type}</span>
                <button
                  type="button"
                  onClick={() => setToasts((prev) => prev.filter((x) => x.key !== t.key))}
                  className="text-muted hover:text-fg"
                  aria-label="dismiss"
                >
                  ✕
                </button>
              </div>
              <div className="mt-1 text-muted">{t.detail}</div>
              {!t.fired && <div className="mt-1 text-[10px] uppercase text-muted">gated — no bot woken</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
