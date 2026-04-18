/**
 * ETH whale collector — Etherscan V2 REST.
 *
 * Polls each enabled ETH whale every 60s for native + ERC-20 transfers
 * since the last-checked block. New transactions (not bootstrap) are
 * filtered against the ignore list, priced in USD via Binance ETHUSDT
 * (native) or CoinGecko (ERC-20), recorded as `whale_tx` events, and —
 * when USD value >= $500k — trigger forward-price snapshot scheduling
 * against the chain-representative ETH asset.
 *
 * First-seen addresses are bootstrapped at `currentBlock - 100` so we
 * don't ingest years of history on seed load.
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

const BASE_URL = 'https://api.etherscan.io/api';
const TICK_CRON = '*/1 * * * *'; // every minute
const BOOTSTRAP_GAP_BLOCKS = 100;
const SIGNIFICANCE_USD = 500_000;
const TOKEN_PRICE_TTL_MS = 10 * 60 * 1000;
const NEG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const limiter = getLimiter('etherscan', { minTime: 250, maxConcurrent: 1 });

interface WhaleRow {
  id: number;
  address: string;
  label: string | null;
  last_checked_block: number | null;
}

interface EtherscanTxResponse {
  status: string;
  message: string;
  result: EtherscanTxResult[] | string;
}

interface EtherscanTxResult {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  contractAddress?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
  logIndex?: string;
  isError?: string;
}

interface EtherscanBlockNumberResponse {
  jsonrpc: string;
  id: number;
  result: string; // hex
}

let apiKey: string | null = null;
let task: ScheduledTask | null = null;
let stopping = false;
let ethAssetId: number | null = null;
let eventIdSeq = 1;
let currentTick: Promise<void> | null = null;

// token contract address (lowercase) -> price + asOf
const tokenPriceCache = new Map<string, { price: number | null; asOf: number }>();

const selectEnabledStmt = db.prepare(
  `SELECT id, address, label, last_checked_block
     FROM whale_addresses
    WHERE chain = 'eth' AND enabled = 1
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
   VALUES ('whale_tx', 'etherscan', ?, ?, ?, ?, ?)`,
);

const ignoreLookupStmt = db.prepare(
  `SELECT 1 AS ok FROM ignore_addresses
    WHERE chain = 'eth' AND address = ? LIMIT 1`,
);

const ethUsdStmt = db.prepare(
  `SELECT c AS close FROM candles_1m
    WHERE asset_id = (SELECT id FROM assets WHERE symbol = 'ETHUSDT' LIMIT 1)
    ORDER BY ts DESC LIMIT 1`,
);

function nextEventId(): number {
  return eventIdSeq++;
}

function resolveEthAssetId(): number | null {
  if (ethAssetId !== null) return ethAssetId;
  const row = db
    .prepare(`SELECT id FROM assets WHERE symbol = 'ETHUSDT' LIMIT 1`)
    .get() as { id: number } | undefined;
  ethAssetId = row?.id ?? null;
  return ethAssetId;
}

function ethUsdPrice(): number | null {
  const row = ethUsdStmt.get() as { close: number } | undefined;
  if (!row || !Number.isFinite(row.close)) return null;
  return row.close;
}

function isIgnored(addr: string): boolean {
  const row = ignoreLookupStmt.get(addr.toLowerCase()) as
    | { ok: number }
    | undefined;
  return Boolean(row);
}

