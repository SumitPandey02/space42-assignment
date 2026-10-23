import { expect, test } from '@playwright/test';

import { resolveEnvironment } from '../../config/environment';

test.describe('API logging configuration @logging', () => {
  test('uses safe defaults when flags are not provided', async () => {
    const env = resolveEnvironment({});
    expect(env.apiLogging.enabled).toBe(true);
    expect(env.apiLogging.requestBody).toBe(true);
    expect(env.apiLogging.responseBody).toBe(true);
  });

  test('parses boolean strings case-insensitively', async () => {
    const env = resolveEnvironment({
      API_LOGGING_ENABLED: 'false',
      API_LOG_REQUEST_BODY: '0',
      API_LOG_RESPONSE_BODY: 'TRUE',
    });

    expect(env.apiLogging.enabled).toBe(false);
    expect(env.apiLogging.requestBody).toBe(false);
    expect(env.apiLogging.responseBody).toBe(true);
  });

  test('rejects invalid boolean values', async () => {
    expect(() => resolveEnvironment({ API_LOGGING_ENABLED: 'maybe' })).toThrow(/API_LOGGING_ENABLED/i);
  });
});
