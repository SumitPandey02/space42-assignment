import { test, expect } from '../../src/fixtures/api.fixture';
import { ENV } from '../../config/environment';

test.describe('enterprise validation contract @enterprise', () => {
  test.beforeEach(() => {
    test.skip(!ENV.isMock, 'Requires API_MODE=mock: the sandbox returns 500 for missing fields.');
  });

  test('rejects a payload missing required fields with 400 and details', async ({
    transport,
    tokenManager,
  }) => {
    const token = await tokenManager.getToken();

    const response = await transport.send({
      method: 'POST',
      path: '/booking',
      headers: { Cookie: `token=${token}` },
      body: { firstname: 'Incomplete' },
      operation: 'create incomplete booking',
    });

    expect(response.status).toBe(400);
    const body = response.json as { error?: string; details?: string[] };
    expect(body.error).toBe('ValidationError');
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details?.length).toBeGreaterThan(0);
  });

  test('rejects checkout that is not strictly after checkin', async ({
    transport,
    tokenManager,
    factory,
  }) => {
    const token = await tokenManager.getToken();
    const payload = factory.build();
    const swapped = {
      ...payload,
      bookingdates: { checkin: payload.bookingdates.checkout, checkout: payload.bookingdates.checkin },
    };

    const response = await transport.send({
      method: 'POST',
      path: '/booking',
      headers: { Cookie: `token=${token}` },
      body: swapped,
      operation: 'create booking with inverted dates',
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.json)).toMatch(/checkout/i);
  });

  test('rejects malformed JSON with 400', async ({ transport, tokenManager }) => {
    const token = await tokenManager.getToken();

    const response = await transport.send({
      method: 'POST',
      path: '/booking',
      headers: { Cookie: `token=${token}`, 'content-type': 'application/json' },
      body: '{"firstname":',
      operation: 'create booking with malformed JSON',
    });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ error: 'ValidationError' });
  });

  test('rejects PATCH bodies with invalid types', async ({
    bookingApi,
    transport,
    tokenManager,
    factory,
    cleanup,
  }) => {
    const created = await cleanup.create(bookingApi, factory.build());
    const token = await tokenManager.getToken();

    const response = await transport.send({
      method: 'PATCH',
      path: `/booking/${created.bookingid}`,
      headers: { Cookie: `token=${token}` },
      body: { totalprice: 'not-a-number' },
      operation: 'patch with invalid type',
    });

    expect(response.status).toBe(400);
    expect(await bookingApi.getById(created.bookingid)).toEqual(created.booking);
  });

  test('unknown ids return 404 for reads and writes', async ({ bookingApi, transport, tokenManager }) => {
    const missingId = 987_654_321;
    const token = await tokenManager.getToken();

    await expect(bookingApi.getRaw(missingId)).resolves.toMatchObject({ status: 404 });
    await expect(bookingApi.exists(missingId)).resolves.toBe(false);

    const del = await transport.send({
      method: 'DELETE',
      path: `/booking/${missingId}`,
      headers: { Cookie: `token=${token}` },
      operation: 'delete missing booking',
    });
    expect(del.status).toBe(404);
  });
});
