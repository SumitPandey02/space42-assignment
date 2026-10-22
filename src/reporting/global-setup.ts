/**
 * Writes run metadata for Allure before any test starts.
 *
 * Allure reads `environment.properties` and `executor.json` from the results
 * directory. Keeping the values secret-free means the report can be shared.
 */

import { mkdir, writeFile } from 'node:fs/promises';

import { ENV, describeTarget } from '../../config/environment';

const RESULTS_DIR = process.env['ALLURE_RESULTS_DIR'] ?? 'allure-results';

export default async function globalSetup(): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true });

  const environment = [
    `Target=${describeTarget()}`,
    `Mode=${ENV.mode}`,
    `Environment=${ENV.env}`,
    `BaseUrl=${ENV.baseUrl}`,
    `Workers=${ENV.workers}`,
    `RequestTimeoutMs=${ENV.requestTimeoutMs}`,
    `TokenTtlMs=${ENV.tokenTtlMs}`,
    `RunId=${ENV.runId}`,
    `Node=${process.version}`,
    `CI=${String(ENV.isCi)}`,
  ];
  await writeFile(`${RESULTS_DIR}/environment.properties`, environment.join('\n'), 'utf8');

  if (ENV.isCi) {
    const serverUrl = process.env['GITHUB_SERVER_URL'] ?? 'https://github.com';
    const repository = process.env['GITHUB_REPOSITORY'] ?? '';
    const runId = process.env['GITHUB_RUN_ID'] ?? '';
    await writeFile(
      `${RESULTS_DIR}/executor.json`,
      JSON.stringify(
        {
          name: 'GitHub Actions',
          type: 'github',
          buildName: process.env['GITHUB_RUN_NUMBER'] ?? runId,
          buildOrder: Number(process.env['GITHUB_RUN_ATTEMPT'] ?? '1'),
          buildUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
        },
        null,
        2,
      ),
      'utf8',
    );
  }
}
