/**
 * BTC whale collector — keyless, mempool.space primary / Blockstream
 * fallback (RESEARCH.md §Whales; both speak the same Esplora API, so one
 * client with an ordered host list covers the pair).
 *
 * Cycle (every 5 min):
 *   1. read the chain tip (`/blocks/tip/height`). Unchanged tip → skip the
 *      sweep entirely; new blocks are the only thing that can produce new
 *      confirmed whale moves, and this keeps the request budget near zero.
 *   2. for each watched address, read its last 50 confirmed txs
 *      (`/address/:addr/txs`) and compute that address's NET movement per tx.
 *   3. any tx moving more than the configured BTC threshold becomes a
 *      `whale_moves` row.
 *
 * Why address sweep and not a full block scan: an Esplora block page is 25
 * txs, a real block is ~4400 txs ⇒ ~176 requests / ~16 MB per block, ~2.3 GB
 * a day against a free public API. Sweeping the exchange seed is 14 requests
 * a cycle and produces exactly the signal `whale_flow` needs — exchange
 * inflow vs outflow. Deviation documented deliberately.
 *
 * Direction (see whale-addresses.ts): net>0 into an exchange wallet =
 * 'inflow' (bearish), net<0 = 'outflow' (bullish); a tx that touches a
 * second seeded address on the other side, or a non-exchange whale wallet,
 * is 'internal' and casts no vote.
 *
 * Re-reading the same 50 txs every cycle is deliberate: `whale_moves` has a
 * UNIQUE(chain, tx, address_tag) index, so re-inserts are no-ops and a
 * missed cycle self-heals. Only rows younger than 6h are broadcast on the
 * bus, so the first boot backfills history without an event storm.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { WhaleEvent } from '@wick/shared';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { getLimiter } from '../../util/rate-limiter.js';
import { logger } from '../../util/logger.js';
import { nowMs } from '../../util/time.js';
import { getIntelThresholds } from '../intel-settings.js';
import { BTC_WHALE_ADDRESSES, BTC_WHALE_BY_ADDRESS } from './whale-addresses.js';

const TICK_CRON = '*/5 * * * *';
const FETCH_TIMEOUT_MS = 12_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const EVENT_MAX_AGE_MS = 6 * HOUR_MS;
const SATS_PER_BTC = 1e8;

/** Primary first; the client falls through on any failure. */
const ESPLORA_HOSTS = ['https://mempool.space/api', 'https://blockstream.info/api'];

const limiter = getLimiter('esplora', { minTime: 250, maxConcurrent: 2 });

interface EsploraVin {
  prevout?: { scriptpubkey_address?: string; value: number } | null;
  is_coinbase?: boolean;
}
interface EsploraVout {
  scriptpubkey_address?: string;
  value: number;
}
interface EsploraTx {
  txid: string;
  vin: EsploraVin[];
  vout: EsploraVout[];
  status: { confirmed: boolean; block_height?: number; block_time?: number };
}

let task: ScheduledTask | null = null;
let stopping = false;
let currentTick: Promise<void> | null = null;
let eventIdSeq = 1;
let lastTipHeight = 0;