async function etherscanGet<T>(params: Record<string, string>): Promise<T | null> {
  if (!apiKey) return null;
  const url = new URL(BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('apikey', apiKey);
  return limiter.schedule(async () => {
    try {
      const resp = await fetch(url.toString());
      if (!resp.ok) {
        logger.warn(
          { status: resp.status, module: params.module, action: params.action },
          'etherscan http error',
        );
        return null;
      }
      return (await resp.json()) as T;
    } catch (err) {
      logger.error({ err }, 'etherscan fetch failed');
      return null;
    }
  });
}

async function fetchCurrentBlock(): Promise<number | null> {
  const resp = await etherscanGet<EtherscanBlockNumberResponse>({
    module: 'proxy',
    action: 'eth_blockNumber',
  });
  if (!resp || !resp.result) return null;
  const n = parseInt(resp.result, 16);
  return Number.isFinite(n) ? n : null;
}

function parseTxResponse(resp: EtherscanTxResponse | null): EtherscanTxResult[] {
  if (!resp) return [];
  if (resp.status === '1' && Array.isArray(resp.result)) return resp.result;
  if (resp.status === '0') {
    // "No transactions found" is the happy empty path.
    if (resp.message === 'No transactions found') return [];
    if (typeof resp.result === 'string') {
      logger.warn(
        { message: resp.message, result: resp.result.slice(0, 80) },
        'etherscan soft error',
      );
    }
  }
  return [];
}

async function fetchNativeTxs(
  addr: string,
  startBlock: number,
): Promise<EtherscanTxResult[]> {
  const resp = await etherscanGet<EtherscanTxResponse>({
    module: 'account',
    action: 'txlist',
    address: addr,
    startblock: String(startBlock),
    endblock: '99999999',
    sort: 'desc',
  });
  return parseTxResponse(resp);
}

async function fetchTokenTxs(
  addr: string,
  startBlock: number,
): Promise<EtherscanTxResult[]> {
  const resp = await etherscanGet<EtherscanTxResponse>({
    module: 'account',
    action: 'tokentx',
    address: addr,
    startblock: String(startBlock),
    endblock: '99999999',
    sort: 'desc',
  });
  return parseTxResponse(resp);
}

async function fetchTokenUsdPrice(contract: string): Promise<number | null> {
  const key = contract.toLowerCase();
  const cached = tokenPriceCache.get(key);
  if (cached) {
    const age = Date.now() - cached.asOf;
    const ttl = cached.price === null ? NEG_CACHE_TTL_MS : TOKEN_PRICE_TTL_MS;
    if (age < ttl) return cached.price;
  }
  const url =
    `https://api.coingecko.com/api/v3/simple/token_price/ethereum` +
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
    logger.warn({ err, contract: key }, 'coingecko eth token price failed');
    tokenPriceCache.set(key, { price: null, asOf: Date.now() });
    return null;
  }
}

function buildNativeWhaleEvent(
  addr: string,
  label: string | null,
  tx: EtherscanTxResult,
  ethPrice: number | null,
): { event: WhaleTxEvent; dedup: string; severity: number; usd: number | null } | null {
  if (tx.isError && tx.isError !== '0') return null;
  const valueWei = tx.value;
  if (!valueWei || valueWei === '0') return null;
  const amountEth = Number(valueWei) / 1e18;
  if (!Number.isFinite(amountEth) || amountEth === 0) return null;

  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const addrLower = addr.toLowerCase();
  const direction: 'in' | 'out' = to === addrLower ? 'in' : 'out';
  const counterpart = direction === 'in' ? from : to;

  if (isIgnored(counterpart)) return null;

  const usd = ethPrice !== null ? amountEth * ethPrice : null;
  const severity = usd === null ? 20 : usd >= 1_000_000 ? 70 : usd >= SIGNIFICANCE_USD ? 50 : 30;

  const event: WhaleTxEvent = {
    id: nextEventId(),
    ts: Number(tx.timeStamp) || nowSec(),
    source: 'etherscan',
    severity,
    kind: 'whale_tx',
    chain: 'eth',
    address: addrLower,
    direction,
    token: 'ETH',
    amount: amountEth,
    usdValue: usd ?? 0,
    counterpart,
    txHash: tx.hash,
    ...(label ? { label } : {}),
  };

  return { event, dedup: `eth:${tx.hash}:0`, severity, usd };
}

async function buildTokenWhaleEvent(
  addr: string,
  label: string | null,
  tx: EtherscanTxResult,
): Promise<{ event: WhaleTxEvent; dedup: string; severity: number; usd: number | null } | null> {
  const contract = (tx.contractAddress ?? '').toLowerCase();
  if (!contract) return null;
  if (!tx.value) return null;

  const decimals = Number(tx.tokenDecimal ?? '18');
  const rawAmount = Number(tx.value);
  if (!Number.isFinite(rawAmount) || rawAmount === 0) return null;
  const amount = rawAmount / Math.pow(10, Number.isFinite(decimals) ? decimals : 18);
  if (!Number.isFinite(amount) || amount === 0) return null;

  const from = tx.from.toLowerCase();
  const to = tx.to.toLowerCase();
  const addrLower = addr.toLowerCase();
  const direction: 'in' | 'out' = to === addrLower ? 'in' : 'out';
  const counterpart = direction === 'in' ? from : to;
  if (isIgnored(counterpart)) return null;

  const unitUsd = await fetchTokenUsdPrice(contract);
  const usd = unitUsd !== null ? amount * unitUsd : null;
  const severity = usd === null ? 20 : usd >= 1_000_000 ? 70 : usd >= SIGNIFICANCE_USD ? 50 : 30;

  const event: WhaleTxEvent = {
    id: nextEventId(),
    ts: Number(tx.timeStamp) || nowSec(),
    source: 'etherscan',
    severity,
    kind: 'whale_tx',
    chain: 'eth',
    address: addrLower,
    direction,
    token: tx.tokenSymbol || contract.slice(0, 10),
    amount,
    usdValue: usd ?? 0,
    counterpart,
    txHash: tx.hash,
    ...(label ? { label } : {}),
  };

  const dedup = `eth:${tx.hash}:${tx.logIndex ?? '0'}`;
  return { event, dedup, severity, usd };
}

