/**
 * Date helpers for booking payloads.
 *
 * Design rules:
 *  - Everything is UTC. No local-timezone drift between developer machines and CI.
 *  - Dates are always computed at runtime; nothing is hardcoded, so the suite
 *    does not rot as the calendar advances.
 */

import { DateRangeError } from './errors';

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

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Format a Date as `YYYY-MM-DD` in UTC. */
function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
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
