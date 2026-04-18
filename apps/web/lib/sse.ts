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
    es.onmessage = (ev) => {
      try {
        setLastEvent(JSON.parse(ev.data));
      } catch {
        /* ignore malformed payloads */
      }
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, [topicsKey, assetIdsKey]);

  return { connected, lastEvent };
}
