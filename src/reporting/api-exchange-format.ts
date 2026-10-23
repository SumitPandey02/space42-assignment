/**
 * Formatting for API request/response diagnostics.
 *
 * Everything in this module is pure: snapshots go in, redacted strings or
 * attachment payloads come out. The exchange logger owns the side effects.
 */

import { redact, redactHeaders, redactSecretsInString, redactUrl } from '../utils/sanitizer';

export type ApiExchangeOutcome = 'success' | 'http-error' | 'network-error';

export interface ApiLoggingOptions {
  readonly enabled: boolean;
  readonly requestBody: boolean;
  readonly responseBody: boolean;
}

export interface ApiRequestSnapshot {
  readonly correlationId: string;
  readonly startedAt: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly operation?: string;
}

export interface ApiResponseSnapshot {
  readonly correlationId: string;
  readonly finishedAt: string;
  readonly status: number;
  readonly statusText?: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
  readonly durationMs: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly outcome: ApiExchangeOutcome;
  readonly error?: string;
}

export interface ApiExchangeAttachment {
  readonly correlationId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly outcome: ApiExchangeOutcome;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body?: unknown;
    readonly operation?: string;
  };
  readonly response: {
    readonly status: number;
    readonly statusText?: string;
    readonly headers: Record<string, string>;
    readonly body?: unknown;
    readonly error?: string;
  };
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return redactSecretsInString(String(value));
  }
}

function redactBody(value: unknown): unknown {
  if (typeof value !== 'string') {
    return redact(value);
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }

  try {
    return redact(JSON.parse(trimmed) as unknown);
  } catch {
    return redactSecretsInString(value);
  }
}

/** Pretty-print a body for console output, safely handling non-JSON text. */
export function formatBodyForLog(body: unknown): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (typeof body !== 'string') {
    return stringify(redact(body));
  }

  const trimmed = body.trim();
  if (trimmed === '') {
    return undefined;
  }

  try {
    return stringify(redact(JSON.parse(trimmed) as unknown));
  } catch {
    return redactSecretsInString(body);
  }
}

function formatHeaders(headers: Record<string, string>): string {
  return stringify(redactHeaders(headers));
}

function statusLine(response: ApiResponseSnapshot): string {
  if (response.outcome === 'network-error') {
    return 'Status: NETWORK ERROR';
  }
  const suffix =
    response.statusText === undefined || response.statusText === '' ? '' : ` ${response.statusText}`;
  return `Status: ${response.status}${suffix}`;
}

function describeRequest(request: ApiRequestSnapshot): string {
  try {
    return `${request.method} ${new URL(request.url).pathname}`;
  } catch {
    return request.operation ?? request.method;
  }
}

export function formatApiRequest(request: ApiRequestSnapshot, options: ApiLoggingOptions): string {
  if (!options.enabled) {
    return '';
  }

  const lines = [
    '========== API REQUEST ==========',
    `[${request.startedAt}] ${request.method} ${redactUrl(request.url)}`,
    `Correlation: ${request.correlationId} | Attempt: ${request.attempt}/${request.maxAttempts}`,
    'Headers:',
    formatHeaders(request.headers),
  ];

  if (options.requestBody) {
    const body = formatBodyForLog(request.body);
    if (body !== undefined) {
      lines.push('Body:', body);
    }
  }

  return lines.join('\n');
}

export function formatApiResponse(response: ApiResponseSnapshot, options: ApiLoggingOptions): string {
  if (!options.enabled) {
    return '';
  }

  const lines = [
    '========== API RESPONSE ==========',
    `[${response.finishedAt}] ${response.correlationId} | Attempt: ${response.attempt}/${response.maxAttempts}`,
    statusLine(response),
    `Duration: ${response.durationMs} ms`,
    `Outcome: ${response.outcome}`,
    'Response headers:',
    formatHeaders(response.headers),
  ];

  if (options.responseBody) {
    const body = formatBodyForLog(response.body);
    if (body !== undefined) {
      lines.push('Response body:', body);
    }
  }

  if (response.error !== undefined) {
    lines.push(`Error: ${redactSecretsInString(response.error)}`);
  }

  return lines.join('\n');
}

export function buildApiExchangeAttachment(
  request: ApiRequestSnapshot,
  response: ApiResponseSnapshot,
  options: ApiLoggingOptions,
): ApiExchangeAttachment {
  const requestBody = options.requestBody ? redactBody(request.body) : undefined;
  const responseBody = options.responseBody ? redactBody(response.body) : undefined;

  return {
    correlationId: request.correlationId,
    attempt: request.attempt,
    maxAttempts: request.maxAttempts,
    startedAt: request.startedAt,
    finishedAt: response.finishedAt,
    durationMs: response.durationMs,
    outcome: response.outcome,
    request: {
      method: request.method,
      url: redactUrl(request.url),
      headers: redactHeaders(request.headers),
      ...(requestBody === undefined ? {} : { body: requestBody }),
      ...(request.operation === undefined ? {} : { operation: request.operation }),
    },
    response: {
      status: response.status,
      headers: redactHeaders(response.headers),
      ...(response.statusText === undefined || response.statusText === ''
        ? {}
        : { statusText: response.statusText }),
      ...(responseBody === undefined ? {} : { body: responseBody }),
      ...(response.error === undefined ? {} : { error: redactSecretsInString(response.error) }),
    },
  };
}

export function formatApiExchangeAttachment(
  request: ApiRequestSnapshot,
  response: ApiResponseSnapshot,
  options: ApiLoggingOptions,
): string {
  return stringify(buildApiExchangeAttachment(request, response, options));
}

export function buildApiExchangeName(request: ApiRequestSnapshot): string {
  const shortId = request.correlationId.slice(0, 8);
  return `API Exchange - ${describeRequest(request)} · ${shortId} · attempt ${request.attempt}/${request.maxAttempts}`;
}
