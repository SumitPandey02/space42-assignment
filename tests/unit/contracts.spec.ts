import { test, expect } from '@playwright/test';

import { authResponseSchema, hasToken } from '../../src/contracts/auth.schema';
import {
  bookingCreateSchema,
  bookingPatchSchema,
  bookingResponseSchema,
  bookingSchema,
} from '../../src/contracts/booking.schema';

const validBooking = {
  firstname: 'Shaun',
  lastname: 'Brown',
  totalprice: 150,
  depositpaid: true,
  bookingdates: { checkin: '2026-06-01', checkout: '2026-06-04' },
  additionalneeds: 'Breakfast',
};

test.describe('booking contracts', () => {
  test('accepts a valid booking and strips unknown fields', () => {
    const parsed = bookingCreateSchema.parse({ ...validBooking, bookingid: 1, injected: 'x' });
    expect(parsed).toEqual(validBooking);
  });

  test('rejects missing required fields', () => {
    const parsed = bookingCreateSchema.safeParse({ firstname: 'OnlyName' });
    expect(parsed.success).toBe(false);
  });

  test('rejects calendar-invalid and inverted dates', () => {
    expect(
      bookingCreateSchema.safeParse({
        ...validBooking,
        bookingdates: { checkin: '2027-02-29', checkout: '2027-03-02' },
      }).success,
    ).toBe(false);

    expect(
      bookingCreateSchema.safeParse({
        ...validBooking,
        bookingdates: { checkin: '2026-06-04', checkout: '2026-06-01' },
      }).success,
    ).toBe(false);
  });

  test('rejects wrong primitive types', () => {
    expect(bookingCreateSchema.safeParse({ ...validBooking, totalprice: '150' }).success).toBe(false);
    expect(bookingCreateSchema.safeParse({ ...validBooking, depositpaid: 'true' }).success).toBe(false);
  });

  test('roomid is optional and must be a positive integer when present', () => {
    expect(bookingSchema.safeParse({ ...validBooking, roomid: 42 }).success).toBe(true);
    expect(bookingSchema.safeParse({ ...validBooking, roomid: 0 }).success).toBe(false);
    expect(bookingSchema.safeParse({ ...validBooking, roomid: 1.5 }).success).toBe(false);
  });

  test('PATCH accepts a partial payload', () => {
    expect(bookingPatchSchema.safeParse({ totalprice: 999 }).success).toBe(true);
    expect(bookingPatchSchema.safeParse({}).success).toBe(true);
    expect(bookingPatchSchema.safeParse({ totalprice: '999' }).success).toBe(false);
  });

  test('create response requires a booking id and a valid booking', () => {
    expect(bookingResponseSchema.safeParse({ bookingid: 10, booking: validBooking }).success).toBe(true);
    expect(bookingResponseSchema.safeParse({ booking: validBooking }).success).toBe(false);
    expect(bookingResponseSchema.safeParse({ bookingid: 0, booking: validBooking }).success).toBe(false);
  });
});

test.describe('auth contract', () => {
  test('distinguishes a token response from a bad-credentials response', () => {
    const success = authResponseSchema.parse({ token: 'abc123' });
    const failure = authResponseSchema.parse({ reason: 'Bad credentials' });

    expect(hasToken(success)).toBe(true);
    expect(hasToken(failure)).toBe(false);
  });

  test('rejects responses that contain neither field', () => {
    expect(authResponseSchema.safeParse({}).success).toBe(false);
    expect(authResponseSchema.safeParse({ token: '' }).success).toBe(false);
  });
});
