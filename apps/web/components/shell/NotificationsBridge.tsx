'use client';

import { useEffect, useRef } from 'react';
import { useEventStream } from '@/lib/sse';
import { notify } from '@/lib/notifications';

interface AlertEventLike {
  kind?: string;
  ts?: number;
  ruleId?: number;
  ruleName?: string;
  payload?: unknown;
}

function summarizePayload(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload.slice(0, 140);
  try {
    return JSON.stringify(payload).slice(0, 140);
  } catch {
    return '';
  }
}

/**
 * Renders nothing. Subscribes globally to the `alert` SSE topic and fires a
 * browser Notification on each. Mounted once in `app/layout.tsx` so alerts
 * surface regardless of which page the user is on.
 *
 * A small client-side rate limit mirrors the server firehose (max 10
 * notifications per 60s) — even if the server ever misbehaves we won't
 * flood the OS tray.
 */
export function NotificationsBridge() {
  const { lastEvent } = useEventStream(['alert']);
  const recentRef = useRef<number[]>([]);

  useEffect(() => {
    if (!lastEvent || typeof lastEvent !== 'object') return;
    const evt = lastEvent as AlertEventLike;
    if (evt.kind !== 'alert') return;
    if (!evt.ruleName) return;

    // Client-side throttle.
    const now = Date.now();
    const recent = recentRef.current;
    const cutoff = now - 60_000;
    while (recent.length && recent[0]! < cutoff) recent.shift();
    if (recent.length >= 10) return;
    recent.push(now);

    notify(`ALERT: ${evt.ruleName}`, summarizePayload(evt.payload));
  }, [lastEvent]);

  return null;
}

export default NotificationsBridge;
