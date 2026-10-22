import { test, expect } from '@playwright/test';

import {
  REDACTED,
  isSensitiveKey,
  redact,
  redactHeaders,
  redactSecretsInString,
  redactUrl,
} from '../../src/utils/sanitizer';

test.describe('sanitizer', () => {
  test('recognises sensitive key variants', () => {
    for (const key of ['token', 'apiKey', 'api_key', 'Authorization', 'Cookie', 'password', 'userSecret']) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of ['username', 'firstname', 'status', 'bookingid']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  test('redacts secrets deeply without mutating the input', () => {
    const input = {
      username: 'admin',
      password: 'password123',
      nested: { authorization: 'Bearer abc.def', token: 'abc123' },
      list: [{ cookie: 'token=abc123' }],
    };

    const output = redact(input);

    expect(output).toEqual({
      username: 'admin',
      password: REDACTED,
      nested: { authorization: REDACTED, token: REDACTED },
      list: [{ cookie: REDACTED }],
    });
    expect(input.password).toBe('password123');
    expect(input.nested.token).toBe('abc123');
  });

  test('redacts secrets embedded in free-form strings', () => {
    const text = 'POST /auth failed: {"password":"password123","token":"deadbeef"}';
    const redacted = redactSecretsInString(text);
    expect(redacted).not.toContain('password123');
    expect(redacted).not.toContain('deadbeef');
  });

  test('handles cycles and non-finite numbers', () => {
    const cyclic: Record<string, unknown> = { name: 'cycle' };
    cyclic['self'] = cyclic;
    cyclic['value'] = Number.POSITIVE_INFINITY;

    expect(() => JSON.stringify(redact(cyclic))).not.toThrow();
    expect(redact(cyclic)).toMatchObject({ name: 'cycle', value: 'Infinity' });
  });

  test('redacts header names case-insensitively', () => {
    expect(
      redactHeaders({ Cookie: 'token=abc', Authorization: 'Bearer xyz', Accept: 'application/json' }),
    ).toEqual({ Cookie: REDACTED, Authorization: REDACTED, Accept: 'application/json' });
  });

  test('redacts query-string secrets from URLs', () => {
    expect(redactUrl('https://example.test/booking?token=abc&firstname=Shaun')).toBe(
      'https://example.test/booking?token=[REDACTED]&firstname=Shaun',
    );
  });

  test('serialises errors without leaking tokens', () => {
    const error = new Error('request failed with token=supersecret');
    expect(redact(error)).toMatchObject({ name: 'Error' });
    expect(JSON.stringify(redact(error))).not.toContain('supersecret');
  });
});
