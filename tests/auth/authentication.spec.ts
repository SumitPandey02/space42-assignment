import { test, expect } from '../../src/fixtures/api.fixture';
import { ENV } from '../../config/environment';
import { authFailureSchema, hasToken } from '../../src/contracts/auth.schema';

test.describe('authentication @core', () => {
  test('exchanges valid credentials for a token @smoke', async ({ authClient }) => {
    const { response, body } = await authClient.authenticate(ENV.credentials);

    expect(response.status).toBe(200);
    expect(hasToken(body)).toBe(true);
    if (hasToken(body)) {
      expect(body.token.length).toBeGreaterThan(0);
    }
  });

  test('bad credentials are rejected without a token', async ({ authClient }) => {
    const { response, body } = await authClient.authenticate({
      username: 'not-a-real-user',
      password: 'not-a-real-password',
    });

    // Verified sandbox quirk: bad credentials still return HTTP 200. The token's
    // presence - not the status code - is the contract signal.
    expect(response.status).toBe(200);
    expect(hasToken(body)).toBe(false);
    expect(authFailureSchema.safeParse(body).success).toBe(true);
  });

  test('the token is cached and reused across calls', async ({ tokenManager }) => {
    const acquisitionsBefore = tokenManager.stats.acquisitions;
    const cacheHitsBefore = tokenManager.stats.cacheHits;

    const first = await tokenManager.getToken();
    const second = await tokenManager.getToken();

    expect(second).toBe(first);
    expect(tokenManager.stats.acquisitions - acquisitionsBefore).toBeLessThanOrEqual(1);
    expect(tokenManager.stats.cacheHits).toBeGreaterThan(cacheHitsBefore);
  });

  test('a booking write succeeds with the managed token @smoke', async ({ bookingApi, factory, cleanup }) => {
    const payload = factory.build();
    const created = await cleanup.create(bookingApi, payload);

    expect(created.bookingid).toBeGreaterThan(0);
    expect(created.booking.firstname).toBe(payload.firstname);
  });

  test('concurrent getToken calls share a single-flight acquisition', async ({ tokenManager }) => {
    tokenManager.invalidate();
    const acquisitionsBefore = tokenManager.stats.acquisitions;
    const [first, second, third] = await Promise.all([
      tokenManager.getToken(),
      tokenManager.getToken(),
      tokenManager.getToken(),
    ]);

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(tokenManager.stats.acquisitions - acquisitionsBefore).toBe(1);
  });
});
