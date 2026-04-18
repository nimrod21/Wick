'use client';

import { useEffect, useRef, useState } from 'react';

export function useEventStream(
  topics: string[],
  opts?: { assetIds?: number[] },
): { connected: boolean; lastEvent: unknown | null } {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<unknown | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const topicsKey = topics.join(',');
  const assetIdsKey = opts?.assetIds?.join(',') ?? '';

  useEffect(() => {
    const params = new URLSearchParams({ topics: topicsKey });
    if (assetIdsKey) params.set('assetIds', assetIdsKey);

    const es = new EventSource(`/stream?${params.toString()}`);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    const handleFrame = (ev: MessageEvent) => {
      try {
        setLastEvent(JSON.parse(ev.data));
      } catch {
        /* ignore malformed payloads */
      }
    };

    // Server emits NAMED SSE events (event: candle / trade_tick / orderbook / ...).
    // Browser EventSource.onmessage only catches default `message` frames, so we
    // addEventListener for every requested topic.
    const listeners: Array<[string, EventListener]> = [];
    for (const topic of topics) {
      const fn = handleFrame as EventListener;
      es.addEventListener(topic, fn);
      listeners.push([topic, fn]);
    }
    // Also handle default message and hello so clients that don't pass topics still work.
    es.onmessage = handleFrame;
    const helloFn = handleFrame as EventListener;
    es.addEventListener('hello', helloFn);
    listeners.push(['hello', helloFn]);

    return () => {
      for (const [topic, fn] of listeners) es.removeEventListener(topic, fn);
      es.close();
      setConnected(false);
    };
  }, [topicsKey, assetIdsKey]);

  return { connected, lastEvent };
}
