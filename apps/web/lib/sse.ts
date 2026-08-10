'use client';

/**
 * ONE EventSource for the whole app (IMPL-4 pitfall: browser connection
 * limit), opened lazily on first subscriber and fanned out by topic.
 *
 * Reconnect: EventSource retries on its own, but a server restart can leave
 * it wedged, so we watch `onerror` and force a fresh connection with
 * exponential backoff (1s → 30s, reset on any received frame).
 */

import { useEffect, useRef } from 'react';
import type {
  BotStatusEvent,
  CandleEvent,
  DecisionEvent,
  Event as WickEvent,
  EventKind,
  FearGreedEvent,
  FillEvent,
  FundingEvent,
  IndicatorEvent,
  MacroEvent,
  NewsEvent,
  OutcomeEvent,
  TickEvent,
  TriggerEvent,
  WhaleEvent,
} from '@wick/shared';

export type { WickEvent };

/** Every topic the UI subscribes to (server-side filter on the query string). */
export const TOPICS: EventKind[] = [
  'tick',
  'candle',
  'indicator',
  'funding',
  'fear_greed',
  'market_warm',
  'fill',
  'decision',
  'trigger',
  'bot_status',
  'outcome',
  'news',
  'whale',
  'macro',
];

type Handler = (event: WickEvent) => void;

const handlers = new Map<string, Set<Handler>>();
let source: EventSource | null = null;
let backoffMs = 1_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Live connection state, polled by the header dot. */
let connected = false;
const connectionListeners = new Set<(ok: boolean) => void>();

function setConnected(ok: boolean): void {
  if (connected === ok) return;
  connected = ok;
  for (const l of connectionListeners) l(ok);
}

export function isConnected(): boolean {
  return connected;
}

export function onConnectionChange(cb: (ok: boolean) => void): () => void {
  connectionListeners.add(cb);
  return () => connectionListeners.delete(cb);
}

function dispatch(event: WickEvent): void {
  setConnected(true);
  backoffMs = 1_000;
  const set = handlers.get(event.kind);
  if (!set) return;
  for (const h of [...set]) h(event);
}

function open(): void {
  if (source || typeof window === 'undefined') return;
  const es = new EventSource(`/api/sse?topics=${TOPICS.join(',')}`);
  source = es;

  for (const topic of TOPICS) {
    es.addEventListener(topic, (raw) => {
      try {
        dispatch(JSON.parse((raw as MessageEvent<string>).data) as WickEvent);
      } catch {
        /* a malformed frame must never take the page down */
      }
    });
  }
  es.addEventListener('hello', () => setConnected(true));
  es.addEventListener('ping', () => setConnected(true));

  es.onerror = () => {
    setConnected(false);
    // Force a clean reconnect: the native retry can sit on a dead socket
    // after a server restart.
    es.close();
    if (source === es) source = null;
    if (handlers.size === 0) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  };
}

function closeIfIdle(): void {
  for (const set of handlers.values()) if (set.size > 0) return;
  handlers.clear();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  source?.close();
  source = null;
  setConnected(false);
}

function subscribe(topics: EventKind[], handler: Handler): () => void {
  for (const t of topics) {
    let set = handlers.get(t);
    if (!set) {
      set = new Set();
      handlers.set(t, set);
    }
    set.add(handler);
  }
  open();
  return () => {
    for (const t of topics) handlers.get(t)?.delete(handler);
    closeIfIdle();
  };
}

/**
 * Subscribe to one or more topics for the lifetime of a component. `cb` is
 * kept in a ref so a re-render never tears the subscription down (and the
 * caller does not have to memoize it).
 */
export function useLive<K extends EventKind>(
  topics: K | K[],
  cb: (event: Extract<WickEvent, { kind: K }>) => void,
): void {
  const ref = useRef(cb);
  ref.current = cb;
  const key = (Array.isArray(topics) ? topics : [topics]).join(',');

  useEffect(() => {
    const list = key.split(',') as EventKind[];
    return subscribe(list, (event) => {
      ref.current(event as Extract<WickEvent, { kind: K }>);
    });
  }, [key]);
}

// Narrowing helpers so components can keep their handlers typed.
export type {
  BotStatusEvent,
  CandleEvent,
  DecisionEvent,
  FearGreedEvent,
  FillEvent,
  FundingEvent,
  IndicatorEvent,
  MacroEvent,
  NewsEvent,
  OutcomeEvent,
  TickEvent,
  TriggerEvent,
  WhaleEvent,
};
