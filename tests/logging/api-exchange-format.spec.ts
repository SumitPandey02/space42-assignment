import { expect, test } from '@playwright/test';

import {
  buildApiExchangeAttachment,
  buildApiExchangeName,
  formatApiRequest,
  formatApiResponse,
  type ApiLoggingOptions,
  type ApiRequestSnapshot,
  type ApiResponseSnapshot,
} from '../../src/reporting/api-exchange-format';

const options: ApiLoggingOptions = {
  enabled: true,
  requestBody: true,
  responseBody: true,
};

test.describe('API exchange formatting @logging', () => {
  test('formats request and response with correlation and attempt info', async () => {
    const request: ApiRequestSnapshot = {
      correlationId: 'abc123def456',
      startedAt: '2026-10-23T10:00:00.000Z',
      method: 'POST',
      url: 'https://restful-booker.herokuapp.com/booking',
      headers: { Accept: 'application/json', Cookie: 'token=secret-token' },
      body: { firstname: 'TestUser', totalprice: 150 },
      attempt: 1,
      maxAttempts: 3,
      operation: 'POST /booking',
    };

    const response: ApiResponseSnapshot = {
      correlationId: 'abc123def456',
      finishedAt: '2026-10-23T10:00:00.125Z',
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' },
      body: { bookingid: 123, booking: { firstname: 'TestUser', totalprice: 150 } },
      durationMs: 125,
      attempt: 1,
      maxAttempts: 3,
      outcome: 'success',
    };

    const requestBlock = formatApiRequest(request, options);
    const responseBlock = formatApiResponse(response, options);

    expect(requestBlock).toContain('API REQUEST');
    expect(requestBlock).toContain('Correlation: abc123def456');
    expect(requestBlock).toContain('Attempt: 1/3');
    expect(requestBlock).not.toContain('secret-token');
    expect(requestBlock).toContain('"firstname": "TestUser"');

    expect(responseBlock).toContain('API RESPONSE');
    expect(responseBlock).toContain('Status: 200 OK');
    expect(responseBlock).toContain('Duration: 125 ms');
    expect(responseBlock).toContain('"bookingid": 123');
  });

  test('omits bodies when body logging is disabled', async () => {
    const request: ApiRequestSnapshot = {
      correlationId: 'abc123def456',
      startedAt: '2026-10-23T10:00:00.000Z',
      method: 'POST',
      url: 'https://restful-booker.herokuapp.com/booking',
      headers: { 'Content-Type': 'application/json' },
      body: { firstname: 'TestUser' },
      attempt: 1,
      maxAttempts: 1,
    };

    const response: ApiResponseSnapshot = {
      correlationId: 'abc123def456',
      finishedAt: '2026-10-23T10:00:00.125Z',
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { bookingid: 123 },
      durationMs: 125,
      attempt: 1,
      maxAttempts: 1,
      outcome: 'success',
    };

    const bodyDisabled: ApiLoggingOptions = { enabled: true, requestBody: false, responseBody: false };
    expect(formatApiRequest(request, bodyDisabled)).not.toContain('Body:');
    expect(formatApiResponse(response, bodyDisabled)).not.toContain('Response body:');
  });

  test('redacts nested JSON bodies, arrays, headers, and sensitive query params', async () => {
    const request: ApiRequestSnapshot = {
      correlationId: 'abc123def456',
      startedAt: '2026-10-23T10:00:00.000Z',
      method: 'POST',
      url: 'https://user:pass@restful-booker.herokuapp.com/auth?token=abc&apikey=xyz',
      headers: { Authorization: 'Bearer secret', 'X-Api-Key': 'abc123' },
      body: {
        credentials: { username: 'admin', password: 'password123' },
        items: [{ token: 'nested-token' }],
      },
      attempt: 1,
      maxAttempts: 1,
    };

    const response: ApiResponseSnapshot = {
      correlationId: 'abc123def456',
      finishedAt: '2026-10-23T10:00:00.125Z',
      status: 200,
      headers: { 'Set-Cookie': 'token=secret' },
      body: { token: 'jwt-token', data: [{ secret: 'value' }] },
      durationMs: 125,
      attempt: 1,
      maxAttempts: 1,
      outcome: 'success',
    };

    const attachment = buildApiExchangeAttachment(request, response, options);
    const serialized = JSON.stringify(attachment);

    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('password123');
    expect(serialized).not.toContain('nested-token');
    expect(serialized).not.toContain('jwt-token');
    expect(serialized).not.toContain('value');
    expect(serialized).not.toContain('user:pass');
    expect(serialized).not.toContain('token=abc');
    expect(serialized).not.toContain('apikey=xyz');

    expect(attachment.request.headers.Authorization).toBe('[REDACTED]');
    expect(attachment.response.headers['Set-Cookie']).toBe('[REDACTED]');
    expect(buildApiExchangeName(request)).toContain('API Exchange - POST /auth');
  });

  test('handles non-JSON bodies and network errors safely', async () => {
    const request: ApiRequestSnapshot = {
      correlationId: 'abc123def456',
      startedAt: '2026-10-23T10:00:00.000Z',
      method: 'GET',
      url: 'https://restful-booker.herokuapp.com/ping',
      headers: {},
      attempt: 1,
      maxAttempts: 1,
    };

    const response: ApiResponseSnapshot = {
      correlationId: 'abc123def456',
      finishedAt: '2026-10-23T10:00:00.125Z',
      status: 0,
      headers: {},
      body: 'timeout',
      durationMs: 125,
      attempt: 1,
      maxAttempts: 1,
      outcome: 'network-error',
      error: 'connect ECONNREFUSED',
    };

    const block = formatApiResponse(response, options);
    expect(block).toContain('NETWORK ERROR');
    expect(block).toContain('connect ECONNREFUSED');

    const attachment = buildApiExchangeAttachment(request, response, options);
    expect(attachment.outcome).toBe('network-error');
    expect(JSON.stringify(attachment)).toContain('connect ECONNREFUSED');
  });
});
