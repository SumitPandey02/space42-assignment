/**
 * HTTP transport.
 *
 * Single responsibility: turn a method + path + payload into a `RawResponse`,
 * applying the retry policy and recording a sanitised exchange history for
 * diagnostics. It deliberately does NOT:
 *   - know about authentication or tokens   -> TokenManager / BookingClient
 *   - decide what a "success" status is      -> callers use `assertStatus`
 *   - parse response bodies into domain types -> Zod contracts
 *
 * Retry safety: GET/PUT/PATCH/DELETE are replay-safe by HTTP semantics. POST is
 * only replayed when the server *responded* with a retryable status; an
 * ambiguous transport failure on POST is never retried, because the write may
 * already have happened.
 */

import type { APIRequestContext } from '@playwright/test';

import {
  ApiError,
  AuthenticationError,
  ForbiddenError,
  HttpRequestError,
  RetryExhaustedError,
} from '../utils/errors';
import type { Logger } from '../utils/logger';
import { retry, type RetryOptions } from '../utils/retry';
import { redact, redactHeaders, redactUrl } from '../utils/sanitizer';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

const REPLAY_SAFE_METHODS: ReadonlySet<HttpMethod> = new Set(['GET', 'PUT', 'PATCH', 'DELETE']);

const MAX_HISTORY_ENTRIES = 50;

export interface HttpRetryPolicy {
  readonly retries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: HttpRetryPolicy = Object.freeze({
  retries: 2,
  baseDelayMs: 300,
  maxDelayMs: 4_000,
  jitterRatio: 0.2,
});

export interface RequestSpec {
  readonly method: HttpMethod;
  /** Absolute URL or a path relative to the configured base URL. */
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly query?: Record<string, string | number | boolean>;
  readonly timeoutMs?: number;
  readonly retry?: Partial<HttpRetryPolicy>;
  readonly operation?: string;
  readonly signal?: AbortSignal;
}

export interface RawResponse {
  readonly method: HttpMethod;
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Record<string, string>;
  readonly text: string;
  /** Parsed JSON, or `undefined` when the body is empty or not JSON. */
  readonly json: unknown;
  readonly durationMs: number;
}

export interface HttpExchange {
  readonly method: HttpMethod;
  readonly url: string;
  readonly requestHeaders: Record<string, string>;
  readonly requestBody: unknown;
  readonly status: number;
  readonly responseHeaders: Record<string, string>;
  readonly responseBody: unknown;
  readonly durationMs: number;
  readonly attempt: number;
  readonly startedAt: string;
  readonly networkError?: string;
}

export interface HttpTransportOptions {
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  readonly defaultRetry?: HttpRetryPolicy;
  readonly logger: Logger;
}

function parseJsonBody(text: string): unknown {
  if (text.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Internal marker so the retry loop can hand the final response back. */
class RetryableStatusError extends Error {
  constructor(readonly response: RawResponse) {
    super(`Retryable status ${response.status} for ${response.method} ${response.url}`);
    this.name = 'RetryableStatusError';
  }
}

function buildQueryString(query: RequestSpec['query']): string {
  if (query === undefined) {
    return '';
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value));
  }
  const serialised = params.toString();
  return serialised === '' ? '' : `?${serialised}`;
}

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly defaultRetry: HttpRetryPolicy;
  private readonly requestTimeoutMs: number;
  private readonly logger: Logger;
  private readonly history: HttpExchange[] = [];

