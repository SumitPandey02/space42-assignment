import { test, expect } from '../../src/fixtures/api.fixture';
import { ENV } from '../../config/environment';
import { BookingFactory } from '../../src/builders/booking.factory';
import { normaliseBooking } from '../../src/models/booking.model';

test.describe('enterprise optimistic locking @enterprise', () => {
  test.beforeEach(() => {
    test.skip(!ENV.isMock, 'Requires API_MODE=mock: the public sandbox does not expose ETags.');
  });

  test('exposes an ETag and rejects a stale If-Match with 412', async ({
    bookingApi,
    transport,
    tokenManager,
    factory,
    cleanup,
  }) => {
    const created = await cleanup.create(bookingApi, factory.build());
    const raw = await bookingApi.getRaw(created.bookingid);
    const currentEtag = raw.headers['etag'];

    expect(currentEtag).toMatch(/^"v\d+"$/);

    const payload = {
      ...BookingFactory.toUpdatePayload(created.booking),
      totalprice: created.booking.totalprice + 1,
    };
    const token = await tokenManager.getToken();

    const stale = await transport.send({
      method: 'PUT',
      path: `/booking/${created.bookingid}`,
      body: payload,
      headers: { Cookie: `token=${token}`, 'If-Match': '"v999"' },
      operation: 'PUT with stale If-Match',
    });

    expect(stale.status).toBe(412);
    expect(stale.json).toMatchObject({ error: 'PreconditionFailed' });
    expect(normaliseBooking(await bookingApi.getById(created.bookingid))).toEqual(
      normaliseBooking(created.booking),
    );

    const current = await transport.send({
      method: 'PUT',
      path: `/booking/${created.bookingid}`,
      body: payload,
      headers: { Cookie: `token=${token}`, 'If-Match': currentEtag ?? '' },
      operation: 'PUT with current If-Match',
    });

    expect(current.status).toBe(200);
    expect(current.headers['etag']).not.toBe(currentEtag);
    expect(normaliseBooking(await bookingApi.getById(created.bookingid))).toEqual(normaliseBooking(payload));
  });
});
