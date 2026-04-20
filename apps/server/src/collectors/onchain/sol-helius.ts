/**
 * SOL whale collector — Helius enhanced-tx API.
 *
 * The `/v0/addresses/{address}/transactions` endpoint returns parsed
 * nativeTransfers + tokenTransfers, sparing us the raw versioned-tx
 * parsing. We page newest-first and remember the latest seen signature
 * in `whale_addresses.last_checked_cursor` (added in migration 002).
 *
 * USD pricing: native SOL → Binance SOLUSDT latest close; SPL tokens →
 * CoinGecko `/simple/token_price/solana` with 10-min memoisation + 24h
 * negative cache.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { WhaleTxEvent } from '@cockpit/shared';
import { getApiKey } from '../../config.js';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { getLimiter } from '../../util/rate-limiter.js';
import { logger } from '../../util/logger.js';
import { nowSec } from '../../util/time.js';
import { scheduleSnapshot } from '../../core/snapshot-job.js';

const BASE_URL = 'https://api.helius.xyz/v0';
const TICK_CRON = '*/2 * * * *';
const SIGNIFICANCE_USD = 500_000;
const TOKEN_PRICE_TTL_MS = 10 * 60 * 1000;
const NEG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_LIMIT = 50;

const limiter = getLimiter('helius', { minTime: 125, maxConcurrent: 2 });

interface WhaleRow {
  id: number;
  address: string;
  label: string | null;
  last_checked_cursor: string | null;
}

interface HeliusNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount: number; // lamports
}

interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  tokenAmount: number | string;
  mint: string;
  tokenStandard?: string;
}

interface HeliusTx {
  signature: string;
  timestamp: number;
  slot?: number;
  type?: string;
  nativeTransfers?: HeliusNativeTransfer[];
  tokenTransfers?: HeliusTokenTransfer[];
  transactionError?: unknown;
}

let apiKey: string | null = null;
let task: ScheduledTask | null = null;
let stopping = false;
let solAssetId: number | null = null;
let eventIdSeq = 1;
let currentTick: Promise<void> | null = null;

const tokenPriceCache = new Map<string, { price: number | null; asOf: number }>();

const selectEnabledStmt = db.prepare(
  `SELECT id, address, label, last_checked_cursor
     FROM whale_addresses
    WHERE chain = 'sol' AND enabled = 1
    ORDER BY id`,
);

const updateCursorStmt = db.prepare(
  `UPDATE whale_addresses
      SET last_checked_cursor = ?, last_checked_ts = ?
    WHERE id = ?`,
);

const insertEventStmt = db.prepare(
  `INSERT OR IGNORE INTO events
      (kind, source, ts, asset_id, severity, payload_json, dedup_key)
   VALUES ('whale_tx', 'helius', ?, ?, ?, ?, ?)`,
);

const ignoreLookupStmt = db.prepare(
  `SELECT 1 AS ok FROM ignore_addresses
    WHERE chain = 'sol' AND address = ? LIMIT 1`,
);

const solUsdStmt = db.prepare(
  `SELECT c AS close FROM candles_1m
    WHERE asset_id = (SELECT id FROM assets WHERE symbol = 'SOLUSDT' LIMIT 1)
    ORDER BY ts DESC LIMIT 1`,
);

function nextEventId(): number {
  return eventIdSeq++;
}

function resolveSolAssetId(): number | null {
  if (solAssetId !== null) return solAssetId;
  const row = db
    .prepare(`SELECT id FROM assets WHERE symbol = 'SOLUSDT' LIMIT 1`)
    .get() as { id: number } | undefined;
  solAssetId = row?.id ?? null;
  return solAssetId;
}

function solUsdPrice(): number | null {
  const row = solUsdStmt.get() as { close: number } | undefined;
  if (!row || !Number.isFinite(row.close)) return null;
  return row.close;
}

function isIgnored(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const row = ignoreLookupStmt.get(addr) as { ok: number } | undefined;
  return Boolean(row);
}

