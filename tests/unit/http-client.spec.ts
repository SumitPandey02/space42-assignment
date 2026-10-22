import { test, expect } from '@playwright/test';
import type { APIRequestContext, APIResponse } from '@playwright/test';

import { HttpTransport, assertStatus } from '../../src/clients/http-client';
import { ApiError, AuthenticationError, ForbiddenError, HttpRequestError } from '../../src/utils/errors';
import type { Logger } from '../../src/utils/logger';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

function fakeResponse(status: number, body: unknown): APIResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status: () => status,
    headers: () => ({ 'content-type': 'application/json' }),
    text: async () => text,
    body: async () => Buffer.from(text),
    json: async () => JSON.parse(text) as unknown,
    ok: () => status >= 200 && status < 300,
    statusText: () => '',
    url: () => 'http://mock.local',
    dispose: async () => undefined,
  } as unknown as APIResponse;
}

interface ScriptedCall {
  status: number;
  body?: unknown;
  throws?: Error;
}

function scriptedContext(calls: ScriptedCall[]): { context: APIRequestContext; count: () => number } {
  let index = 0;
  const context = {
    fetch: async () => {
      const call = calls[index];
      index += 1;
      if (call === undefined) throw new Error('unexpected extra request');
      if (call.throws !== undefined) throw call.throws;
      return fakeResponse(call.status, call.body ?? {});
    },
  } as unknown as APIRequestContext;
  return { context, count: () => index };
}

function makeTransport(context: APIRequestContext): HttpTransport {
  return new HttpTransport(context, {
    baseUrl: 'http://mock.local',
    requestTimeoutMs: 1_000,
    logger,
  });
}

const fastRetry = { baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } as const;

test.describe('HttpTransport', () => {
  test('retries a retryable status and returns the eventual success', async () => {
    const script = scriptedContext([{ status: 503 }, { status: 200, body: { ok: true } }]);
    const transport = makeTransport(script.context);

    const response = await transport.send({
      method: 'GET',
      path: '/booking/1',
      retry: { ...fastRetry, retries: 2 },
    });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ ok: true });
    expect(script.count()).toBe(2);
  });

  test('returns the final retryable response when the retry budget is exhausted', async () => {
    const script = scriptedContext([{ status: 500 }, { status: 500 }, { status: 500 }]);
    const transport = makeTransport(script.context);

    const response = await transport.send({
      method: 'GET',
      path: '/ping',
      retry: { ...fastRetry, retries: 2 },
    });

    expect(response.status).toBe(500);
    expect(script.count()).toBe(3);
  });

  test('never retries an ambiguous POST network failure', async () => {
    const script = scriptedContext([{ status: 0, throws: new Error('socket hang up') }]);
    const transport = makeTransport(script.context);

    await expect(
      transport.send({
        method: 'POST',
        path: '/booking',
        body: { firstname: 'x' },
        retry: { ...fastRetry, retries: 5 },
      }),
    ).rejects.toBeInstanceOf(HttpRequestError);

    expect(script.count()).toBe(1);
    expect(transport.exchanges).toHaveLength(1);
    expect(transport.exchanges[0]?.networkError).toContain('socket hang up');
  });

  test('retries a GET network failure because GET is replay-safe', async () => {
    const script = scriptedContext([
      { status: 0, throws: new Error('ECONNRESET') },
      { status: 200, body: { bookingid: 1 } },
    ]);
    const transport = makeTransport(script.context);

    const response = await transport.send({
      method: 'GET',
      path: '/booking/1',
      retry: { ...fastRetry, retries: 1 },
    });

    expect(response.status).toBe(200);
    expect(script.count()).toBe(2);
  });

  test('records a sanitised exchange history', async () => {
    const script = scriptedContext([{ status: 200, body: { token: 'secret-token' } }]);
    const transport = makeTransport(script.context);

    await transport.send({
      method: 'GET',
      path: '/booking',
      headers: { Cookie: 'token=secret-token' },
    });

    const exchange = transport.exchanges[0];
    expect(exchange?.requestHeaders['Cookie']).toBe('[REDACTED]');
    expect(exchange?.responseBody).toEqual({ token: '[REDACTED]' });
  });

  test('builds query strings and absolute URLs', () => {
    const script = scriptedContext([]);
    const transport = makeTransport(script.context);

    expect(transport.resolveUrl('/booking', { firstname: 'Shaun', depositpaid: true })).toBe(
      'http://mock.local/booking?firstname=Shaun&depositpaid=true',
    );
    expect(transport.resolveUrl('http://other.local/ping')).toBe('http://other.local/ping');
  });
});

test.describe('assertStatus', () => {
  const response = {
    method: 'POST' as const,
    url: 'http://mock.local/booking',
    status: 409,
    ok: false,
    headers: {},
    text: '{"reason":"conflict"}',
    json: { reason: 'conflict' },
    durationMs: 1,
  };

  test('accepts any expected status', () => {
    expect(() => assertStatus({ ...response, status: 201 }, { expected: [200, 201] })).not.toThrow();
  });

  test('maps 401 to AuthenticationError', () => {
    expect(() => assertStatus({ ...response, status: 401 }, { expected: [200] })).toThrow(
      AuthenticationError,
    );
  });

  test('maps 403 to ForbiddenError without treating it as auth failure', () => {
    expect(() => assertStatus({ ...response, status: 403 }, { expected: [200] })).toThrow(ForbiddenError);
  });

  test('maps other failures to ApiError with a sanitised body', () => {
    const error = (() => {
      try {
        assertStatus({ ...response, json: { token: 'secret' } }, { expected: [200], operation: 'create' });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).responseBody).toEqual({ token: '[REDACTED]' });
    expect((error as ApiError).message).toContain('create failed');
  });
});
