/**
 * Playwright fixtures.
 *
 * Scope decisions:
 *   - Worker scope for the HTTP context, transport, token manager and factory.
 *     A worker runs many tests sequentially, so the token is acquired once and
 *     reused (requirement: "avoid refreshing for every test"), and the factory
 *     sequence keeps data unique within that worker.
 *   - Test scope for cleanup. Every booking created through the tracker is
 *     deleted at the end of the test, even when the test fails, and only ever
 *     by ID that the test itself registered.
 *
 * Diagnostics: when a test fails, the sanitised HTTP exchange history is
 * attached to the Allure report. Tokens and cookies are redacted by
 * `HttpTransport.record` before the data ever reaches the attachment.
 */

import { request as playwrightRequest, test as base, expect, type APIRequestContext } from '@playwright/test';

import { ENV } from '../../config/environment';
import { TokenManager } from '../auth/token-manager';
import { BookingFactory } from '../builders/booking.factory';
import { AuthClient } from '../clients/auth.client';
import { BookingClient } from '../clients/booking.client';
import { HttpTransport } from '../clients/http-client';
import type { BookingCreateInput, BookingResponse } from '../contracts/booking.schema';
import { createApiExchangeLogger } from '../reporting/api-exchange-logger';
import { createLogger } from '../utils/logger';

const logger = createLogger('fixtures');

export interface CleanupTracker {
  track(id: number): void;
  untrack(id: number): void;
  /** Create and immediately register the booking for teardown. */
  create(api: BookingClient, payload: BookingCreateInput): Promise<BookingResponse>;
  readonly trackedIds: readonly number[];
}

interface TestFixtures {
  cleanup: CleanupTracker;
}

interface WorkerFixtures {
  apiContext: APIRequestContext;
  transport: HttpTransport;
  authClient: AuthClient;
  tokenManager: TokenManager;
  bookingApi: BookingClient;
  factory: BookingFactory;
}

function createTransport(context: APIRequestContext): HttpTransport {
  return new HttpTransport(context, {
    baseUrl: ENV.baseUrl,
    requestTimeoutMs: ENV.requestTimeoutMs,
    logger,
    exchangeLogger: createApiExchangeLogger(ENV.apiLogging, logger),
  });
}

class Tracker implements CleanupTracker {
  private readonly ids = new Set<number>();

  track(id: number): void {
    this.ids.add(id);
  }

  untrack(id: number): void {
    this.ids.delete(id);
  }

  get trackedIds(): readonly number[] {
    return [...this.ids];
  }

  async create(api: BookingClient, payload: BookingCreateInput): Promise<BookingResponse> {
    const response = await api.create(payload);
    this.track(response.bookingid);
    return response;
  }

  async run(api: BookingClient): Promise<void> {
    for (const id of this.ids) {
      try {
        await api.remove(id);
      } catch (error) {
        // Teardown is best-effort: another actor may already have deleted it,
        // or the host may reject deletes of unknown ids. Log, never fail a test.
        logger.warn('cleanup failed for tracked booking', {
          bookingId: id,
          error: error instanceof Error ? error.message : error,
        });
      }
    }
    this.ids.clear();
  }
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  apiContext: [
    async ({}, use) => {
      const context = await playwrightRequest.newContext({
        baseURL: ENV.baseUrl,
        timeout: ENV.requestTimeoutMs,
        extraHTTPHeaders: { Accept: 'application/json' },
      });
      await use(context);
      await context.dispose();
    },
    { scope: 'worker' },
  ],

  transport: [
    async ({ apiContext }, use) => {
      await use(createTransport(apiContext));
    },
    { scope: 'worker' },
  ],

  authClient: [
    async ({ transport }, use) => {
      await use(new AuthClient(transport, logger));
    },
    { scope: 'worker' },
  ],

  tokenManager: [
    async ({ authClient }, use) => {
      const manager = new TokenManager({
        fetcher: authClient,
        credentials: ENV.credentials,
        ttlMs: ENV.tokenTtlMs,
        logger,
      });
      await use(manager);
    },
    { scope: 'worker' },
  ],

  bookingApi: [
    async ({ transport, tokenManager }, use) => {
      await use(new BookingClient(transport, tokenManager, logger));
    },
    { scope: 'worker' },
  ],

  factory: [
    async ({}, use, workerInfo) => {
      await use(new BookingFactory({ workerIndex: workerInfo.workerIndex }));
    },
    { scope: 'worker' },
  ],

  cleanup: [
    async ({ bookingApi }, use) => {
      const tracker = new Tracker();
      await use(tracker);
      await tracker.run(bookingApi);
    },
    { scope: 'test', auto: true },
  ],
});

test.afterEach(async ({ transport }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) {
    transport.clearHistory();
    return;
  }

  const exchanges = transport.exchanges;
  if (exchanges.length > 0) {
    await testInfo.attach('http-exchanges', {
      body: JSON.stringify(exchanges, null, 2),
      contentType: 'application/json',
    });
  }
  transport.clearHistory();
});

export { expect };
