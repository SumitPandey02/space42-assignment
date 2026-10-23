import { test, expect } from '../../src/fixtures/api.fixture';
import { bookingSchema, type BookingPatchInput } from '../../src/contracts/booking.schema';

interface TimedOutcome {
  readonly label: string;
  readonly status: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly totalprice: number | undefined;
}

function runTogether<T>(tasks: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
  if (tasks.length === 0) {
    return Promise.resolve([]);
  }

  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = tasks.map(async (task) => {
    await gate;
    return task();
  });
  release();
  return Promise.all(running);
}

test.describe('conflicting concurrent updates @core @concurrency', () => {
  test('two concurrent PATCHes produce one consistent final state', async ({
    bookingApi,
    factory,
    cleanup,
  }, testInfo) => {
    const created = await cleanup.create(bookingApi, factory.build());
    const id = created.bookingid;

    const contenders: ReadonlyArray<{ label: string; patch: BookingPatchInput }> = [
      { label: 'alpha', patch: { totalprice: 111, additionalneeds: 'Alpha' } },
      { label: 'beta', patch: { totalprice: 222, additionalneeds: 'Beta' } },
    ];

    const results = await runTogether(
      contenders.map(({ label, patch }) => async (): Promise<TimedOutcome> => {
        const startedAt = performance.now();
        const response = await bookingApi.patchRaw(id, patch);
        const parsed = bookingSchema.safeParse(response.json);
        return {
          label,
          status: response.status,
          startedAt,
          finishedAt: performance.now(),
          totalprice: parsed.success ? parsed.data.totalprice : undefined,
        };
      }),
    );

    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.totalprice).toBeDefined();
    }

    const final = await bookingApi.getById(id);
    // Last-write-wins is the behaviour observed on the public sandbox.
    expect([111, 222]).toContain(final.totalprice);
    expect(final.additionalneeds).toBe(final.totalprice === 111 ? 'Alpha' : 'Beta');

    await testInfo.attach('concurrency-observations', {
      body: JSON.stringify(
        {
          bookingId: id,
          results,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  });
});
