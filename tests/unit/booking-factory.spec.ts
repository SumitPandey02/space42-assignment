import { test, expect } from '@playwright/test';

import { bookingCreateSchema } from '../../src/contracts/booking.schema';
import { BookingFactory } from '../../src/builders/booking.factory';

const from = new Date(Date.UTC(2026, 4, 1));

test.describe('BookingFactory', () => {
  test('produces payloads that satisfy the contract', () => {
    const factory = new BookingFactory({ workerIndex: 0, from });
    const booking = factory.build();

    expect(bookingCreateSchema.safeParse(booking).success).toBe(true);
    expect(booking.bookingdates.checkin).toBe('2026-06-01');
    expect(booking.bookingdates.checkout > booking.bookingdates.checkin).toBe(true);
  });

  test('names are unique per worker and per call', () => {
    const factory = new BookingFactory({ workerIndex: 2, from });
    const first = factory.build();
    const second = factory.build();

    expect(first.firstname).not.toBe(second.firstname);
    expect(first.roomid).not.toBe(second.roomid);
    expect(first.firstname).toContain('-2-');
  });

  test('overrides win while nested dates are merged', () => {
    const factory = new BookingFactory({ workerIndex: 1, from });
    const booking = factory.build({
      firstname: 'Explicit',
      bookingdates: { checkout: '2026-05-12' },
      startOffsetDays: 1,
      nights: 5,
    });

    expect(booking.firstname).toBe('Explicit');
    expect(booking.bookingdates.checkin).toBe('2026-05-02');
    expect(booking.bookingdates.checkout).toBe('2026-05-12');
  });

  test('can intentionally create an overlapping payload', () => {
    const factory = new BookingFactory({ workerIndex: 0, from });
    const first = factory.build({ roomid: 77, startOffsetDays: 40, nights: 3 });
    const second = factory.build({ roomid: 77, startOffsetDays: 40, nights: 3 });

    expect(first.roomid).toBe(77);
    expect(second.roomid).toBe(77);
    expect(first.bookingdates).toEqual(second.bookingdates);
    expect(first.firstname).not.toBe(second.firstname);
  });

  test('derives a full PUT payload from a persisted booking', () => {
    const factory = new BookingFactory({ workerIndex: 0, from });
    const created = factory.build();
    const update = BookingFactory.toUpdatePayload(created);

    expect(update).toEqual(created);
  });
});
