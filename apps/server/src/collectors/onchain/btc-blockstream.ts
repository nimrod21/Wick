/**
 * BTC whale collector — Blockstream Esplora (public API, no key needed).
 *
 * Endpoints:
 *   GET /address/{addr}/txs            — recent confirmed (up to 25)
 *   GET /address/{addr}/txs/mempool    — pending
 *
 * For each tx we compute net flow for the address (sum vouts to addr −
 * sum vins from addr). Positive → incoming, negative → outgoing. USD is
 * `btcAmount × BTCUSDT` latest close. Counterpart is the top non-self
 * output address (or null for coinbase / full self-consolidation).
 *
 * `whale_addresses.last_checked_block` stores the block height of the
 * most-recent confirmed tx we've processed; anything older is skipped.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { WhaleTxEvent } from '@cockpit/shared';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { getLimiter } from '../../util/rate-limiter.js';
import { logger } from '../../util/logger.js';
import { nowSec } from '../../util/time.js';
import { scheduleSnapshot } from '../../core/snapshot-job.js';

const BASE_URL = 'https://blockstream.info/api';
const TICK_CRON = '*/1 * * * *';
const SIGNIFICANCE_USD = 500_000;

const limiter = getLimiter('blockstream', { minTime: 100, maxConcurrent: 2 });

interface WhaleRow {
  id: number;
  address: string;
  label: string | null;
  last_checked_block: number | null;
}

interface BlockstreamVin {
  txid: string;
  vout: number;
  prevout?: {
    scriptpubkey_address?: string;
    value: number; // sats
  };
  is_coinbase?: boolean;
}

interface BlockstreamVout {
  scriptpubkey_address?: string;
  value: number; // sats
}

interface BlockstreamTx {
  txid: string;
  vin: BlockstreamVin[];
  vout: BlockstreamVout[];
  status: {
    confirmed: boolean;
    block_height?: number;
    block_time?: number;
  };
}

let task: ScheduledTask | null = null;
let stopping = false;
let btcAssetId: number | null = null;
let eventIdSeq = 1;
let currentTick: Promise<void> | null = null;

const selectEnabledStmt = db.prepare(
  `SELECT id, address, label, last_checked_block
     FROM whale_addresses
    WHERE chain = 'btc' AND enabled = 1
    ORDER BY id`,
);

const updateCursorStmt = db.prepare(
  `UPDATE whale_addresses
      SET last_checked_block = ?, last_checked_ts = ?
    WHERE id = ?`,
);

const insertEventStmt = db.prepare(
  `INSERT OR IGNORE INTO events
      (kind, source, ts, asset_id, severity, payload_json, dedup_key)
   VALUES ('whale_tx', 'blockstream', ?, ?, ?, ?, ?)`,
);

const ignoreLookupStmt = db.prepare(
  `SELECT 1 AS ok FROM ignore_addresses
    WHERE chain = 'btc' AND address = ? LIMIT 1`,
);

const btcUsdStmt = db.prepare(
  `SELECT c AS close FROM candles_1m
    WHERE asset_id = (SELECT id FROM assets WHERE symbol = 'BTCUSDT' LIMIT 1)
    ORDER BY ts DESC LIMIT 1`,
);

function nextEventId(): number {
  return eventIdSeq++;
}

function resolveBtcAssetId(): number | null {
  if (btcAssetId !== null) return btcAssetId;
  const row = db
    .prepare(`SELECT id FROM assets WHERE symbol = 'BTCUSDT' LIMIT 1`)
    .get() as { id: number } | undefined;
  btcAssetId = row?.id ?? null;
  return btcAssetId;
}

function btcUsdPrice(): number | null {
  const row = btcUsdStmt.get() as { close: number } | undefined;
  if (!row || !Number.isFinite(row.close)) return null;
  return row.close;
}

function isIgnored(addr: string | undefined): boolean {
  if (!addr) return false;
  const row = ignoreLookupStmt.get(addr) as { ok: number } | undefined;
  return Boolean(row);
}

async function blockstreamGet<T>(path: string): Promise<T | null> {
  return limiter.schedule(async () => {
    try {
      const resp = await fetch(`${BASE_URL}${path}`);
      if (!resp.ok) {
        if (resp.status !== 404) {
          logger.warn({ status: resp.status, path }, 'blockstream http error');
        }
        return null;
      }
      return (await resp.json()) as T;
    } catch (err) {
      logger.error({ err, path }, 'blockstream fetch failed');
      return null;
    }
  });
}

async function fetchConfirmed(addr: string): Promise<BlockstreamTx[]> {
  return (await blockstreamGet<BlockstreamTx[]>(`/address/${addr}/txs`)) ?? [];
}

async function fetchMempool(addr: string): Promise<BlockstreamTx[]> {
  return (await blockstreamGet<BlockstreamTx[]>(`/address/${addr}/txs/mempool`)) ?? [];
}

