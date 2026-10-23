import { test, expect } from '../../src/fixtures/api.fixture';
import { ENV } from '../../config/environment';
import { bookingResponseSchema } from '../../src/contracts/booking.schema';
import { hasToken } from '../../src/contracts/auth.schema';

/**
 * Observations of the real restful-booker sandbox.
 *
 * These assertions document the host's actual behaviour - including its
 * deviations from a conventional enterprise API. They are skipped anywhere the
 * target is not the public sandbox. Per-request capability checks live in
 * tests/contracts/host-capabilities.spec.ts.
 */
test.describe('public sandbox observations @sandbox-behaviour', () => {
  test.beforeEach(() => {
    test.skip(!ENV.runBehaviourTests, 'Only meaningful against the real public sandbox (API_ENV=prod).');
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

  test('DELETE returns 201 Created', async ({ bookingApi, factory, cleanup }) => {
    const created = await bookingApi.create(factory.build());
    cleanup.track(created.bookingid);

    const removed = await bookingApi.deleteRaw(created.bookingid);
    expect(removed.status).toBe(201);
    cleanup.untrack(created.bookingid);
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
