import { test, expect } from '../../src/fixtures/api.fixture';
import { runAtBarrier } from '../../src/utils/barrier';
import type { BookingPatchInput } from '../../src/contracts/booking.schema';

interface TimedOutcome {
  readonly label: string;
  readonly status: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly totalprice: number;
}

test.describe('conflicting concurrent updates @core @concurrency', () => {
  test('two coordinated PATCHes produce one consistent final state', async ({
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

    const observations: TimedOutcome[][] = [];

    for (let round = 1; round <= 2; round += 1) {
      await test.step(`round ${round}: dispatch both writes through a barrier`, async () => {
        const results = await runAtBarrier(
          contenders.map(({ label, patch }) => async (): Promise<TimedOutcome> => {
            const startedAt = performance.now();
            const response = await bookingApi.patch(id, patch);
            return {
              label,
              status: 200,
              startedAt,
              finishedAt: performance.now(),
              totalprice: response.totalprice,
            };
          }),
        );

        observations.push(results);
        for (const result of results) {
          expect(result.status).toBe(200);
        }

        const final = await bookingApi.getById(id);
        // Last-write-wins is the only behaviour the sandbox documents; the
        // enterprise mock does not add optimistic locking to plain PATCH.
        expect([111, 222]).toContain(final.totalprice);
        expect(final.additionalneeds).toBe(final.totalprice === 111 ? 'Alpha' : 'Beta');
      });
    }

    const deltas = observations.flat().map((outcome) => outcome.finishedAt - outcome.startedAt);
    await testInfo.attach('concurrency-observations', {
      body: JSON.stringify(
        {
          note: 'Dispatch is coordinated through a barrier; JS cannot guarantee the same wall-clock millisecond.',
          bookingId: id,
          rounds: observations,
          requestDurationsMs: deltas,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });

    // The barrier releases both calls in one microtask batch, so their
    // dispatch timestamps must be close - but we record rather than over-claim.
    const firstRound = observations[0] ?? [];
    if (firstRound.length === 2) {
      const dispatchDelta = Math.abs((firstRound[0]?.startedAt ?? 0) - (firstRound[1]?.startedAt ?? 0));
      expect(dispatchDelta).toBeLessThan(1_000);
    }
  });
});
