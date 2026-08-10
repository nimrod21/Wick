/**
 * Macro collector — Yahoo chart API (RESEARCH.md §Macro), keyless.
 *
 *   GET query1.finance.yahoo.com/v8/finance/chart/<SYM>?range=1d&interval=1h
 *   with a browser User-Agent (a bare node UA gets 403'd).
 *
 * Unofficial API: 10-minute cycle, last-known-good in-memory cache, failures
 * logged at warn and otherwise silent — exactly the fear-greed contract.
 * Quotes land in `macro_quotes` (point quotes, not OHLCV — see 003_intel.sql)
 * and each change publishes a `macro` bus event.
 *
 * `changePct` is measured against the meta previous close, so it survives a
 * thin series (^VIX regularly returns no intraday closes out of hours).
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { MacroEvent } from '@wick/shared';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { logger } from '../../util/logger.js';
import { nowMs } from '../../util/time.js';

const TICK_CRON = '*/10 * * * *';
const FETCH_TIMEOUT_MS = 12_000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Indicator name → Yahoo symbol. The indicator registry uses the left-hand
 * names (`gold`, `oil`, `dxy`, `vix`); `silver` is collected for the Intel
 * page but casts no vote (no agreed rule yet).
 */
export const MACRO_SYMBOLS: Record<string, string> = {
  gold: 'GC=F',
  oil: 'CL=F',
  silver: 'SI=F',
  dxy: 'DX-Y.NYB',
  vix: '^VIX',
};

export interface MacroQuote {
  /** Yahoo symbol, e.g. 'GC=F'. */
  symbol: string;
  price: number;
  /** % change vs the previous close; null when Yahoo omits it. */
  changePct: number | null;
  ts: number;
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketTime?: number;
      };
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: unknown;
  };
}

let task: ScheduledTask | null = null;
let stopping = false;
let currentTick: Promise<void> | null = null;
let eventIdSeq = 1;
/** Last-known-good per indicator name. Survives every failed poll. */
const latest = new Map<string, MacroQuote>();

const insertStmt = db.prepare(
  'INSERT OR REPLACE INTO macro_quotes (symbol, ts, price) VALUES (?, ?, ?)',
);

async function fetchQuote(yahooSymbol: string): Promise<MacroQuote | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}` +
    '?range=1d&interval=1h';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      logger.warn({ yahooSymbol, status: resp.status }, 'macro: http error');
      return null;
    }
    const json = (await resp.json()) as YahooChartResponse;
    const result = json.chart?.result?.[0];
    const meta = result?.meta;
    let price = meta?.regularMarketPrice;
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      // Fall back to the freshest non-null close in the series.
      const closes = result?.indicators?.quote?.[0]?.close ?? [];
      for (let i = closes.length - 1; i >= 0; i--) {
        const c = closes[i];
        if (typeof c === 'number' && Number.isFinite(c)) {
          price = c;
          break;
        }
      }
    }
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      logger.warn({ yahooSymbol }, 'macro: no usable price in response');
      return null;
    }
    const prev = meta?.chartPreviousClose ?? meta?.previousClose;
    const changePct =
      typeof prev === 'number' && Number.isFinite(prev) && prev !== 0
        ? ((price - prev) / prev) * 100
        : null;
    const ts =
      typeof meta?.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : nowMs();
    return { symbol: yahooSymbol, price, changePct, ts };
  } catch (err) {
    logger.warn({ err, yahooSymbol }, 'macro: fetch failed (serving cached value)');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function macroTick(): Promise<void> {
  if (stopping) return;
  let ok = 0;
  for (const [name, yahooSymbol] of Object.entries(MACRO_SYMBOLS)) {
    if (stopping) return;
    const quote = await fetchQuote(yahooSymbol);
    if (!quote) continue; // last-known-good stays in place
    ok++;
    const prev = latest.get(name);
    latest.set(name, quote);
    try {
      insertStmt.run(quote.symbol, quote.ts, quote.price);
    } catch (err) {
      logger.error({ err, yahooSymbol }, 'macro: insert failed');
    }
    if (prev?.price === quote.price && prev.ts === quote.ts) continue;
    const evt: MacroEvent = {
      id: eventIdSeq++,
      ts: quote.ts,
      source: 'yahoo',
      kind: 'macro',
      symbol: quote.symbol,
      price: quote.price,
      changePct: quote.changePct,
    };
    eventBus.emit(evt);
  }
  if (ok > 0) {
    logger.debug({ ok, of: Object.keys(MACRO_SYMBOLS).length }, 'macro: poll complete');
  }
}

export function startMacro(): void {
  if (task) return;
  stopping = false;
  task = cron.schedule(TICK_CRON, () => {
    if (currentTick) return;
    currentTick = macroTick().finally(() => {
      currentTick = null;
    });
  });
  currentTick = macroTick().finally(() => {
    currentTick = null;
  });
  logger.info({ symbols: Object.keys(MACRO_SYMBOLS).length }, 'macro collector started (10-min poll)');
}

export function stopMacro(): void {
  stopping = true;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'macro: stop failed');
    }
    task = null;
  }
}

// ── indicator input ────────────────────────────────────────────────────

/**
 * Last-known-good quote for an indicator name ('gold' | 'oil' | 'dxy' |
 * 'vix' | 'silver'). May be stale — callers tolerate that silently, same as
 * fear & greed.
 */
export function getMacroQuote(name: string): MacroQuote | null {
  return latest.get(name) ?? null;
}

/** Every cached quote, keyed by indicator name (for the Intel page later). */
export function getMacroQuotes(): Record<string, MacroQuote> {
  return Object.fromEntries(latest);
}
