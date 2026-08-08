/**
 * Quota ledger (task 3.3): per-provider daily counters backed by `llm_usage`
 * (UTC date rollover — survives restart) + an in-memory rpm token bucket.
 * `poolRemaining()` is what the Phase-4 trigger engine's budget gate reads.
 */
import { db } from '../db/client.js';
import type { ProviderRecord } from './providers.js';

/** UTC calendar date for a ts — one clock for the whole app (PLAN §15). */
export function utcDate(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// ── rpm token bucket (in-memory; resets on restart, which is fine — rpm is
// a per-minute limit and a restart takes longer than a minute of headroom) ──

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();

function refill(provider: ProviderRecord, nowMs: number): Bucket {
  let b = buckets.get(provider.id);
  if (!b) {
    b = { tokens: provider.rpm, lastRefillMs: nowMs };
    buckets.set(provider.id, b);
    return b;
  }
  const elapsedMs = nowMs - b.lastRefillMs;
  if (elapsedMs > 0) {
    b.tokens = Math.min(provider.rpm, b.tokens + (elapsedMs / 60_000) * provider.rpm);
    b.lastRefillMs = nowMs;
  }
  return b;
}

/** Test/ops helper: forget in-memory rpm state. */
export function resetRpmBuckets(): void {
  buckets.clear();
}

// ── daily ledger ────────────────────────────────────────────────────────

export interface UsageRow {
  calls: number;
  errors: number;
}

export function getUsage(providerId: string, nowMs: number = Date.now()): UsageRow {
  const row = db
    .prepare('SELECT calls, errors FROM llm_usage WHERE provider = ? AND date = ?')
    .get(providerId, utcDate(nowMs)) as UsageRow | undefined;
  return row ?? { calls: 0, errors: 0 };
}

/**
 * True when the provider can take one more call right now: enabled, daily
 * rpd not exhausted (UTC rollover), and at least one rpm token available.
 */
export function hasHeadroom(provider: ProviderRecord, nowMs: number = Date.now()): boolean {
  if (!provider.enabled) return false;
  if (getUsage(provider.id, nowMs).calls >= provider.rpd) return false;
  if (refill(provider, nowMs).tokens < 1) return false;
  return true;
}

/**
 * Record one call attempt (successful HTTP round-trip or error alike — both
 * consume upstream quota) and consume an rpm token.
 */
export function record(provider: ProviderRecord, ok: boolean, nowMs: number = Date.now()): void {
  db.prepare(
    `INSERT INTO llm_usage (provider, date, calls, errors) VALUES (?, ?, 1, ?)
     ON CONFLICT(provider, date) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors`,
  ).run(provider.id, utcDate(nowMs), ok ? 0 : 1);
  const b = refill(provider, nowMs);
  b.tokens = Math.max(0, b.tokens - 1);
}

/**
 * Pooled remaining daily calls: Σ over enabled providers of (rpd − used
 * today). The trigger engine's budget gate (PLAN §9) reads this.
 */
export function poolRemaining(providers: ProviderRecord[], nowMs: number = Date.now()): number {
  let sum = 0;
  for (const p of providers) {
    if (!p.enabled) continue;
    sum += Math.max(0, p.rpd - getUsage(p.id, nowMs).calls);
  }
  return sum;
}
