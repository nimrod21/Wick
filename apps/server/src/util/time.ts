/**
 * Time helpers. Internal clock is unix seconds UTC.
 */

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Wick schema (PLAN §6): all `ts` columns are UTC unix milliseconds. */
export function nowMs(): number {
  return Date.now();
}

export function toSec(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

export function fromSec(s: number): Date {
  return new Date(s * 1000);
}

export function startOfMinute(tsSec: number): number {
  return tsSec - (tsSec % 60);
}