const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO whale_moves (ts, chain, amount, usd, direction, tx, address_tag)
   VALUES (?, 'btc', ?, ?, ?, ?, ?)`,
);

/**
 * GET `path` from the first Esplora host that answers. Returns null when all
 * hosts fail — every caller treats that as "nothing new this cycle".
 */
async function esploraGet<T>(path: string): Promise<T | null> {
  return limiter.schedule(async () => {
    for (const host of ESPLORA_HOSTS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const resp = await fetch(`${host}${path}`, { signal: ctrl.signal });
        if (resp.status === 400 || resp.status === 404) {
          logger.warn({ host, path, status: resp.status }, 'esplora: rejected path');
          return null; // a malformed address fails identically on the fallback
        }
        if (!resp.ok) {
          logger.warn({ host, path, status: resp.status }, 'esplora: http error, trying fallback');
          continue;
        }
        return (await resp.json()) as T;
      } catch (err) {
        logger.warn({ err, host, path }, 'esplora: fetch failed, trying fallback');
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  });
}

/** Latest BTC price from the candle store (1m, then 1h). Null before warm-up. */
function btcUsd(): number | null {
  const row = db
    .prepare(
      `SELECT c FROM candles WHERE symbol = 'BTCUSDT' AND tf IN ('1m','1h')
        ORDER BY ts DESC LIMIT 1`,
    )
    .get() as { c: number } | undefined;
  return row && Number.isFinite(row.c) ? row.c : null;
}

/**
 * Net sats moved by `addr` in `tx`, and the direction of the tx as a whole.
 *
 * Direction is decided by the COUNTERPARTIES, not by which address happened
 * to trigger the sweep: an output to a seeded exchange wallet is an inflow,
 * an input from one is an outflow, both (or neither) is 'internal'. That way
 * a whale→exchange transfer reads the same whichever side we saw it from.
 */
export function classifyTx(
  addr: string,
  tx: EsploraTx,
): { netSats: number; direction: WhaleEvent['direction'] } {
  let inSats = 0;
  let outSats = 0;
  let fromExchange = false;
  let toExchange = false;

  for (const vin of tx.vin) {
    const a = vin.prevout?.scriptpubkey_address;
    if (!a) continue;
    if (a === addr) outSats += vin.prevout?.value ?? 0;
    if (BTC_WHALE_BY_ADDRESS.get(a)?.exchange) fromExchange = true;
  }
  for (const vout of tx.vout) {
    const a = vout.scriptpubkey_address;
    if (!a) continue;
    if (a === addr) inSats += vout.value;
    if (BTC_WHALE_BY_ADDRESS.get(a)?.exchange) toExchange = true;
  }

  const direction: WhaleEvent['direction'] =
    toExchange && fromExchange ? 'internal' : toExchange ? 'inflow' : fromExchange ? 'outflow' : 'internal';
  return { netSats: inSats - outSats, direction };
}

async function sweepAddress(
  entry: (typeof BTC_WHALE_ADDRESSES)[number],
  minBtc: number,
  price: number | null,
): Promise<number> {
  const txs = await esploraGet<EsploraTx[]>(`/address/${entry.address}/txs`);
  if (txs === null || stopping) return 0; // already warned inside esploraGet

  const now = nowMs();
  let inserted = 0;
  const pending: WhaleEvent[] = [];

  for (const tx of txs) {
    if (!tx.status.confirmed) continue;
    const { netSats, direction } = classifyTx(entry.address, tx);
    const amount = Math.abs(netSats) / SATS_PER_BTC;
    if (amount < minBtc) continue;

    const ts = (tx.status.block_time ?? Math.floor(now / 1000)) * 1000;
    const usd = price === null ? null : amount * price;

    const info = insertStmt.run(ts, amount, usd, direction, tx.txid, entry.label);
    if (info.changes === 0) continue;
    inserted++;
    if (now - ts <= EVENT_MAX_AGE_MS) {
      pending.push({
        id: eventIdSeq++,
        ts,
        source: 'esplora',
        kind: 'whale',
        chain: 'btc',
        amount,
        usd,
        direction,
        tx: tx.txid,
        addressTag: entry.label,
        severity: direction === 'internal' ? 20 : 60,
      });
    }
  }

  for (const evt of pending) eventBus.emit(evt);
  return inserted;
}

export async function whaleTick(force = false): Promise<void> {
  if (stopping) return;
  const tip = await esploraGet<number>('/blocks/tip/height');
  if (tip === null) return; // both backends down — silent, cached rows stand
  if (!force && tip === lastTipHeight) return;
  lastTipHeight = tip;

  const minBtc = getIntelThresholds().whale_btc_min;
  const price = btcUsd();
  let total = 0;
  for (const entry of BTC_WHALE_ADDRESSES) {
    if (stopping) return;
    try {
      total += await sweepAddress(entry, minBtc, price);
    } catch (err) {
      logger.warn({ err, address: entry.address }, 'whale: address sweep failed (continuing)');
    }
  }
  if (total > 0) logger.info({ inserted: total, tip, minBtc }, 'whale: new BTC moves');
}

export function startBtcWhales(): void {
  if (task) return;
  stopping = false;
  task = cron.schedule(TICK_CRON, () => {
    if (currentTick) return;
    currentTick = whaleTick().finally(() => {
      currentTick = null;
    });
  });
  // First pass forces the sweep so a restart backfills immediately.
  currentTick = whaleTick(true).finally(() => {
    currentTick = null;
  });
  logger.info(
    { addresses: BTC_WHALE_ADDRESSES.length },
    'btc whale collector started (mempool.space → blockstream, 5-min poll)',
  );
}

export function stopBtcWhales(): void {
  stopping = true;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'whale: stop failed');
    }
    task = null;
  }
}

// ── indicator input ────────────────────────────────────────────────────

/**
 * Net exchange flow over `FLOW_WINDOW_MS` in USD, signed OUTFLOW-POSITIVE:
 * `sum(outflow) − sum(inflow)`. Positive = coins leaving exchanges (bullish
 * read), negative = coins arriving (bearish). 'internal' rows are excluded.
 * Null when no priced exchange move landed in the window — the indicator
 * then votes neutral rather than reading a quiet week as balance.
 *
 * The window is 7d, not 24h: every exchange wallet in the seed is a COLD
 * wallet and they move in monthly lumps, so a 24h window is empty on almost
 * every day. See the note in whale-addresses.ts.
 */
export const FLOW_WINDOW_MS = 7 * DAY_MS;

export function whaleNetFlowUsd(ts: number = nowMs()): number | null {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'outflow' THEN usd ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN direction = 'inflow'  THEN usd ELSE 0 END), 0) AS net,
         COUNT(*) AS n
       FROM whale_moves
      WHERE ts >= ? AND usd IS NOT NULL AND direction IN ('inflow','outflow')`,
    )
    .get(ts - FLOW_WINDOW_MS) as { net: number; n: number };
  return row.n > 0 ? row.net : null;
}
