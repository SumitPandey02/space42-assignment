/**
 * Domain error hierarchy.
 *
 * Every error the framework raises is explicit and typed. Callers can branch on
 * the class instead of parsing status codes or message strings, which is what
 * makes retry and recovery decisions deterministic.
 */

import { redact } from './sanitizer';

export interface AppErrorOptions {
  readonly cause?: unknown;
}

export class AppError extends Error {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Invalid or missing configuration. Always fatal: fail fast, never guess. */
export class ConfigurationError extends AppError {}

/** A calendar/date-range invariant was violated. */
export class DateRangeError extends AppError {}

export interface ApiErrorParams {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  /** Raw body; it is sanitised before being stored. */
  readonly responseBody?: unknown;
  readonly message?: string;
  readonly cause?: unknown;
}

/**
 * An HTTP response that the caller did not consider successful.
 *
 * The response body is sanitised at construction time so that an accidental
 * `console.log(error)` or `JSON.stringify(error)` cannot leak credentials.
 */
export class ApiError extends AppError {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly responseBody: unknown;

  constructor(params: ApiErrorParams) {
    const summary = `${params.method} ${params.url} -> ${params.status}`;
    super(params.message ? `${summary}: ${params.message}` : summary, { cause: params.cause });
    this.method = params.method;
    this.url = params.url;
    this.status = params.status;
    this.responseBody = redact(params.responseBody);
  }
}

/** Transport-level failure: no HTTP response was received. */
export class HttpRequestError extends AppError {
  readonly method: string;
  readonly url: string;

  constructor(params: { method: string; url: string; message: string; cause?: unknown }) {
    super(`${params.method} ${params.url}: ${params.message}`, { cause: params.cause });
    this.method = params.method;
    this.url = params.url;
  }
}

/** 401 (or an auth payload without a token). Refresh may repair this. */
export class AuthenticationError extends AppError {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * 403. Refresh cannot repair an authorization failure, so this is deliberately
 * a different class from AuthenticationError and is never auto-retried.
 */
export class ForbiddenError extends ApiError {}

/** The response body did not satisfy its runtime schema. */
export class SchemaValidationError extends AppError {
  readonly context: string;
  readonly issues: readonly string[];

  constructor(context: string, issues: readonly string[], options?: AppErrorOptions) {
    super(`Response contract violation for "${context}": ${issues.join('; ')}`, options);
    this.context = context;
    this.issues = issues;
  }
}

/** Every retry attempt failed. Carries the attempt count and last error. */
export class RetryExhaustedError extends AppError {
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(params: { attempts: number; lastError: unknown; operation: string }) {
    super(`Retry budget exhausted after ${params.attempts} attempt(s) for ${params.operation}`, {
      cause: params.lastError,
    });
    this.attempts = params.attempts;
    this.lastError = params.lastError;
  }
}

/** The resource disappeared and could not be re-established. */
export class ReconciliationExhaustedError extends AppError {
  readonly resourceId: string | number;
  readonly attempts: number;

  constructor(params: { resourceId: string | number; attempts: number; cause?: unknown }) {
    super(
      `Reconciliation failed for booking ${params.resourceId} after ${params.attempts} attempt(s); ` +
        'the prerequisite resource could not be recreated or was purged again',
      { cause: params.cause },
    );
    this.resourceId = params.resourceId;
    this.attempts = params.attempts;
  }
}

/** Convenience predicates used by retry/recovery policies. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}
