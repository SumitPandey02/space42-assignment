import { test, expect } from '@playwright/test';

import { computeBackoffDelay, retry } from '../../src/utils/retry';

test.describe('retry utility', () => {
  test('returns the first successful result without sleeping', async () => {
    let attempts = 0;
    const result = await retry(
      async () => {
        attempts += 1;
        return 'ok';
      },
      { retries: 3, sleep: async () => undefined },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(1);
  });

  test('retries transient failures up to the configured budget', async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await retry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('transient');
        return attempts;
      },
      {
        retries: 2,
        baseDelayMs: 10,
        jitterRatio: 0,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  test('does not retry when isRetryable returns false', async () => {
    let attempts = 0;
    await expect(
      retry(
        async () => {
          attempts += 1;
          throw new Error('fatal');
        },
        { retries: 5, isRetryable: () => false, sleep: async () => undefined },
      ),
    ).rejects.toThrow('fatal');

    expect(attempts).toBe(1);
  });

  test('stops retrying when the abort signal fires', async () => {
    const controller = new AbortController();
    let attempts = 0;

    await expect(
      retry(
        async () => {
          attempts += 1;
          controller.abort(new Error('cancelled by test'));
          throw new Error('transient');
        },
        { retries: 5, jitterRatio: 0, sleep: async () => undefined, signal: controller.signal },
      ),
    ).rejects.toThrow('cancelled by test');

    expect(attempts).toBe(1);
  });

  test('backoff is exponential, bounded and deterministic without jitter', () => {
    const base = { baseDelayMs: 100, maxDelayMs: 250, jitterRatio: 0, random: () => 0.5 };
    expect(computeBackoffDelay({ ...base, attempt: 1 })).toBe(100);
    expect(computeBackoffDelay({ ...base, attempt: 2 })).toBe(200);
    expect(computeBackoffDelay({ ...base, attempt: 3 })).toBe(250);
    expect(computeBackoffDelay({ ...base, attempt: 10 })).toBe(250);
  });

  test('jitter stays within the configured band', () => {
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = computeBackoffDelay({
        attempt: 3,
        baseDelayMs: 100,
        maxDelayMs: 10_000,
        jitterRatio: 0.2,
        random: () => random,
      });
      expect(delay).toBeGreaterThanOrEqual(320);
      expect(delay).toBeLessThanOrEqual(480);
    }
  });
});
