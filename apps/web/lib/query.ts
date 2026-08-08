'use client';

import { createElement, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The app is SSE-driven; react-query only owns the initial loads and the
 * slow-moving refetches. Live rows arrive over `lib/sse.ts` and invalidate
 * or patch the cache from there.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  return createElement(QueryClientProvider, { client }, children);
}
