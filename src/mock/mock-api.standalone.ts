/**
 * Standalone entry point for the mock API.
 *
 * Playwright starts this through `webServer` when API_MODE=mock, and developers
 * can run `npm run mock:server` to poke at it with curl. Configuration is read
 * from the process environment only, so it never accidentally inherits the
 * real-target credentials from a `.env` file.
 */

import { MOCK_DEFAULTS } from '../../config/environments';
import { createLogger } from '../utils/logger';
import { createMockApi } from './mock-api';

const logger = createLogger('mock-api');

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const port = intFromEnv('MOCK_PORT', MOCK_DEFAULTS.port);
const host = process.env['MOCK_HOST'] ?? '127.0.0.1';

const api = createMockApi({
  adminKey: process.env['MOCK_ADMIN_KEY'] ?? MOCK_DEFAULTS.adminKey,
  adminUsername: process.env['MOCK_USERNAME'] ?? MOCK_DEFAULTS.adminUsername,
  adminPassword: process.env['MOCK_PASSWORD'] ?? MOCK_DEFAULTS.adminPassword,
  viewerUsername: process.env['MOCK_VIEWER_USERNAME'] ?? MOCK_DEFAULTS.viewerUsername,
  viewerPassword: process.env['MOCK_VIEWER_PASSWORD'] ?? MOCK_DEFAULTS.viewerPassword,
  tokenTtlMs: intFromEnv('MOCK_TOKEN_TTL_MS', MOCK_DEFAULTS.tokenTtlMs),
  logger,
});

const boundPort = await api.listen(port, host);
logger.info('mock API listening', { url: `http://${host}:${boundPort}`, adminKeyProtected: true });

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down mock API', { signal });
  void api.close().then(
    () => process.exit(0),
    (error: unknown) => {
      logger.error('mock API shutdown failed', { error: error instanceof Error ? error.message : error });
      process.exit(1);
    },
  );
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
