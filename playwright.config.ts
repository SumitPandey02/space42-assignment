/**
 * Playwright configuration.
 *
 * The suite runs against the real host. Allure results are written to
 * ./allure-results and rendered separately with the Allure 3 CLI
 * (`npm run allure:generate`). HTTP exchanges are attached on failure by the
 * fixture, which is our API equivalent of a trace.
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
      name: 'core',
      testMatch: /tests\/(booking|auth|resilience|contracts)\/.*\.spec\.ts/,
    },
  ],
});
