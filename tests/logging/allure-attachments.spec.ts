import { expect, test } from '@playwright/test';
import { attachment } from 'allure-js-commons';

test.describe('Allure API exchange attachments @logging', () => {
  test('produces a JSON attachment through the Allure integration', async (_: unknown, testInfo) => {
    const payload = JSON.stringify(
      {
        correlationId: 'abc123def456',
        request: { method: 'GET', url: 'https://restful-booker.herokuapp.com/ping' },
        response: { status: 200 },
      },
      null,
      2,
    );

    await attachment('API Exchange - GET /ping · abc123de · attempt 1/1', payload, {
      contentType: 'application/json',
    });

    const names = testInfo.attachments.map((item) => item.name);
    expect(names.some((name) => name.startsWith('API Exchange -'))).toBe(true);
  });
});
