import { test, expect } from '@playwright/test';

import type { Credentials } from '../../config/environment';
import type { AuthTokenFetcher } from '../../src/clients/auth.client';
import { TokenManager } from '../../src/auth/token-manager';
import type { Logger } from '../../src/utils/logger';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

const credentials: Credentials = { username: 'admin', password: 'password123' };

class ScriptedFetcher implements AuthTokenFetcher {
  calls = 0;

  constructor(private readonly respond: (call: number) => Promise<string>) {}

  fetchToken(): Promise<string> {
    this.calls += 1;
    return this.respond(this.calls);
  }
}

function makeManager(fetcher: AuthTokenFetcher, ttlMs = 60_000, clock?: () => number): TokenManager {
  return new TokenManager({
    fetcher,
    credentials,
    ttlMs,
    logger,
    ...(clock === undefined ? {} : { clock }),
  });
}

test.describe('TokenManager', () => {
  test('reuses a cached token instead of authenticating per call', async () => {
    const fetcher = new ScriptedFetcher(async () => 'token-1');
    const manager = makeManager(fetcher);

    await expect(manager.getToken()).resolves.toBe('token-1');
    await expect(manager.getToken()).resolves.toBe('token-1');
    await expect(manager.getToken()).resolves.toBe('token-1');

    expect(fetcher.calls).toBe(1);
    expect(manager.stats).toMatchObject({ acquisitions: 1, cacheHits: 2 });
  });

  test('refreshes once the TTL threshold is reached', async () => {
    let now = 1_000;
    let sequence = 0;
    const fetcher = new ScriptedFetcher(async () => `token-${(sequence += 1)}`);
    const manager = makeManager(fetcher, 1_000, () => now);

    await expect(manager.getToken()).resolves.toBe('token-1');
    now = 1_500;
    await expect(manager.getToken()).resolves.toBe('token-1');
    now = 2_001;
    await expect(manager.getToken()).resolves.toBe('token-2');

    expect(fetcher.calls).toBe(2);
  });

  test('single-flight: concurrent callers share one acquisition', async () => {
    let release: ((token: string) => void) | undefined;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const fetcher = new ScriptedFetcher(() => gate);
    const manager = makeManager(fetcher);

    const pending = Array.from({ length: 8 }, () => manager.getToken());
    release?.('shared-token');

    await expect(Promise.all(pending)).resolves.toEqual(Array(8).fill('shared-token'));
    expect(fetcher.calls).toBe(1);
  });

  test('a failed refresh leaves no stale token and no poisoned promise', async () => {
    const fetcher = new ScriptedFetcher(async (call) => {
      if (call === 1) throw new Error('auth endpoint unavailable');
      return 'recovered';
    });
    const manager = makeManager(fetcher);

    await expect(manager.getToken()).rejects.toThrow('auth endpoint unavailable');
    expect(manager.hasCachedToken).toBe(false);

    await expect(manager.getToken()).resolves.toBe('recovered');
    expect(fetcher.calls).toBe(2);
  });

  test('invalidate drops the cache so the next call re-authenticates', async () => {
    const fetcher = new ScriptedFetcher(async (call) => `token-${call}`);
    const manager = makeManager(fetcher);

    await expect(manager.getToken()).resolves.toBe('token-1');
    manager.invalidate();
    expect(manager.hasCachedToken).toBe(false);

    await expect(manager.getToken()).resolves.toBe('token-2');
    expect(manager.stats).toMatchObject({ acquisitions: 2, invalidations: 1 });
  });

  test('forceRefresh bypasses a fresh cache', async () => {
    const fetcher = new ScriptedFetcher(async (call) => `token-${call}`);
    const manager = makeManager(fetcher);

    await manager.getToken();
    await expect(manager.getToken({ forceRefresh: true })).resolves.toBe('token-2');
    expect(fetcher.calls).toBe(2);
  });

  test('rejects an invalid TTL at construction time', () => {
    expect(() => makeManager(new ScriptedFetcher(async () => 'x'), 0)).toThrow(/TTL/);
  });
});