function persistEvent(
  built: { event: WhaleTxEvent; dedup: string; severity: number; usd: number | null },
  assetId: number | null,
): number | null {
  const { event, dedup, severity, usd } = built;
  const payload = JSON.stringify({ ...event, usdValue: usd });
  const info = insertEventStmt.run(
    event.ts,
    assetId,
    severity,
    payload,
    dedup,
  );
  if (info.changes === 0) return null; // duplicate
  return Number(info.lastInsertRowid);
}

async function pollOne(row: WhaleRow): Promise<void> {
  const addrLower = row.address.toLowerCase();
  const isBootstrap =
    row.last_checked_block === null || row.last_checked_block === 0;

  let startBlock: number;
  if (isBootstrap) {
    const currentBlock = await fetchCurrentBlock();
    if (currentBlock === null) return;
    startBlock = Math.max(0, currentBlock - BOOTSTRAP_GAP_BLOCKS);
    updateCursorStmt.run(startBlock, nowSec(), row.id);
    logger.info(
      { address: addrLower, startBlock },
      'etherscan whale bootstrap complete',
    );
    return;
  }
  startBlock = row.last_checked_block as number;

  const [native, tokens] = await Promise.all([
    fetchNativeTxs(addrLower, startBlock + 1),
    fetchTokenTxs(addrLower, startBlock + 1),
  ]);
  if (stopping) return;

  const ethPrice = ethUsdPrice();
  const assetId = resolveEthAssetId();
  let maxBlock = startBlock;

  for (const tx of native) {
    const built = buildNativeWhaleEvent(addrLower, row.label, tx, ethPrice);
    const blk = Number(tx.blockNumber);
    if (Number.isFinite(blk) && blk > maxBlock) maxBlock = blk;
    if (!built) continue;
    const eventId = persistEvent(built, assetId);
    if (eventId === null) continue;
    eventBus.emit({ ...built.event, id: eventId });
    if (built.usd !== null && built.usd >= SIGNIFICANCE_USD && assetId !== null) {
      const price = ethPrice ?? null;
      if (price !== null) scheduleSnapshot(eventId, assetId, price);
    }
  }

  for (const tx of tokens) {
    const built = await buildTokenWhaleEvent(addrLower, row.label, tx);
    const blk = Number(tx.blockNumber);
    if (Number.isFinite(blk) && blk > maxBlock) maxBlock = blk;
    if (!built) continue;
    const eventId = persistEvent(built, assetId);
    if (eventId === null) continue;
    eventBus.emit({ ...built.event, id: eventId });
    if (built.usd !== null && built.usd >= SIGNIFICANCE_USD && assetId !== null) {
      const price = ethUsdPrice();
      if (price !== null) scheduleSnapshot(eventId, assetId, price);
    }
  }

  updateCursorStmt.run(maxBlock, nowSec(), row.id);
}

async function tick(): Promise<void> {
  if (!apiKey || stopping) return;
  const rows = selectEnabledStmt.all() as WhaleRow[];
  for (const row of rows) {
    if (stopping) return;
    try {
      await pollOne(row);
    } catch (err) {
      logger.error({ err, address: row.address }, 'etherscan pollOne failed');
    }
  }
}

export function startEtherscan(): void {
  stopping = false;
  const creds = getApiKey('etherscan');
  if (!creds || !creds.key) {
    logger.warn('etherscan: no API key configured — whale collector disabled');
    apiKey = null;
    return;
  }
  apiKey = creds.key;
  logger.info('etherscan whale collector enabled');
  if (task) return;
  task = cron.schedule(TICK_CRON, () => {
    if (currentTick) return; // skip overlap
    currentTick = tick().finally(() => {
      currentTick = null;
    });
  });
  // Kick once at boot so bootstrap completes without waiting a full minute.
  currentTick = tick().finally(() => {
    currentTick = null;
  });
}

export function stopEtherscan(): void {
  stopping = true;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'etherscan: stop failed');
    }
    task = null;
  }
  apiKey = null;
}

export function isEtherscanEnabled(): boolean {
  return apiKey !== null;
}
