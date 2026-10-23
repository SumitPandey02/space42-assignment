import { test, expect } from '../../src/fixtures/api.fixture';
import { BookingFactory } from '../../src/builders/booking.factory';
import { bookingResponseSchema, bookingSchema } from '../../src/contracts/booking.schema';
import { normaliseBooking } from '../../src/models/booking.model';

test.describe('booking lifecycle @core', () => {
  test('health check responds on /ping @smoke', async ({ bookingApi }) => {
    const response = await bookingApi.ping();

    expect([200, 201]).toContain(response.status);
    expect(response.text.length).toBeGreaterThan(0);
  });

  test('create -> read -> PUT -> delete @smoke', async ({ bookingApi, factory, cleanup }) => {
    const payload = factory.build();

    let id = 0;

    await test.step('create a booking', async () => {
      const response = await bookingApi.create(payload);
      expect(bookingResponseSchema.safeParse(response).success).toBe(true);
      expect(response.bookingid).toBeGreaterThan(0);
      expect(normaliseBooking(response.booking)).toEqual(normaliseBooking(payload));
      id = response.bookingid;
      cleanup.track(id);
    });

    await test.step('read the booking back', async () => {
      const fetched = await bookingApi.getById(id);
      expect(bookingSchema.safeParse(fetched).success).toBe(true);
      expect(normaliseBooking(fetched)).toEqual(normaliseBooking(payload));
      expect(await bookingApi.exists(id)).toBe(true);
    });

    await test.step('replace it with PUT', async () => {
      const update = {
        ...BookingFactory.toUpdatePayload(payload),
        totalprice: payload.totalprice + 50,
        additionalneeds: 'Late checkout',
      };

      const updated = await bookingApi.update(id, update);
      expect(normaliseBooking(updated)).toEqual(normaliseBooking(update));
      expect(normaliseBooking(await bookingApi.getById(id))).toEqual(normaliseBooking(update));
    });

    await test.step('delete the booking and verify the post-deletion state', async () => {
      await bookingApi.remove(id);
      cleanup.untrack(id);

      const after = await bookingApi.getRaw(id);
      // Hosts differ between 403/404 for unknown ids; both mean "gone".
      expect([403, 404]).toContain(after.status);
      expect(await bookingApi.exists(id)).toBe(false);
    });
  });

  test('uses unique, well-formed test data per worker', async ({ factory }) => {
    const first = factory.build();
    const second = factory.build();

    expect(bookingSchema.safeParse(first).success).toBe(true);
    expect(first.firstname).not.toBe(second.firstname);
    expect(first.bookingdates.checkout > first.bookingdates.checkin).toBe(true);
  });
});
