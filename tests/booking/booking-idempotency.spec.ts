import { test, expect } from '../../src/fixtures/api.fixture';
import { BookingFactory } from '../../src/builders/booking.factory';
import { normaliseBooking } from '../../src/models/booking.model';

test.describe('idempotency and retry safety @core', () => {
  test('repeating the same PUT three times converges on the same state', async ({
    bookingApi,
    factory,
    cleanup,
  }) => {
    const created = await cleanup.create(bookingApi, factory.build());
    const payload = BookingFactory.toUpdatePayload(created.booking);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await test.step(`PUT attempt ${attempt}`, async () => {
        const updated = await bookingApi.update(created.bookingid, payload);
        expect(normaliseBooking(updated)).toEqual(normaliseBooking(payload));

        const persisted = await bookingApi.getById(created.bookingid);
        expect(normaliseBooking(persisted)).toEqual(normaliseBooking(payload));
      });
    }

    const owned = await bookingApi.list({ lastname: payload.lastname });
    const withOurId = owned.filter((summary) => summary.bookingid === created.bookingid);
    expect(withOurId).toHaveLength(1);

    // The API exposes no version/ETag on the sandbox, so we assert state
    // idempotence only - never invented version metadata.
    const final = await bookingApi.getById(created.bookingid);
    expect(normaliseBooking(final)).toEqual(normaliseBooking(payload));
  });
});
