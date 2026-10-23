import type { TestInfo } from '@playwright/test';

import { test, expect } from '../../src/fixtures/api.fixture';
import { bookingResponseSchema } from '../../src/contracts/booking.schema';
import { BookingFactory } from '../../src/builders/booking.factory';
import { normaliseBooking } from '../../src/models/booking.model';

/**
 * Adaptive host-contract tests.
 *
 * The public sandbox is permissive, while a typical enterprise deployment
 * enforces authentication, overlap rules and optimistic locking. Instead of
 * pretending the sandbox behaves one way, each test accepts both legitimate
 * outcomes, records what actually happened, and still asserts the safety
 * property for that outcome (no phantom record, no corruption, no silent
 * version escalation).
 */
async function recordCapability(testInfo: TestInfo, name: string, data: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(data, null, 2),
    contentType: 'application/json',
  });
}

test.describe('host contract capabilities @core', () => {
  test('unauthenticated writes are either rejected or explicitly accepted', async ({
    bookingApi,
    factory,
    cleanup,
  }, testInfo) => {
    const payload = factory.build();
    const response = await bookingApi.createRaw(payload, { authenticated: false });

    if (response.status === 200 || response.status === 201) {
      const created = bookingResponseSchema.parse(response.json);
      cleanup.track(created.bookingid);

      await recordCapability(testInfo, 'auth-capability', {
        verdict: 'authentication is not enforced on this host',
        status: response.status,
        bookingid: created.bookingid,
      });

      await expect(bookingApi.getById(created.bookingid)).resolves.toMatchObject({
        firstname: payload.firstname,
      });
      return;
    }

    expect([401, 403]).toContain(response.status);
    await recordCapability(testInfo, 'auth-capability', {
      verdict: 'unauthenticated writes are rejected',
      status: response.status,
    });

    await expect(bookingApi.list({ lastname: payload.lastname })).resolves.toHaveLength(0);
  });

  test('duplicate room/date stays are either rejected or explicitly accepted', async ({
    bookingApi,
    factory,
    cleanup,
  }, testInfo) => {
    const roomid = 8_700;
    const first = await cleanup.create(
      bookingApi,
      factory.build({ roomid, startOffsetDays: 220, nights: 3 }),
    );

    const duplicatePayload = factory.build({ roomid, startOffsetDays: 220, nights: 3 });
    const duplicate = await bookingApi.createRaw(duplicatePayload);

    if (duplicate.status === 200 || duplicate.status === 201) {
      const created = bookingResponseSchema.parse(duplicate.json);
      cleanup.track(created.bookingid);

      await recordCapability(testInfo, 'overlap-capability', {
        verdict: 'overlapping stays are accepted; no room-level conflict rule',
        status: duplicate.status,
        firstBookingId: first.bookingid,
        duplicateBookingId: created.bookingid,
      });

      expect(created.bookingid).not.toBe(first.bookingid);
      await expect(bookingApi.exists(first.bookingid)).resolves.toBe(true);
      await expect(bookingApi.exists(created.bookingid)).resolves.toBe(true);
      return;
    }

    expect([400, 409, 422]).toContain(duplicate.status);
    await recordCapability(testInfo, 'overlap-capability', {
      verdict: 'overlapping stays are rejected',
      status: duplicate.status,
      response: duplicate.json,
    });

    await expect(bookingApi.list({ lastname: duplicatePayload.lastname })).resolves.toHaveLength(0);
  });

  test('optimistic locking is either enforced via ETag or absent', async ({
    bookingApi,
    transport,
    tokenManager,
    factory,
    cleanup,
  }, testInfo) => {
    const created = await cleanup.create(bookingApi, factory.build());
    const raw = await bookingApi.getRaw(created.bookingid);
    const etag = raw.headers['etag'];
    const token = await tokenManager.getToken();
    const payload = BookingFactory.toUpdatePayload(created.booking);

    const stale = await transport.send({
      method: 'PUT',
      path: `/booking/${created.bookingid}`,
      body: { ...payload, totalprice: payload.totalprice + 1 },
      headers: { Cookie: `token=${token}`, 'If-Match': '"v999"' },
      operation: 'PUT with stale If-Match',
    });

    if (etag !== undefined && stale.status === 412) {
      await recordCapability(testInfo, 'etag-capability', {
        verdict: 'optimistic locking is enforced',
        etag,
      });

      expect(normaliseBooking(await bookingApi.getById(created.bookingid))).toEqual(
        normaliseBooking(created.booking),
      );

      const current = await transport.send({
        method: 'PUT',
        path: `/booking/${created.bookingid}`,
        body: { ...payload, totalprice: payload.totalprice + 1 },
        headers: { Cookie: `token=${token}`, 'If-Match': etag },
        operation: 'PUT with current If-Match',
      });
      expect(current.status).toBe(200);
      expect(current.headers['etag']).not.toBe(etag);
      return;
    }

    expect(stale.status).toBe(200);
    await recordCapability(testInfo, 'etag-capability', {
      verdict:
        etag === undefined
          ? 'no ETag exposed; If-Match is ignored'
          : 'ETag exposed but If-Match is not enforced',
      ...(etag === undefined ? {} : { etag }),
    });
    expect((await bookingApi.getById(created.bookingid)).totalprice).toBe(payload.totalprice + 1);
  });

  test('invalid payloads are rejected and unknown ids report not-found', async ({
    bookingApi,
    transport,
    tokenManager,
  }, testInfo) => {
    const token = await tokenManager.getToken();

    const missingFields = await transport.send({
      method: 'POST',
      path: '/booking',
      headers: { Cookie: `token=${token}` },
      body: { firstname: 'Incomplete' },
      operation: 'create booking with missing fields',
    });
    expect([400, 422, 500]).toContain(missingFields.status);
    await recordCapability(testInfo, 'validation-capability', {
      missingFieldsStatus: missingFields.status,
    });

    const malformed = await transport.send({
      method: 'POST',
      path: '/booking',
      headers: { Cookie: `token=${token}`, 'content-type': 'application/json' },
      body: '{"firstname":',
      operation: 'create booking with malformed JSON',
    });
    expect(malformed.status).toBe(400);

    const missingId = 987_654_321;
    await expect(bookingApi.getRaw(missingId)).resolves.toMatchObject({ status: 404 });
    await expect(bookingApi.exists(missingId)).resolves.toBe(false);

    const deletion = await transport.send({
      method: 'DELETE',
      path: `/booking/${missingId}`,
      headers: { Cookie: `token=${token}` },
      operation: 'delete missing booking',
    });
    expect([404, 405]).toContain(deletion.status);

    await recordCapability(testInfo, 'not-found-capability', {
      getStatus: 404,
      deleteStatus: deletion.status,
    });
  });
});
