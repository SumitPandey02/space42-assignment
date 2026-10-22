/**
 * Secret redaction for logs and Allure attachments.
 *
 * Rule of thumb: nothing leaves the process (stdout, report, artifact) without
 * passing through `redact`. Tokens, cookies, passwords and authorization
 * headers are replaced with `[REDACTED]`, deep-cloned so the caller's object is
 * never mutated.
 */

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 8;

const SENSITIVE_FRAGMENTS = [
  'token',
  'password',
  'passwd',
  'secret',
  'authorization',
  'cookie',
  'apikey',
  'session',
  'credential',
] as const;

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[-_.\s]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Redact `key=value`, `key: value`, `"key":"value"` and `Bearer <token>`
 * patterns embedded in free-form strings (error messages, stack traces, raw
 * bodies returned as text/plain).
 */
export function redactSecretsInString(input: string): string {
  return input
    .replaceAll(/(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`)
    .replaceAll(
      /((?:token|password|passwd|secret|authorization|cookie|api[-_]?key)"?\s*[=:]\s*)("?)[^"&;,\s]+/gi,
      `$1$2${REDACTED}`,
    );
}

function redactBinary(value: ArrayBufferView | ArrayBuffer): string {
  const length = value instanceof ArrayBuffer ? value.byteLength : value.byteLength;
  return `[binary ${length} bytes]`;
}

function redactError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: redactSecretsInString(error.message),
    ...(error.stack === undefined ? {} : { stack: redactSecretsInString(error.stack) }),
    ...(error.cause === undefined ? {} : { cause: redact(error.cause) }),
  };
}

/**
 * Deeply redact any value into a JSON-safe clone.
 *
 * Handles cycles, class instances, errors, dates, buffers and non-finite
 * numbers so that a call to `JSON.stringify(redact(x))` can never throw.
 */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return redactSecretsInString(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : value.toString();
  }
  if (typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (depth >= MAX_DEPTH) {
    return '[MaxDepth]';
  }

  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return redactError(value);
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return redactBinary(value);
  }

  const objectValue = value;

  if (seen.has(objectValue)) {
    return '[Circular]';
  }
  seen.add(objectValue);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }

  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, mapValue]) => [
        String(key),
        isSensitiveKey(String(key)) ? REDACTED : redact(mapValue, depth + 1, seen),
      ]),
    );
  }

  if (value instanceof Set) {
    return [...value.values()].map((item) => redact(item, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(objectValue)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redact(nested, depth + 1, seen);
  }

  const tag = Object.prototype.toString.call(objectValue);
  if (tag !== '[object Object]' && Object.keys(result).length === 0) {
    return tag;
  }

  return result;
}

/** Header bag with sensitive values replaced. */
export function redactHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    result[key] = isSensitiveKey(key) ? REDACTED : redactSecretsInString(value);
  }
  return result;
}

/** Strip credentials from query parameters while keeping the shape readable. */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return redactSecretsInString(url.toString());
  } catch {
    return redactSecretsInString(rawUrl);
  }
}

/** Convert arbitrary text into a safe attachment body. */
export function toSafeAttachmentBody(body: string): string {
  return redactSecretsInString(body);
}
