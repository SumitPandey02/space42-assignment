/**
 * Generic, bounded exponential backoff with optional jitter.
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
  /** Injectable for deterministic tests. */
  readonly random?: () => number;
  /** Injectable for deterministic tests. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly operation?: string;
}

export interface BackoffParams {
  readonly attempt: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  readonly random: () => number;
}

/**
 * delay = min(maxDelay, base * 2^(attempt-1)), then jittered by +/-ratio.
 * Attempt 1 is the first *retry*, so it uses the base delay.
 */
export function computeBackoffDelay(params: BackoffParams): number {
  const exponential = params.baseDelayMs * 2 ** (params.attempt - 1);
  const capped = Math.min(params.maxDelayMs, exponential);

  if (params.jitterRatio <= 0) {
    return Math.max(0, Math.round(capped));
  }

  const jitterSpan = capped * params.jitterRatio;
  const jittered = capped - jitterSpan + params.random() * jitterSpan * 2;
  return Math.max(0, Math.round(Math.min(params.maxDelayMs, jittered)));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Sleep aborted'));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Execute `operation`, retrying only when `isRetryable` allows it.
 * Aborts immediately when the signal fires.
 */
export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.retries) + 1);
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;
  const isRetryable = options.isRetryable ?? (() => true);
  const wait = options.sleep ?? sleep;
  const operationName = options.operation ?? 'operation';

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.signal?.throwIfAborted();

    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts || !isRetryable(error)) {
        throw error;
      }

      const delayMs = computeBackoffDelay({
        attempt,
        baseDelayMs,
        maxDelayMs,
        jitterRatio,
        random,
      });

      options.onRetry?.({ attempt, maxAttempts, delayMs, error });
      await wait(delayMs, options.signal);
    }
  }

  throw new RetryExhaustedError({ attempts: maxAttempts, lastError, operation: operationName });
}
