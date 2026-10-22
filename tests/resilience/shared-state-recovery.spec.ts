import { test, expect } from '../../src/fixtures/api.fixture';
import { ApiError } from '../../src/utils/errors';
import { retry } from '../../src/utils/retry';

test.describe('shared sandbox resilience @core', () => {
  test('treats a vanished booking as gone, not as a framework failure', async ({
    bookingApi,
    factory,
    cleanup,
  }) => {
    const created = await cleanup.create(bookingApi, factory.build());
    const id = created.bookingid;

    // Simulate another actor (or the sandbox's scheduled purge) deleting it.
    await bookingApi.remove(id);
    cleanup.untrack(id);

    const probe = await bookingApi.getRaw(id);
    expect([403, 404]).toContain(probe.status);
    await expect(bookingApi.exists(id)).resolves.toBe(false);

    // Recovery: rebuild the prerequisite with fresh, test-owned data.
    const replacement = await cleanup.create(
      bookingApi,
      factory.build({ firstname: created.booking.firstname }),
    );
    expect(replacement.bookingid).not.toBe(id);
    await expect(bookingApi.getById(replacement.bookingid)).resolves.toMatchObject({
      firstname: created.booking.firstname,
    });
  });

  test('bounded retries surface an actionable error instead of hanging', async ({
    bookingApi,
    factory,
    cleanup,
  }) => {
    const created = await cleanup.create(bookingApi, factory.build());
    const id = created.bookingid;
    await bookingApi.remove(id);
    cleanup.untrack(id);

    let attempts = 0;
    const failure = await retry(
      async () => {
        attempts += 1;
        const response = await bookingApi.getRaw(id);
        if (response.status !== 200) {
          throw new ApiError({
            method: 'GET',
            url: response.url,
            status: response.status,
            responseBody: response.json ?? response.text,
            message: 'prerequisite booking is missing',
          });
        }
        return response;
      },
      {
        retries: 2,
        baseDelayMs: 1,
        jitterRatio: 0,
        sleep: async () => undefined,
        operation: `resolve booking ${id}`,
      },
    ).catch((error: unknown) => error);

    expect(attempts).toBe(3);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toContain('prerequisite booking is missing');
  });

  test('only test-owned ids are ever cleaned up', async ({ bookingApi, factory, cleanup }) => {
    const first = await cleanup.create(bookingApi, factory.build());
    const second = await cleanup.create(bookingApi, factory.build());

    await bookingApi.remove(first.bookingid);
    cleanup.untrack(first.bookingid);

    expect(await bookingApi.exists(first.bookingid)).toBe(false);
    expect(await bookingApi.exists(second.bookingid)).toBe(true);
    expect(cleanup.trackedIds).toEqual([second.bookingid]);
  });
});
