'use client';

import { useEffect, useState } from 'react';

// ---- shared single EventSource, multiplexed client-side ----
// The previous per-hook EventSource approach opened 10+ parallel SSE
// connections from the dashboard alone, blowing past Chrome's HTTP/1.1
// 6-per-host cap and starving navigation. We now keep ONE EventSource
// per tab, subscribed to the firehose, and route events to in-process
// subscribers by kind.
//
// Connects directly to the Fastify server (port 3001), bypassing the
// Next.js dev proxy so that dev-server connections stay free for RSC
// navigation and asset chunks.

type SseEvent = { kind?: string; assetId?: number; [k: string]: unknown };
type Subscriber = (ev: SseEvent) => void;

const SSE_URL = 'http://127.0.0.1:3001/stream?topics=candle,trade_tick,orderbook,whale_tx,news,indicator,probability,alert,order_status';
const KNOWN_KINDS = [
  'candle','trade_tick','orderbook','whale_tx','news',
  'indicator','probability','alert','order_status','hello',
];

let shared: {
  es: EventSource;
  subs: Set<Subscriber>;
  connected: boolean;
  connectedListeners: Set<(v: boolean) => void>;
} | null = null;

function setConnected(v: boolean) {
  if (!shared) return;
  if (shared.connected === v) return;
  shared.connected = v;
  for (const fn of shared.connectedListeners) fn(v);
}

function ensureShared() {
  if (shared || typeof window === 'undefined') return shared;

  const es = new EventSource(SSE_URL);
  shared = { es, subs: new Set(), connected: false, connectedListeners: new Set() };

  es.onopen = () => setConnected(true);
  es.onerror = () => setConnected(false);

  const route = (ev: MessageEvent) => {
    let data: SseEvent;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (!shared) return;
    for (const sub of shared.subs) {
      try { sub(data); } catch { /* ignore sub errors */ }
    }
  };
  es.onmessage = route;
  for (const k of KNOWN_KINDS) es.addEventListener(k, route as EventListener);

  return shared;
}

/**
 * Subscribe to the unified SSE firehose. Client-side filters by kinds
 * + optional assetIds. Returns the most recent matching event and
 * connection state. Does NOT open additional EventSources.
 */
export function useEventStream(
  topics: string[],
  opts?: { assetIds?: number[] },
): { connected: boolean; lastEvent: unknown | null } {
  const [connected, setC] = useState(false);
  const [lastEvent, setLast] = useState<unknown | null>(null);

  const topicsKey = topics.join(',');
  const assetIdsKey = opts?.assetIds?.join(',') ?? '';

  useEffect(() => {
    const s = ensureShared();
    if (!s) return;

    const wanted = new Set(topics);
    const wantedIds = opts?.assetIds ? new Set(opts.assetIds) : null;

    const sub: Subscriber = (ev) => {
      if (ev.kind && !wanted.has(ev.kind)) return;
      if (wantedIds) {
        if (typeof ev.assetId !== 'number' || !wantedIds.has(ev.assetId)) return;
      }
      setLast(ev);
    };
    s.subs.add(sub);

    setC(s.connected);
    const cl = (v: boolean) => setC(v);
    s.connectedListeners.add(cl);

    return () => {
      s.subs.delete(sub);
      s.connectedListeners.delete(cl);
    };
  }, [topicsKey, assetIdsKey]);

  return { connected, lastEvent };
}
