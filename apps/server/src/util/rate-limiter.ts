import Bottleneck from 'bottleneck';

export interface LimiterOpts {
  maxConcurrent?: number;
  minTime?: number;
  reservoir?: number;
  reservoirRefreshAmount?: number;
  reservoirRefreshInterval?: number;
}

const registry = new Map<string, Bottleneck>();

/**
 * Returns a shared Bottleneck instance for a given service name.
 * Calling again with the same `service` returns the same limiter; `opts` is
 * used only when constructing it the first time.
 */
export function getLimiter(service: string, opts: LimiterOpts = {}): Bottleneck {
  const existing = registry.get(service);
  if (existing) return existing;
  const limiter = new Bottleneck({
    maxConcurrent: opts.maxConcurrent,
    minTime: opts.minTime,
    reservoir: opts.reservoir,
    reservoirRefreshAmount: opts.reservoirRefreshAmount,
    reservoirRefreshInterval: opts.reservoirRefreshInterval,
  });
  registry.set(service, limiter);
  return limiter;
}

export function listLimiters(): string[] {
  return Array.from(registry.keys());
}
