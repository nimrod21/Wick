/**
 * DXY + VIX collector via yahoo-finance2.
 *
 * Polls every 5 minutes during US equity hours (VIX is only quoted while
 * CBOE is open; DXY mirrors US equities for this purpose). On first run,
 * pulls 1y daily history to seed the mini chart + drawer history.
 *
 * Yahoo symbol quirks: `^VIX` needs the caret, `DX-Y.NYB` needs the suffix.
 * Any typo = silent empty response.
 */

import cron, { type ScheduledTask } from 'node-cron';
import yf from 'yahoo-finance2';
import type { IndicatorEvent } from '@cockpit/shared';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { logger } from '../../util/logger.js';
import { nowSec } from '../../util/time.js';
import { isMarketOpen } from '../../util/market-hours.js';

const TICK_CRON = '*/5 * * * *';

interface IndicatorDef {
  name: string;
  yahooSymbol: string;
  display: string;
}

const INDICATORS: readonly IndicatorDef[] = [
  { name: 'vix', yahooSymbol: '^VIX', display: 'VIX' },
  { name: 'dxy', yahooSymbol: 'DX-Y.NYB', display: 'DXY' },
];

let task: ScheduledTask | null = null;
let running = false;
let stopping = false;
let backfilled = false;
let initialized = false;
let eventIdSeq = 1;
const lastEmittedValue = new Map<string, number>();

const upsertStmt = db.prepare(
  `INSERT INTO indicator_readings (name, ts, value, meta_json)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(name, ts) DO UPDATE SET value = excluded.value`,
);

const priorValueStmt = db.prepare(
  `SELECT value FROM indicator_readings
    WHERE name = ? AND ts < ?
    ORDER BY ts DESC
    LIMIT 1`,
);

const rowCountStmt = db.prepare(
  `SELECT COUNT(*) AS count FROM indicator_readings WHERE name = ?`,
);

function nextEventId(): number {
  return eventIdSeq++;
}

function initialize(): void {
  if (initialized) return;
  initialized = true;
  try {
    (yf as { suppressNotices?: (names: string[]) => void }).suppressNotices?.([
      'yahooSurvey',
    ]);
  } catch {
    /* ignore */
  }
}

interface YahooQuote {
  regularMarketPrice?: number;
  regularMarketTime?: Date | number;
}

async function fetchQuote(symbol: string): Promise<YahooQuote | null> {
  try {
    const client = yf as unknown as {
      quote: (s: string) => Promise<YahooQuote>;
    };
    return await client.quote(symbol);
  } catch (err) {
    logger.warn({ err, symbol }, 'dxy-vix: quote failed');
    return null;
  }
}

interface HistoricalRow {
  date: Date;
  close?: number;
}

async function fetchHistorical(symbol: string): Promise<HistoricalRow[]> {
  try {
    const client = yf as unknown as {
      historical: (
        s: string,
        opts: { period1: Date; interval: '1d' | '1wk' | '1mo' },
      ) => Promise<HistoricalRow[]>;
    };
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const rows = await client.historical(symbol, {
      period1: oneYearAgo,
      interval: '1d',
    });
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    logger.warn({ err, symbol }, 'dxy-vix: historical failed');
    return [];
  }
}

function quoteTsSec(q: YahooQuote): number {
  const t = q.regularMarketTime;
  if (t instanceof Date) return Math.floor(t.getTime() / 1000);
  if (typeof t === 'number') {
    return t > 10_000_000_000 ? Math.floor(t / 1000) : t;
  }
  return nowSec();
}

async function backfillIndicator(def: IndicatorDef): Promise<void> {
  const { count } = rowCountStmt.get(def.name) as { count: number };
  if (count >= 50) return; // already enough history
  const rows = await fetchHistorical(def.yahooSymbol);
  if (rows.length === 0) return;
  const insertMany = db.transaction((items: HistoricalRow[]) => {
    for (const r of items) {
      if (!r.date || typeof r.close !== 'number' || !Number.isFinite(r.close)) continue;
      const ts = Math.floor(r.date.getTime() / 1000);
      upsertStmt.run(def.name, ts, r.close, null);
    }
  });
  insertMany(rows);
  logger.info({ name: def.name, rows: rows.length }, 'dxy-vix: backfilled');
}

async function pollIndicator(def: IndicatorDef): Promise<void> {
  const quote = await fetchQuote(def.yahooSymbol);
  if (!quote || typeof quote.regularMarketPrice !== 'number') return;
  const price = quote.regularMarketPrice;
  if (!Number.isFinite(price)) return;

  const ts = quoteTsSec(quote);
  upsertStmt.run(def.name, ts, price, null);

  const prev = lastEmittedValue.get(def.name);
  if (prev === price) return;
  lastEmittedValue.set(def.name, price);

  const priorRow = priorValueStmt.get(def.name, ts) as
    | { value: number }
    | undefined;
  const previous = priorRow?.value;
  const delta = previous !== undefined ? price - previous : undefined;

  const evt: IndicatorEvent = {
    id: nextEventId(),
    ts,
    source: 'yahoo',
    kind: 'indicator',
    name: def.name,
    value: price,
    ...(previous !== undefined ? { previous } : {}),
    ...(delta !== undefined ? { delta } : {}),
  };
  eventBus.emit(evt);
}

async function tick(): Promise<void> {
  if (stopping) return;
  if (!initialized) initialize();

  if (!backfilled) {
    for (const def of INDICATORS) {
      await backfillIndicator(def);
    }
    backfilled = true;
  }

  // VIX + DXY both track the US session.
  if (!isMarketOpen('us_equities')) return;

  for (const def of INDICATORS) {
    if (stopping) return;
    try {
      await pollIndicator(def);
    } catch (err) {
      logger.error({ err, name: def.name }, 'dxy-vix: poll failed');
    }
  }
}

export function startDxyVix(): void {
  if (running) return;
  running = true;
  stopping = false;
  initialize();
  logger.info('dxy-vix collector enabled');
  task = cron.schedule(TICK_CRON, () => {
    void tick().catch((err: unknown) => {
      logger.error({ err }, 'dxy-vix tick failed');
    });
  });
  // Trigger immediately so backfill happens at boot.
  void tick().catch((err: unknown) => {
    logger.error({ err }, 'dxy-vix initial tick failed');
  });
}

export function stopDxyVix(): void {
  stopping = true;
  running = false;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'dxy-vix: stop failed');
    }
    task = null;
  }
}

export function isDxyVixRunning(): boolean {
  return running;
}
