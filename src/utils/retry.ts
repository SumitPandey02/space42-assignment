/**
 * Bounded exponential backoff with optional jitter.
 *
 * This module is deliberately HTTP-agnostic: it knows how to wait and how many
 * times, not what is retryable. The HTTP retry policy lives in the HTTP client,
 * because only that layer knows whether a request is safe to replay.
 */

import { RetryExhaustedError } from './errors';

export interface RetryContext {
  /** 1-based index of the attempt that just failed. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly error: unknown;
}

export interface RetryOptions {
  /** Number of *additional* attempts after the first one. */
  readonly retries: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** 0 disables jitter. 0.2 means +/-20%. */
  readonly jitterRatio?: number;
  readonly isRetryable?: (error: unknown) => boolean;
  readonly onRetry?: (context: RetryContext) => void;
  readonly operation?: string;
}

function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterRatio: number,
): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(maxDelayMs, exponential);

  if (jitterRatio <= 0) {
    return Math.max(0, Math.round(capped));
  }

  const jitterSpan = capped * jitterRatio;
  const jittered = capped - jitterSpan + Math.random() * jitterSpan * 2;
  return Math.max(0, Math.round(Math.min(maxDelayMs, jittered)));
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `operation`, retrying only when `isRetryable` allows it.
 */
export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.retries) + 1);
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const isRetryable = options.isRetryable ?? (() => true);
  const operationName = options.operation ?? 'operation';

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts || !isRetryable(error)) {
        throw error;
      }

      const delayMs = computeBackoffDelay(attempt, baseDelayMs, maxDelayMs, jitterRatio);
      options.onRetry?.({ attempt, maxAttempts, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new RetryExhaustedError({ attempts: maxAttempts, lastError, operation: operationName });
}
