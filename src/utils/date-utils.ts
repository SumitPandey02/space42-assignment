/**
 * Date helpers for booking payloads.
 *
 * Design rules:
 *  - Everything is UTC. No local-timezone drift between developer machines and CI.
 *  - Dates are always computed at runtime; nothing is hardcoded, so the suite
 *    does not rot as the calendar advances.
 *  - Calendar-validity is verified by round-tripping the formatted string,
 *    because `new Date('2027-02-30')` silently rolls over to March.
 */

import { DateRangeError } from './errors';

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export interface DateRange {
  readonly checkin: string;
  readonly checkout: string;
}

export interface DateRangeOptions {
  /** Days from "today" (UTC) at which the stay begins. Default 14. */
  readonly startOffsetDays?: number;
  /** Number of nights; must be >= 1. Default 3. */
  readonly nights?: number;
  /** Anchor date, injected in tests for determinism. */
  readonly from?: Date;
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Format a Date as `YYYY-MM-DD` in UTC. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Parse `YYYY-MM-DD` into a UTC Date, or `null` when not a real calendar date. */
export function parseIsoDate(value: string): Date | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  // Reject roll-overs such as 2027-02-30 -> 2027-03-02.
  return toIsoDate(parsed) === value ? parsed : null;
}

export function isIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

export function isCheckoutAfterCheckin(checkin: string, checkout: string): boolean {
  const start = parseIsoDate(checkin);
  const end = parseIsoDate(checkout);
  if (start === null || end === null) {
    return false;
  }
  return end.getTime() > start.getTime();
}

export function nightsBetween(checkin: string, checkout: string): number {
  const start = parseIsoDate(checkin);
  const end = parseIsoDate(checkout);
  if (start === null || end === null) {
    throw new DateRangeError(`Cannot compute nights for invalid range ${checkin} -> ${checkout}`);
  }
  return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
}

/**
 * Half-open overlap check: [aStart, aEnd) intersects [bStart, bEnd).
 * Two stays that touch at the boundary (checkout === checkin) do NOT overlap.
 */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function assertValidDateRange(checkin: string, checkout: string): void {
  if (!isIsoDate(checkin)) {
    throw new DateRangeError(`checkin is not a valid ISO date: "${checkin}"`);
  }
  if (!isIsoDate(checkout)) {
    throw new DateRangeError(`checkout is not a valid ISO date: "${checkout}"`);
  }
  if (!isCheckoutAfterCheckin(checkin, checkout)) {
    throw new DateRangeError(`checkout (${checkout}) must be strictly after checkin (${checkin})`);
  }
}

/** Build a valid future date range, computed at call time. */
export function createDateRange(options: DateRangeOptions = {}): DateRange {
  const startOffsetDays = options.startOffsetDays ?? 14;
  const nights = options.nights ?? 3;

  if (!Number.isInteger(startOffsetDays) || startOffsetDays < 1) {
    throw new DateRangeError(`startOffsetDays must be an integer >= 1, received ${startOffsetDays}`);
  }
  if (!Number.isInteger(nights) || nights < 1) {
    throw new DateRangeError(`nights must be an integer >= 1, received ${nights}`);
  }

  const anchor = startOfUtcDay(options.from ?? new Date());
  const checkin = addUtcDays(anchor, startOffsetDays);
  const checkout = addUtcDays(checkin, nights);

  return { checkin: toIsoDate(checkin), checkout: toIsoDate(checkout) };
}

/** Shift an existing range by N days, preserving its duration. */
export function shiftRange(range: DateRange, days: number): DateRange {
  const checkin = parseIsoDate(range.checkin);
  const checkout = parseIsoDate(range.checkout);
  if (checkin === null || checkout === null) {
    throw new DateRangeError(`Cannot shift invalid range ${range.checkin} -> ${range.checkout}`);
  }
  return {
    checkin: toIsoDate(addUtcDays(checkin, days)),
    checkout: toIsoDate(addUtcDays(checkout, days)),
  };
}
