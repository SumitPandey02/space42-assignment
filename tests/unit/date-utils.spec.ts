import { test, expect } from '@playwright/test';

import {
  assertValidDateRange,
  createDateRange,
  isCheckoutAfterCheckin,
  isIsoDate,
  nightsBetween,
  parseIsoDate,
  rangesOverlap,
  shiftRange,
} from '../../src/utils/date-utils';
import { DateRangeError } from '../../src/utils/errors';

const anchor = new Date(Date.UTC(2026, 0, 15, 23, 45));

test.describe('date utilities', () => {
  test('formats and parses ISO dates without timezone drift', () => {
    expect(createDateRange({ startOffsetDays: 1, nights: 3, from: anchor })).toEqual({
      checkin: '2026-01-16',
      checkout: '2026-01-19',
    });
  });

  test('rejects calendar-invalid dates instead of rolling them over', () => {
    expect(isIsoDate('2027-02-28')).toBe(true);
    expect(isIsoDate('2027-02-29')).toBe(false);
    expect(parseIsoDate('2027-02-29')).toBeNull();
  });

  test('computes nights and validates ordering', () => {
    expect(nightsBetween('2026-03-01', '2026-03-04')).toBe(3);
    expect(isCheckoutAfterCheckin('2026-03-01', '2026-03-01')).toBe(false);
    expect(isCheckoutAfterCheckin('2026-03-01', '2026-02-28')).toBe(false);
    expect(isCheckoutAfterCheckin('2026-03-01', '2026-03-02')).toBe(true);
  });

  test('treats ranges as half-open when detecting overlap', () => {
    expect(rangesOverlap('2026-03-01', '2026-03-04', '2026-03-03', '2026-03-06')).toBe(true);
    expect(rangesOverlap('2026-03-01', '2026-03-04', '2026-03-04', '2026-03-06')).toBe(false);
    expect(rangesOverlap('2026-03-01', '2026-03-04', '2026-02-27', '2026-03-01')).toBe(false);
    expect(rangesOverlap('2026-03-01', '2026-03-04', '2026-03-02', '2026-03-03')).toBe(true);
  });

  test('shifts a range and keeps its duration', () => {
    const shifted = shiftRange({ checkin: '2026-03-01', checkout: '2026-03-04' }, 10);
    expect(shifted).toEqual({ checkin: '2026-03-11', checkout: '2026-03-14' });
  });

  test('rejects invalid ranges with actionable errors', () => {
    expect(() => assertValidDateRange('2026-03-04', '2026-03-04')).toThrow(/checkout/i);
    expect(() => createDateRange({ startOffsetDays: 0 })).toThrow(DateRangeError);
    expect(parseIsoDate('2026-02-30')).toBeNull();
  });
});
