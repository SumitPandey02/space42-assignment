import { test, expect } from '../../src/fixtures/api.fixture';
import { ENV } from '../../config/environment';
import { BookingFactory } from '../../src/builders/booking.factory';

test.describe('enterprise room-overlap contract @enterprise', () => {
  test.beforeEach(() => {
    test.skip(!ENV.isMock, 'Requires API_MODE=mock: the public sandbox allows overlapping bookings.');
  });

  test('rejects a duplicate stay for the same room with 409', async ({ bookingApi, factory, cleanup }) => {
    await cleanup.create(bookingApi, factory.build({ roomid: 501, startOffsetDays: 120, nights: 3 }));

    const duplicate = factory.build({ roomid: 501, startOffsetDays: 120, nights: 3 });
    const response = await bookingApi.createRaw(duplicate);

    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({ error: 'Conflict' });
    expect(JSON.stringify(response.json)).toMatch(/overlap/i);

    // The rejected booking was not persisted.
    const owned = await bookingApi.list({ lastname: duplicate.lastname });
    expect(owned).toHaveLength(0);
  });

  test('accepts the same dates in a different room', async ({ bookingApi, factory, cleanup }) => {
    await cleanup.create(bookingApi, factory.build({ roomid: 502, startOffsetDays: 130, nights: 3 }));
    const second = await cleanup.create(
      bookingApi,
      factory.build({ roomid: 503, startOffsetDays: 130, nights: 3 }),
    );

    expect(second.bookingid).toBeGreaterThan(0);
  });

  test('rejects a PUT that would move a booking onto an occupied window', async ({
    bookingApi,
    factory,
    cleanup,
  }) => {
    const blocker = await cleanup.create(
      bookingApi,
      factory.build({ roomid: 504, startOffsetDays: 140, nights: 3 }),
    );
    const movable = await cleanup.create(
      bookingApi,
      factory.build({ roomid: 504, startOffsetDays: 160, nights: 3 }),
    );

    const response = await bookingApi.updateRaw(
      movable.bookingid,
      BookingFactory.toUpdatePayload(movable.booking),
    );

    // Same window as itself is not a conflict.
    expect(response.status).toBe(200);

    const conflicting = await bookingApi.updateRaw(movable.bookingid, {
      ...BookingFactory.toUpdatePayload(movable.booking),
      bookingdates: blocker.booking.bookingdates,
    });
    expect(conflicting.status).toBe(409);

    const persisted = await bookingApi.getById(movable.bookingid);
    expect(persisted.bookingdates).toEqual(movable.booking.bookingdates);
  });
});
