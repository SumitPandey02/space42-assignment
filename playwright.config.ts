/**
 * Playwright configuration.
 *
 * Projects are behaviour-oriented rather than folder-oriented:
 *   - `unit`               pure functions, no network (can run offline)
 *   - `enterprise`         deterministic mock-only contracts (401/403/409/412)
 *   - `core`               lifecycle/idempotency/concurrency, runs on mock or real
 *   - `sandbox-behaviour`  observations that are only meaningful on the real
 *                          public sandbox (auto-skipped elsewhere)
 *
 * Allure results are written to ./allure-results and rendered separately with
 * the Allure 3 CLI (`npm run allure:generate`). HTTP exchanges are attached on
 * failure by the fixture, which is our API equivalent of a trace.
 */

import { defineConfig } from '@playwright/test';

import { ENV } from './config/environment';

const RETRIES = ENV.isCi ? 1 : 0;

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  globalSetup: './src/reporting/global-setup.ts',
  fullyParallel: true,
  forbidOnly: ENV.isCi,
  retries: RETRIES,
  workers: ENV.workers,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    [ENV.isCi ? 'github' : 'list'],
    [
      'allure-playwright',
      {
        resultsDir: process.env['ALLURE_RESULTS_DIR'] ?? 'allure-results',
        detail: true,
        suiteTitle: true,
      },
    ],
  ],
  use: {
    baseURL: ENV.baseUrl,
    extraHTTPHeaders: { Accept: 'application/json' },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'unit',
      testMatch: /tests\/unit\/.*\.spec\.ts/,
    },
    {
      name: 'enterprise',
      testMatch: /tests\/enterprise\/.*\.spec\.ts/,
    },
    {
      name: 'core',
      testMatch: /tests\/(booking|auth|resilience|contract)\/.*\.spec\.ts/,
      grepInvert: /@sandbox-behaviour/,
    },
    {
      name: 'sandbox-behaviour',
      testMatch: /tests\/sandbox-behaviour\/.*\.spec\.ts/,
      grep: /@sandbox-behaviour/,
    },
  ],
  ...(ENV.mode === 'mock'
    ? {
        webServer: {
          command: 'npm run mock:server',
          url: `${ENV.baseUrl}/ping`,
          timeout: 30_000,
          reuseExistingServer: !ENV.isCi,
          env: {
            MOCK_PORT: String(ENV.mockPort),
            MOCK_ADMIN_KEY: ENV.mockAdminKey,
            LOG_LEVEL: ENV.logLevel,
          },
          stdout: 'ignore' as const,
          stderr: 'pipe' as const,
        },
      }
    : {}),
});
