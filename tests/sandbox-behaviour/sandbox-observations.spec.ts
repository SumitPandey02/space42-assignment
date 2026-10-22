import { test, expect } from '../../src/fixtures/api.fixture';
import { ENV } from '../../config/environment';
import { bookingResponseSchema } from '../../src/contracts/booking.schema';
import { hasToken } from '../../src/contracts/auth.schema';

/**
 * Observations of the real restful-booker sandbox.
 *
 * These assertions document the host's actual behaviour - including its
 * deviations from a conventional enterprise API. They are skipped anywhere the
 * target is not the public sandbox, and the enterprise mock never pretends to
 * reproduce them.
 */
test.describe('public sandbox observations @sandbox-behaviour', () => {
  test.beforeEach(() => {
    test.skip(
      !ENV.runBehaviourTests,
      'Only meaningful against the real public sandbox (API_MODE=real, API_ENV=prod).',
    );
  });

  test('ping answers 201 Created rather than 200', async ({ bookingApi }) => {
    const response = await bookingApi.ping();
    expect(response.status).toBe(201);
    expect(response.text.trim()).toBe('Created');
  });

  test('POST /auth returns a bare token with no expiry metadata', async ({ authClient }) => {
    const { body } = await authClient.authenticate(ENV.credentials);
    expect(hasToken(body)).toBe(true);
    if (hasToken(body)) {
      expect(Object.keys(body)).toEqual(['token']);
    }
  });

  test('creating a booking returns 200 and silently drops roomid', async ({
    bookingApi,
    factory,
    cleanup,
  }) => {
    const payload = factory.build();
    const raw = await bookingApi.createRaw(payload);
    const response = bookingResponseSchema.parse(raw.json);
    cleanup.track(response.bookingid);

    expect(raw.status).toBe(200);
    expect(response.booking.roomid).toBeUndefined();

    const fetched = await bookingApi.getById(response.bookingid);
    expect(fetched.roomid).toBeUndefined();
  });

  test('overlapping bookings are accepted (no room-level rule)', async ({ bookingApi, factory, cleanup }) => {
    const room = 8_888;
    const first = await bookingApi.create(factory.build({ roomid: room, startOffsetDays: 200, nights: 3 }));
    cleanup.track(first.bookingid);

    const second = await bookingApi.create(factory.build({ roomid: room, startOffsetDays: 200, nights: 3 }));
    cleanup.track(second.bookingid);

    expect(second.bookingid).not.toBe(first.bookingid);
    expect(await bookingApi.exists(first.bookingid)).toBe(true);
    expect(await bookingApi.exists(second.bookingid)).toBe(true);
  });

  test('writes do not require authentication', async ({ bookingApi, factory, cleanup }) => {
    const response = await bookingApi.createRaw(factory.build(), { authenticated: false });
    expect(response.status).toBe(200);

    const parsed = bookingResponseSchema.parse(response.json);
    cleanup.track(parsed.bookingid);
  });

  test('DELETE returns 201 Created, and unknown ids return 405', async ({ bookingApi, factory, cleanup }) => {
    const created = await bookingApi.create(factory.build());
    cleanup.track(created.bookingid);

    const removed = await bookingApi.deleteRaw(created.bookingid);
    expect(removed.status).toBe(201);
    cleanup.untrack(created.bookingid);

    // Verified against the live sandbox: unknown ids answer 405, not 403/404.
    const missing = await bookingApi.deleteRaw(987_654_321);
    expect(missing.status).toBe(405);
  });

  test('missing required fields surface as 500, not 400', async ({ transport, tokenManager }) => {
    const token = await tokenManager.getToken();
    const response = await transport.send({
      method: 'POST',
      path: '/booking',
      headers: { Cookie: `token=${token}` },
      body: { firstname: 'Incomplete' },
      operation: 'create incomplete booking on sandbox',
    });

    expect(response.status).toBe(500);
  });

  test('non-numeric booking ids return 404', async ({ bookingApi }) => {
    const response = await bookingApi.getRaw(Number.NaN);
    expect(response.status).toBe(404);
  });

  test('the depositpaid filter is ignored by the host', async ({ bookingApi, factory, cleanup }) => {
    const created = await cleanup.create(bookingApi, factory.build({ depositpaid: true }));

    const opposite = await bookingApi.list({ lastname: created.booking.lastname, depositpaid: false });

    // A filter that worked would exclude this deposit-paid booking. The host
    // returns it anyway, so we record the observed (non-)behaviour instead of
    // pretending the filter is reliable.
    expect(opposite.map((entry) => entry.bookingid)).toContain(created.bookingid);
  });
});