function computeNetAndCounterpart(
  addr: string,
  tx: BlockstreamTx,
): { netSats: number; counterpart: string | undefined; isCoinbase: boolean } {
  let inSats = 0; // sats received to this addr (vout to addr)
  let outSats = 0; // sats spent from this addr (prevout == addr)
  let isCoinbase = false;

  for (const vin of tx.vin) {
    if (vin.is_coinbase) isCoinbase = true;
    const prev = vin.prevout;
    if (prev && prev.scriptpubkey_address === addr) {
      outSats += prev.value;
    }
  }
  for (const vout of tx.vout) {
    if (vout.scriptpubkey_address === addr) {
      inSats += vout.value;
    }
  }
  const netSats = inSats - outSats;

  // Counterpart heuristic: top non-self output by value.
  let top: { addr: string; value: number } | null = null;
  for (const vout of tx.vout) {
    const a = vout.scriptpubkey_address;
    if (!a || a === addr) continue;
    if (!top || vout.value > top.value) {
      top = { addr: a, value: vout.value };
    }
  }
  let counterpart = top?.addr;

  if (netSats > 0) {
    // Incoming: find top non-self input address
    let inTop: { addr: string; value: number } | null = null;
    for (const vin of tx.vin) {
      const a = vin.prevout?.scriptpubkey_address;
      if (!a || a === addr) continue;
      const v = vin.prevout?.value ?? 0;
      if (!inTop || v > inTop.value) inTop = { addr: a, value: v };
    }
    if (inTop) counterpart = inTop.addr;
  }

  return { netSats, counterpart, isCoinbase };
}

function processTx(
  addr: string,
  label: string | null,
  tx: BlockstreamTx,
  assetId: number | null,
  pending: boolean,
): number | null {
  const { netSats, counterpart, isCoinbase } = computeNetAndCounterpart(addr, tx);
  if (netSats === 0) return null; // pure self-consolidation or fee-only

  if (counterpart && isIgnored(counterpart)) return null;

  const amountBtc = Math.abs(netSats) / 1e8;
  if (!Number.isFinite(amountBtc) || amountBtc === 0) return null;

  const direction: 'in' | 'out' = netSats > 0 ? 'in' : 'out';
  const usdPrice = btcUsdPrice();
  const usd = usdPrice !== null ? amountBtc * usdPrice : null;
  const severity = isCoinbase
    ? 10
    : usd === null
      ? 20
      : usd >= 1_000_000
        ? 70
        : usd >= SIGNIFICANCE_USD
          ? 50
          : 30;

  const event: WhaleTxEvent = {
    id: nextEventId(),
    ts: tx.status.block_time ?? nowSec(),
    source: pending ? 'blockstream:mempool' : 'blockstream',
    severity,
    kind: 'whale_tx',
    chain: 'btc',
    address: addr,
    direction,
    token: 'BTC',
    amount: amountBtc,
    usdValue: usd ?? 0,
    ...(counterpart ? { counterpart } : {}),
    txHash: tx.txid,
    ...(label ? { label } : {}),
  };

  const dedup = `btc:${tx.txid}`;
  const payload = JSON.stringify({ ...event, usdValue: usd, isCoinbase });
  const info = insertEventStmt.run(
    event.ts,
    assetId,
    severity,
    payload,
    dedup,
  );
  if (info.changes === 0) return null; // duplicate
  const eventId = Number(info.lastInsertRowid);
  eventBus.emit({ ...event, id: eventId });

  if (usd !== null && usd >= SIGNIFICANCE_USD && assetId !== null && usdPrice !== null) {
    scheduleSnapshot(eventId, assetId, usdPrice);
  }

  return eventId;
}

async function pollOne(row: WhaleRow): Promise<void> {
  const isBootstrap =
    row.last_checked_block === null || row.last_checked_block === 0;

  const [confirmed, mempool] = await Promise.all([
    fetchConfirmed(row.address),
    fetchMempool(row.address),
  ]);
  if (stopping) return;

  const assetId = resolveBtcAssetId();
  let maxBlock = row.last_checked_block ?? 0;
  for (const tx of confirmed) {
    const h = tx.status.block_height ?? 0;
    if (h > maxBlock) maxBlock = h;
  }

  if (isBootstrap) {
    // No emissions on first seed — just mark the cursor at the highest
    // confirmed block we saw (or 0 if the address has no history yet).
    updateCursorStmt.run(maxBlock, nowSec(), row.id);
    logger.info(
      { address: row.address, cursor: maxBlock, seen: confirmed.length },
      'blockstream whale bootstrap complete',
    );
    return;
  }

  const cutoff = row.last_checked_block ?? 0;
  for (const tx of confirmed) {
    const h = tx.status.block_height ?? 0;
    if (h <= cutoff) continue; // already processed
    try {
      processTx(row.address, row.label, tx, assetId, false);
    } catch (err) {
      logger.error(
        { err, txid: tx.txid, address: row.address },
        'blockstream processTx confirmed failed',
      );
    }
  }
  for (const tx of mempool) {
    try {
      processTx(row.address, row.label, tx, assetId, true);
    } catch (err) {
      logger.error(
        { err, txid: tx.txid, address: row.address },
        'blockstream processTx mempool failed',
      );
    }
  }

  updateCursorStmt.run(maxBlock, nowSec(), row.id);
}

async function tick(): Promise<void> {
  if (stopping) return;
  const rows = selectEnabledStmt.all() as WhaleRow[];
  for (const row of rows) {
    if (stopping) return;
    try {
      await pollOne(row);
    } catch (err) {
      logger.error({ err, address: row.address }, 'blockstream pollOne failed');
    }
  }
}

export function startBlockstream(): void {
  stopping = false;
  logger.info('blockstream whale collector enabled (no API key required)');
  if (task) return;
  task = cron.schedule(TICK_CRON, () => {
    if (currentTick) return;
    currentTick = tick().finally(() => {
      currentTick = null;
    });
  });
  currentTick = tick().finally(() => {
    currentTick = null;
  });
}

export function stopBlockstream(): void {
  stopping = true;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'blockstream: stop failed');
    }
    task = null;
  }
}

export function isBlockstreamEnabled(): boolean {
  return task !== null;
}
