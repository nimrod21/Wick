/**
 * Market warm-up state (PLAN §16.9). The flag flips once per boot after the
 * REST backfill completes; the trigger engine (Phase 4) and indicator engine
 * gate on it so nothing acts on a half-filled candle store.
 */

import type { MarketWarmEvent } from '@wick/shared';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';
import { nowMs } from '../util/time.js';

let warm = false;

export function isMarketWarm(): boolean {
  return warm;
}

export function setMarketWarm(): void {
  if (warm) return;
  warm = true;
  const evt: MarketWarmEvent = {
    id: 1,
    ts: nowMs(),
    source: 'boot',
    kind: 'market_warm',
  };
  eventBus.emit(evt);
  logger.info('marketWarm: backfill complete, market data is live');
}