async function heliusGet(address: string, before?: string): Promise<HeliusTx[]> {
  if (!apiKey) return [];
  const url = new URL(
    `${BASE_URL}/addresses/${encodeURIComponent(address)}/transactions`,
  );
  url.searchParams.set('api-key', apiKey);
  url.searchParams.set('limit', String(MAX_PAGE_LIMIT));
  if (before) url.searchParams.set('before', before);

  return limiter.schedule(async () => {
    try {
      const resp = await fetch(url.toString());
      if (!resp.ok) {
        logger.warn(
          { status: resp.status, address },
          'helius http error',
        );
        return [];
      }
      const json = (await resp.json()) as HeliusTx[] | { error?: unknown };
      if (Array.isArray(json)) return json;
      logger.warn({ address, error: (json as { error?: unknown }).error }, 'helius non-array response');
      return [];
    } catch (err) {
      logger.error({ err, address }, 'helius fetch failed');
      return [];
    }
  });
}

async function fetchTokenUsdPrice(mint: string): Promise<number | null> {
  const key = mint;
  const cached = tokenPriceCache.get(key);
  if (cached) {
    const age = Date.now() - cached.asOf;
    const ttl = cached.price === null ? NEG_CACHE_TTL_MS : TOKEN_PRICE_TTL_MS;
    if (age < ttl) return cached.price;
  }
  const url =
    `https://api.coingecko.com/api/v3/simple/token_price/solana` +
    `?contract_addresses=${encodeURIComponent(key)}&vs_currencies=usd`;
  try {
    const cgLimiter = getLimiter('coingecko', { minTime: 1200, maxConcurrent: 1 });
    const price = await cgLimiter.schedule(async () => {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const json = (await resp.json()) as Record<string, { usd?: number }>;
      const entry = json[key];
      if (!entry || typeof entry.usd !== 'number') return null;
      return entry.usd;
    });
    tokenPriceCache.set(key, { price: price ?? null, asOf: Date.now() });
    return price ?? null;
  } catch (err) {
    logger.warn({ err, mint }, 'coingecko sol token price failed');
    tokenPriceCache.set(key, { price: null, asOf: Date.now() });
    return null;
  }
}

function buildEventBase(
  addr: string,
  label: string | null,
  tx: HeliusTx,
  token: string,
  amount: number,
  usd: number | null,
  direction: 'in' | 'out',
  counterpart: string | undefined,
  index: number,
): { event: WhaleTxEvent; dedup: string; severity: number } {
  const severity = usd === null ? 20 : usd >= 1_000_000 ? 70 : usd >= SIGNIFICANCE_USD ? 50 : 30;
  const event: WhaleTxEvent = {
    id: nextEventId(),
    ts: tx.timestamp || nowSec(),
    source: 'helius',
    severity,
    kind: 'whale_tx',
    chain: 'sol',
    address: addr,
    direction,
    token,
    amount,
    usdValue: usd ?? 0,
    ...(counterpart ? { counterpart } : {}),
    txHash: tx.signature,
    ...(label ? { label } : {}),
  };
  return { event, dedup: `sol:${tx.signature}:${index}`, severity };
}

function persistEvent(
  built: { event: WhaleTxEvent; dedup: string; severity: number },
  assetId: number | null,
  usd: number | null,
): number | null {
  const payload = JSON.stringify({ ...built.event, usdValue: usd });
  const info = insertEventStmt.run(
    built.event.ts,
    assetId,
    built.severity,
    payload,
    built.dedup,
  );
  if (info.changes === 0) return null;
  return Number(info.lastInsertRowid);
}