  constructor(
    private readonly request: APIRequestContext,
    options: HttpTransportOptions,
  ) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.defaultRetry = options.defaultRetry ?? DEFAULT_RETRY_POLICY;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.logger = options.logger.child('http');
  }

  get exchanges(): readonly HttpExchange[] {
    return this.history;
  }

  clearHistory(): void {
    this.history.length = 0;
  }

  resolveUrl(path: string, query?: RequestSpec['query']): string {
    const withQuery = `${path}${buildQueryString(query)}`;
    if (/^https?:\/\//i.test(withQuery)) {
      return withQuery;
    }
    return `${this.baseUrl}${withQuery.startsWith('/') ? '' : '/'}${withQuery}`;
  }

  /**
   * Send a request. Non-2xx responses are returned, never thrown: callers decide
   * what is expected (negative tests must be able to assert a 409).
   */
  async send(spec: RequestSpec): Promise<RawResponse> {
    const policy: HttpRetryPolicy = { ...this.defaultRetry, ...spec.retry };
    const url = this.resolveUrl(spec.path, spec.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...spec.headers,
    };

    const retryOptions: RetryOptions = {
      retries: policy.retries,
      baseDelayMs: policy.baseDelayMs,
      maxDelayMs: policy.maxDelayMs,
      jitterRatio: policy.jitterRatio,
      operation: spec.operation ?? `${spec.method} ${url}`,
      isRetryable: (error) => this.isRetryable(error, spec.method),
      onRetry: (context) => {
        this.logger.warn('retrying request', {
          method: spec.method,
          url: redactUrl(url),
          attempt: context.attempt,
          maxAttempts: context.maxAttempts,
          delayMs: context.delayMs,
          error: context.error instanceof Error ? context.error.message : context.error,
        });
      },
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    };

    try {
      return await retry(async (attempt) => {
        const response = await this.execute(spec, url, headers, attempt);
        if (RETRYABLE_STATUS_CODES.has(response.status)) {
          throw new RetryableStatusError(response);
        }
        return response;
      }, retryOptions);
    } catch (error) {
      // The retry budget is gone, but we still have a concrete server response.
      // Returning it lets callers assert on the real final status.
      if (error instanceof RetryableStatusError) {
        return error.response;
      }
      if (error instanceof RetryExhaustedError && error.lastError instanceof RetryableStatusError) {
        return error.lastError.response;
      }
      throw error;
    }
  }

  private isRetryable(error: unknown, method: HttpMethod): boolean {
    if (error instanceof RetryableStatusError) {
      return true;
    }
    if (error instanceof HttpRequestError) {
      return REPLAY_SAFE_METHODS.has(method);
    }
    return false;
  }

  private async execute(
    spec: RequestSpec,
    url: string,
    headers: Record<string, string>,
    attempt: number,
  ): Promise<RawResponse> {
    const startedAt = new Date().toISOString();
    const started = performance.now();

    let response: Awaited<ReturnType<APIRequestContext['fetch']>>;
    try {
      response = await this.request.fetch(url, {
        method: spec.method,
        headers,
        timeout: spec.timeoutMs ?? this.requestTimeoutMs,
        failOnStatusCode: false,
        ...(spec.body === undefined ? {} : { data: spec.body }),
      });
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      const message = error instanceof Error ? error.message : String(error);
      this.record({
        method: spec.method,
        url,
        requestHeaders: headers,
        requestBody: spec.body,
        status: 0,
        responseHeaders: {},
        responseBody: undefined,
        durationMs,
        attempt,
        startedAt,
        networkError: message,
      });
      throw new HttpRequestError({
        method: spec.method,
        url: redactUrl(url),
        message,
        cause: error,
      });
    }

    const durationMs = Math.round(performance.now() - started);
    const text = await response.text();
    const status = response.status();
    const responseHeaders = response.headers();
    const json = parseJsonBody(text);

    const result: RawResponse = {
      method: spec.method,
      url,
      status,
      ok: status >= 200 && status < 300,
      headers: responseHeaders,
      text,
      json,
      durationMs,
    };

    this.record({
      method: spec.method,
      url,
      requestHeaders: headers,
      requestBody: spec.body,
      status,
      responseHeaders,
      responseBody: json ?? text,
      durationMs,
      attempt,
      startedAt,
    });

    this.logger.debug('http exchange', {
      method: spec.method,
      url: redactUrl(url),
      status,
      durationMs,
      attempt,
    });

    return result;
  }

  private record(exchange: HttpExchange): void {
    this.history.push({
      ...exchange,
      url: redactUrl(exchange.url),
      requestHeaders: redactHeaders(exchange.requestHeaders),
      requestBody: redact(exchange.requestBody),
      responseHeaders: redactHeaders(exchange.responseHeaders),
      responseBody: redact(exchange.responseBody),
    });

    if (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history.shift();
    }
  }
}

export interface AssertStatusOptions {
  readonly operation?: string;
  readonly expected: readonly number[];
}

/**
 * Turn an unexpected status into a typed, sanitised error.
 * 401 and 403 get dedicated classes because their recovery differs: 401 is
 * repairable by a token refresh, 403 is not.
 */
export function assertStatus(response: RawResponse, options: AssertStatusOptions): void {
  if (options.expected.includes(response.status)) {
    return;
  }

  const context = {
    method: response.method,
    url: redactUrl(response.url),
    status: response.status,
    responseBody: response.json ?? response.text,
  };

  if (response.status === 401) {
    throw new AuthenticationError(
      `Authentication failed: ${response.method} ${redactUrl(response.url)} -> 401`,
      401,
    );
  }
  if (response.status === 403) {
    throw new ForbiddenError(context);
  }

  if (options.operation === undefined) {
    throw new ApiError(context);
  }
  throw new ApiError({ ...context, message: `${options.operation} failed` });
}
