import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import { HttpTransport } from '../../src/clients/http-client';
import { ApiExchangeLogger } from '../../src/reporting/api-exchange-logger';
import { createLogger } from '../../src/utils/logger';

function createTransportFixture(options: {
  fetch: (url: string, init?: unknown) => Promise<unknown>;
  apiLogging?: { enabled: boolean; requestBody: boolean; responseBody: boolean };
  console?: (block: string) => void;
  allure?: (name: string, content: string) => Promise<void>;
}) {
  const apiLogging = options.apiLogging ?? { enabled: true, requestBody: true, responseBody: true };
  const logs: string[] = [];
  const attachments: Array<{ name: string; content: string }> = [];
  const logger = createLogger('test');
  const exchangeLogger = new ApiExchangeLogger(apiLogging, logger, {
    console: options.console ?? ((block) => logs.push(block)),
    allure:
      options.allure ??
      (async (name, content) => {
        attachments.push({ name, content });
      }),
  });

  const request = {
    fetch: options.fetch,
  } as unknown as APIRequestContext;

  const transport = new HttpTransport(request, {
    baseUrl: 'https://restful-booker.herokuapp.com',
    requestTimeoutMs: 15000,
    logger,
    exchangeLogger,
  });

  return { transport, logs, attachments };
}

test.describe('HttpTransport API logging @logging', () => {
  test('logs request and response and creates a correlated Allure attachment', async () => {
    const { transport, logs, attachments } = createTransportFixture({
      fetch: async () => ({
        status: () => 200,
        statusText: () => 'OK',
        headers: () => ({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ bookingid: 123 }),
      }),
    });

    const response = await transport.send({
      method: 'POST',
      path: '/booking',
      body: { firstname: 'Test' },
      operation: 'POST /booking',
    });

    expect(response.status).toBe(200);
    expect(logs.some((entry) => entry.includes('API REQUEST'))).toBe(true);
    expect(logs.some((entry) => entry.includes('API RESPONSE'))).toBe(true);
    expect(logs.some((entry) => entry.includes('API REQUEST'))).toBe(true);
    expect(attachments.length).toBe(1);
    expect(attachments[0]?.name).toContain('API Exchange - POST /booking');
    expect(attachments[0]?.content).toContain('"bookingid": 123');
  });

  test('attaches exchange on HTTP error responses', async () => {
    const { transport, attachments } = createTransportFixture({
      fetch: async () => ({
        status: () => 404,
        statusText: () => 'Not Found',
        headers: () => ({ 'content-type': 'text/plain' }),
        text: async () => 'Not Found',
      }),
    });

    const response = await transport.send({ method: 'GET', path: '/booking/999999' });
    expect(response.status).toBe(404);
    expect(attachments.length).toBe(1);
    expect(attachments[0]?.content).toContain('"status": 404');
  });

  test('attaches exchange and throws on network errors without masking the failure', async () => {
    const { transport, attachments, logs } = createTransportFixture({
      fetch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    await expect(transport.send({ method: 'GET', path: '/ping' })).rejects.toThrow(/\/ping/i);
    expect(attachments.length).toBeGreaterThanOrEqual(1);
    expect(attachments.some((item) => item.content.includes('network-error'))).toBe(true);
    expect(logs.some((entry) => entry.includes('NETWORK ERROR'))).toBe(true);
  });

  test('logs each retry attempt with correlated pairs', async () => {
    let calls = 0;
    const { transport, logs, attachments } = createTransportFixture({
      fetch: async () => {
        calls += 1;
        if (calls < 2) {
          return {
            status: () => 503,
            statusText: () => 'Service Unavailable',
            headers: () => ({ 'content-type': 'text/plain' }),
            text: async () => 'Service Unavailable',
          };
        }
        return {
          status: () => 200,
          statusText: () => 'OK',
          headers: () => ({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ ok: true }),
        };
      },
    });

    const response = await transport.send({ method: 'GET', path: '/ping' });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(logs.filter((entry) => entry.includes('API REQUEST')).length).toBe(2);
    expect(logs.filter((entry) => entry.includes('API RESPONSE')).length).toBe(2);
    expect(attachments.length).toBe(2);
    expect(attachments[0]?.content).toContain('"attempt": 1');
    expect(attachments[1]?.content).toContain('"attempt": 2');
  });

  test('does not log when API logging is disabled', async () => {
    const { transport, logs, attachments } = createTransportFixture({
      fetch: async () => ({
        status: () => 200,
        statusText: () => 'OK',
        headers: () => ({}),
        text: async () => JSON.stringify({ ok: true }),
      }),
      apiLogging: { enabled: false, requestBody: true, responseBody: true },
    });

    await transport.send({ method: 'GET', path: '/ping' });
    expect(logs.length).toBe(0);
    expect(attachments.length).toBe(0);
  });

  test('logging failures do not mask API results', async () => {
    const { transport, attachments } = createTransportFixture({
      fetch: async () => ({
        status: () => 200,
        statusText: () => 'OK',
        headers: () => ({}),
        text: async () => JSON.stringify({ ok: true }),
      }),
      console: () => {
        throw new Error('console broken');
      },
      allure: async () => {
        throw new Error('allure broken');
      },
    });

    const response = await transport.send({ method: 'GET', path: '/ping' });
    expect(response.status).toBe(200);
    expect(attachments.length).toBe(0);
  });

  test('correlates concurrent requests', async () => {
    const { transport, attachments } = createTransportFixture({
      fetch: async (url) => ({
        status: () => 200,
        statusText: () => 'OK',
        headers: () => ({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ url }),
      }),
    });

    await Promise.all([
      transport.send({ method: 'GET', path: '/ping' }),
      transport.send({ method: 'GET', path: '/booking/1' }),
    ]);

    expect(attachments.length).toBe(2);
    const correlationIds = new Set(
      attachments.map((item) => {
        const parsed = JSON.parse(item.content) as { correlationId: string };
        return parsed.correlationId;
      }),
    );
    expect(correlationIds.size).toBe(2);
  });
});
