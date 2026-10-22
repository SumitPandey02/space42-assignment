import { test, expect } from '../../src/fixtures/api.fixture';
import { ENV } from '../../config/environment';
import { ForbiddenError } from '../../src/utils/errors';

/**
 * These contracts cannot be observed on the public sandbox, which accepts
 * unauthenticated writes. They are verified against the deterministic mock only.
 */
test.describe('enterprise authorization contract @enterprise', () => {
  test.beforeEach(() => {
    test.skip(!ENV.isMock, 'Requires API_MODE=mock: the public sandbox does not enforce authentication.');
  });

  test('a write without a token is rejected with 401', async ({ bookingApi, factory }) => {
    const response = await bookingApi.createRaw(factory.build(), { authenticated: false });

    expect(response.status).toBe(401);
    expect(response.json).toMatchObject({ error: 'Unauthorized' });
  });

  test('a garbage token is rejected with 401', async ({ transport, factory }) => {
    const response = await transport.send({
      method: 'POST',
      path: '/booking',
      headers: { Cookie: 'token=not-a-real-token' },
      body: factory.build(),
      operation: 'unauthenticated create',
    });

    expect(response.status).toBe(401);
  });

  test('a read-only viewer gets 403 and the token is not refreshed', async ({
    viewerBookingApi,
    viewerTokenManager,
    factory,
  }) => {
    await viewerTokenManager.getToken();
    const before = viewerTokenManager.stats;

    await expect(viewerBookingApi.create(factory.build())).rejects.toBeInstanceOf(ForbiddenError);

    const after = viewerTokenManager.stats;
    // 403 is an authorization failure: refreshing the token cannot fix it.
    expect(after.acquisitions - before.acquisitions).toBe(0);
    expect(after.invalidations - before.invalidations).toBe(0);
  });

  test('a viewer cannot modify an existing booking', async ({
    bookingApi,
    viewerBookingApi,
    factory,
    cleanup,
  }) => {
    const created = await cleanup.create(bookingApi, factory.build());

    await expect(
      viewerBookingApi.patch(created.bookingid, { totalprice: created.booking.totalprice + 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('a 401 mid-suite refreshes the token once and replays the write', async ({
    bookingApi,
    tokenManager,
    mockControl,
    factory,
    cleanup,
  }) => {
    const stale = await tokenManager.getToken();
    await mockControl.expireToken(stale);

    const before = tokenManager.stats;
    const created = await cleanup.create(bookingApi, factory.build());

    expect(created.bookingid).toBeGreaterThan(0);
    expect(tokenManager.stats.acquisitions - before.acquisitions).toBe(1);
    expect(tokenManager.stats.invalidations - before.invalidations).toBeGreaterThanOrEqual(1);
  });
});