async function processTx(
  addr: string,
  label: string | null,
  tx: HeliusTx,
  assetId: number | null,
): Promise<void> {
  if (tx.transactionError) return;

  const solPrice = solUsdPrice();
  let index = 0;

  // Native SOL transfers.
  for (const nt of tx.nativeTransfers ?? []) {
    const amountSol = (nt.amount ?? 0) / 1e9;
    if (!Number.isFinite(amountSol) || amountSol === 0) {
      index += 1;
      continue;
    }
    const from = nt.fromUserAccount;
    const to = nt.toUserAccount;
    if (from !== addr && to !== addr) {
      index += 1;
      continue;
    }
    const direction: 'in' | 'out' = to === addr ? 'in' : 'out';
    const counterpart = direction === 'in' ? from : to;
    if (isIgnored(counterpart)) {
      index += 1;
      continue;
    }
    const usd = solPrice !== null ? amountSol * solPrice : null;
    const built = buildEventBase(
      addr,
      label,
      tx,
      'SOL',
      amountSol,
      usd,
      direction,
      counterpart ?? undefined,
      index,
    );
    const eventId = persistEvent(built, assetId, usd);
    index += 1;
    if (eventId === null) continue;
    eventBus.emit({ ...built.event, id: eventId });
    if (usd !== null && usd >= SIGNIFICANCE_USD && assetId !== null && solPrice !== null) {
      scheduleSnapshot(eventId, assetId, solPrice);
    }
  }

  // SPL token transfers.
  for (const tt of tx.tokenTransfers ?? []) {
    const amount = typeof tt.tokenAmount === 'number' ? tt.tokenAmount : Number(tt.tokenAmount);
    if (!Number.isFinite(amount) || amount === 0) {
      index += 1;
      continue;
    }
    const from = tt.fromUserAccount;
    const to = tt.toUserAccount;
    if (from !== addr && to !== addr) {
      index += 1;
      continue;
    }
    const direction: 'in' | 'out' = to === addr ? 'in' : 'out';
    const counterpart = direction === 'in' ? from : to;
    if (isIgnored(counterpart)) {
      index += 1;
      continue;
    }
    const unitUsd = await fetchTokenUsdPrice(tt.mint);
    const usd = unitUsd !== null ? amount * unitUsd : null;
    const built = buildEventBase(
      addr,
      label,
      tx,
      tt.mint.slice(0, 10),
      amount,
      usd,
      direction,
      counterpart ?? undefined,
      index,
    );
    const eventId = persistEvent(built, assetId, usd);
    index += 1;
    if (eventId === null) continue;
    eventBus.emit({ ...built.event, id: eventId });
    if (usd !== null && usd >= SIGNIFICANCE_USD && assetId !== null && solPrice !== null) {
      // SOL is chain-representative asset → still price snapshot vs SOL price.
      scheduleSnapshot(eventId, assetId, solPrice);
    }
  }
}

async function pollOne(row: WhaleRow): Promise<void> {
  const isBootstrap = row.last_checked_cursor === null;
  const txs = await heliusGet(row.address);
  if (stopping) return;
  if (txs.length === 0) return;

  // Helius returns newest-first. Latest signature is txs[0].signature.
  const newestSig = txs[0].signature;

  if (isBootstrap) {
    // Don't emit anything on first seed — just mark the cursor.
    updateCursorStmt.run(newestSig, nowSec(), row.id);
    logger.info(
      { address: row.address, cursor: newestSig, seen: txs.length },
      'helius whale bootstrap complete',
    );
    return;
  }

  const stopSig = row.last_checked_cursor;
  const assetId = resolveSolAssetId();
  // Process newest-first up to but not including the previous cursor.
  for (const tx of txs) {
    if (tx.signature === stopSig) break;
    try {
      await processTx(row.address, row.label, tx, assetId);
    } catch (err) {
      logger.error(
        { err, signature: tx.signature, address: row.address },
        'helius processTx failed',
      );
    }
  }

  updateCursorStmt.run(newestSig, nowSec(), row.id);
}

async function tick(): Promise<void> {
  if (stopping) return;
  // Hot-reload: re-read the key every tick so pasting via Settings takes effect
  // within one cron cycle without a server restart.
  const creds = getApiKey('helius');
  apiKey = creds?.key ?? null;
  if (!apiKey) return; // silently skip this tick — no key yet
  const rows = selectEnabledStmt.all() as WhaleRow[];
  for (const row of rows) {
    if (stopping) return;
    try {
      await pollOne(row);
    } catch (err) {
      logger.error({ err, address: row.address }, 'helius pollOne failed');
    }
  }
}

export function startHelius(): void {
  stopping = false;
  // Schedule the cron unconditionally; tick() re-reads the key each run so
  // Settings-paste takes effect without a restart.
  const creds = getApiKey('helius');
  apiKey = creds?.key ?? null;
  if (apiKey) {
    logger.info('helius whale collector enabled');
  } else {
    logger.info('helius: no API key yet — cron scheduled, will activate on Settings save');
  }
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

export function stopHelius(): void {
  stopping = true;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'helius: stop failed');
    }
    task = null;
  }
  apiKey = null;
}

export function isHeliusEnabled(): boolean {
  return apiKey !== null;
}
