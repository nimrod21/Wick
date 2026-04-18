/**
 * Market-hours helpers.
 *
 * - crypto: always open.
 * - us_equities: Mon–Fri 09:30–16:00 America/New_York, holiday-aware via a
 *   hardcoded 2026 holiday set.
 * - forex: Sun 22:00 UTC → Fri 22:00 UTC.
 * - commodities_futures: treated the same as forex for now.
 */

import holidaysJson from '../data/us-market-holidays.json' with { type: 'json' };

export type MarketType =
  | 'us_equities'
  | 'forex'
  | 'crypto'
  | 'commodities_futures';

const US_HOLIDAYS_BY_YEAR: Record<string, string[]> = holidaysJson as Record<
  string,
  string[]
>;
const US_HOLIDAYS = new Set<string>();
for (const list of Object.values(US_HOLIDAYS_BY_YEAR)) {
  for (const d of list) US_HOLIDAYS.add(d);
}

interface NyParts {
  year: number;
  month: number;
  day: number;
  weekday: number; // 0 = Sun .. 6 = Sat
  hour: number;
  minute: number;
}

const nyFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short',
});

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function partsInNy(d: Date): NyParts {
  const parts = nyFormatter.formatToParts(d);
  const lookup: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') lookup[p.type] = p.value;
  }
  const weekdayName = lookup['weekday'] ?? 'Mon';
  let hour = parseInt(lookup['hour'] ?? '0', 10);
  // Intl can return "24" at midnight in hour12:false mode; normalise.
  if (hour === 24) hour = 0;
  return {
    year: parseInt(lookup['year'] ?? '1970', 10),
    month: parseInt(lookup['month'] ?? '1', 10),
    day: parseInt(lookup['day'] ?? '1', 10),
    weekday: WEEKDAY_MAP[weekdayName] ?? 1,
    hour,
    minute: parseInt(lookup['minute'] ?? '0', 10),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function nyDateString(p: NyParts): string {
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function isUsMarketOpenAt(d: Date): boolean {
  const p = partsInNy(d);
  if (p.weekday === 0 || p.weekday === 6) return false;
  if (US_HOLIDAYS.has(nyDateString(p))) return false;
  const minutes = p.hour * 60 + p.minute;
  const openMin = 9 * 60 + 30; // 09:30
  const closeMin = 16 * 60; // 16:00
  return minutes >= openMin && minutes < closeMin;
}

function isForexOpenAt(d: Date): boolean {
  // Sun 22:00 UTC → Fri 22:00 UTC
  const dow = d.getUTCDay(); // 0 = Sun .. 6 = Sat
  const hour = d.getUTCHours();
  if (dow === 6) return false; // Saturday closed all day
  if (dow === 0) return hour >= 22; // Sunday: open from 22:00 UTC
  if (dow === 5) return hour < 22; // Friday: open until 22:00 UTC
  return true; // Mon–Thu: fully open
}

export function isMarketOpen(type: MarketType, at: Date = new Date()): boolean {
  switch (type) {
    case 'crypto':
      return true;
    case 'us_equities':
      return isUsMarketOpenAt(at);
    case 'forex':
    case 'commodities_futures':
      return isForexOpenAt(at);
    default:
      return false;
  }
}

/**
 * Return the next moment `type` is open at/after `after`. Best-effort: steps
 * forward in 1-minute increments with a safety cap of 14 days. For `crypto`,
 * returns `after` unchanged.
 */
export function nextOpen(type: MarketType, after: Date = new Date()): Date {
  if (type === 'crypto') return new Date(after.getTime());
  const MAX_STEPS = 14 * 24 * 60;
  const cursor = new Date(after.getTime());
  for (let i = 0; i < MAX_STEPS; i++) {
    if (isMarketOpen(type, cursor)) return cursor;
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return cursor;
}
