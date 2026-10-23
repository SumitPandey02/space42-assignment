/**
 * Token lifecycle manager.
 *
 * Responsibilities (and nothing else):
 *   1. Cache the token, using an acquisition-time TTL because the API exposes
 *      no expiry. We never invent an `exp` field that the server does not send.
 *   2. Single-flight refresh: concurrent callers in this process share ONE
 *      in-progress acquisition, so parallel setup hooks cannot stampede /auth.
 *   3. Failure hygiene: a rejected refresh clears both the in-flight promise and
 *      the cached token, so the next caller gets a clean attempt instead of a
 *      permanently poisoned promise or a known-stale token.
 *
 * Scope: this lock coordinates callers sharing one manager instance in one
 * runtime (one Playwright worker). It deliberately does not coordinate across
 * processes; each worker authenticates once per TTL window, which is cheap and
 * avoids the need for cross-process locking.
 */

import type { Credentials } from '../../config/environment';
import { ConfigurationError } from '../utils/errors';
import type { Logger } from '../utils/logger';
import type { AuthTokenFetcher } from '../clients/auth.client';

export interface TokenManagerOptions {
  readonly fetcher: AuthTokenFetcher;
  readonly credentials: Credentials;
  /** Refresh threshold, measured from acquisition. */
  readonly ttlMs: number;
  readonly logger: Logger;
}

export interface TokenManagerStats {
  readonly acquisitions: number;
  readonly cacheHits: number;
}

interface CachedToken {
  readonly token: string;
  readonly acquiredAt: number;
}

export class TokenManager {
  private cached: CachedToken | undefined;
  private inFlight: Promise<string> | undefined;
  private acquisitions = 0;
  private cacheHits = 0;

  constructor(private readonly options: TokenManagerOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new ConfigurationError(
        `Token TTL must be a positive number of milliseconds, received ${options.ttlMs}`,
      );
    }
  }

  /** Cached token when fresh, otherwise a (single-flight) refresh. */
  async getToken(): Promise<string> {
    if (this.cached !== undefined && !this.isStale(this.cached)) {
      this.cacheHits += 1;
      return this.cached.token;
    }
    return this.refresh();
  }

  /**
   * Force an acquisition. Concurrent callers await the same promise, so N
   * parallel callers produce exactly one /auth request.
   */
  refresh(): Promise<string> {
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    const inFlight = this.acquire();
    this.inFlight = inFlight;

    return inFlight.finally(() => {
      if (this.inFlight === inFlight) {
        this.inFlight = undefined;
      }
    });
  }

  /** Drop the cached token (e.g. after a 401). Does not cancel an in-flight refresh. */
  invalidate(): void {
    this.cached = undefined;
    this.options.logger.warn('token invalidated');
  }

  get stats(): TokenManagerStats {
    return {
      acquisitions: this.acquisitions,
      cacheHits: this.cacheHits,
    };
  }

  private isStale(cached: CachedToken): boolean {
    return Date.now() - cached.acquiredAt >= this.options.ttlMs;
  }

  private async acquire(): Promise<string> {
    this.acquisitions += 1;
    try {
      const token = await this.options.fetcher.fetchToken(this.options.credentials);
      this.cached = { token, acquiredAt: Date.now() };
      this.options.logger.info('token acquired', {
        totalAcquisitions: this.acquisitions,
        ttlMs: this.options.ttlMs,
      });
      return token;
    } catch (error) {
      // Never leave a stale token behind a failed refresh.
      this.cached = undefined;
      this.options.logger.error('token acquisition failed', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }
}
