/**
 * Runtime configuration resolver.
 *
 * Precedence (highest first):
 *   1. process environment (CI workflow inputs, repository/environment vars, secrets)
 *   2. local `.env` file (loaded here, never committed)
 *   3. the named profile in `config/environments.ts`
 *   4. built-in defaults
 *
 * `dotenv` never overrides variables that already exist in the environment, so
 * CI values always win over a developer's `.env`.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import {
  ENVIRONMENTS,
  MAX_MOCK_WORKERS,
  MOCK_DEFAULTS,
  PUBLIC_SANDBOX_CREDENTIALS,
  type ApiEnv,
  type ApiMode,
  type EnvironmentProfile,
} from './environments';
import { ConfigurationError } from '../src/utils/errors';
import type { LogLevel } from '../src/utils/logger';
import { RUN_ID } from '../src/utils/run-id';

loadDotenv({ quiet: true });

const DEFAULT_WORKERS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_TTL_MS = 600_000;

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalInt = (min: number, max: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).optional());

/** CI secrets render as an empty string when unset; treat that as absent. */
const optionalText = (schema: z.ZodString) => z.preprocess(emptyToUndefined, schema.optional());

const rawEnvironmentSchema = z.object({
  API_MODE: z.enum(['real', 'mock']).default('mock'),
  API_ENV: z.enum(['sandbox', 'uat', 'prod']).default('sandbox'),
  BASE_URL: optionalText(z.string().trim().min(1)),
  API_USERNAME: optionalText(z.string().trim().min(1)),
  API_PASSWORD: optionalText(z.string().min(1)),
  WORKERS: optionalInt(1, 64),
  REQUEST_TIMEOUT_MS: optionalInt(1_000, 120_000),
  TOKEN_TTL_MS: optionalInt(1_000, 86_400_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
  RUN_BEHAVIOUR_TESTS: z.enum(['true', 'false']).optional(),
  MOCK_PORT: optionalInt(1024, 65_535),
  MOCK_ADMIN_KEY: optionalText(z.string().min(1)),
  CI: z.string().optional(),
});

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

export interface AppEnvironment {
  readonly mode: ApiMode;
  readonly env: ApiEnv;
  readonly profile: EnvironmentProfile;
  /** Always resolved: the named profile, BASE_URL, or the loopback mock URL. */
  readonly baseUrl: string;
  readonly mockPort: number;
  readonly mockAdminKey: string;
  readonly credentials: Credentials;
  /** Effective worker count after the profile cap is applied. */
  readonly workers: number;
  readonly requestedWorkers: number;
  readonly requestTimeoutMs: number;
  readonly tokenTtlMs: number;
  readonly logLevel: LogLevel;
  readonly isCi: boolean;
  readonly isMock: boolean;
  readonly runId: string;
  /** True when `@sandbox-behaviour` specs are allowed to execute. */
  readonly runBehaviourTests: boolean;
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function assertHttpUrl(value: string, context: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${context} must be an absolute URL, received "${value}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigurationError(`${context} must use http(s), received "${parsed.protocol}"`);
  }
  return parsed.toString().replace(/\/$/, '');
}

/**
 * Pure resolver — no module side effects. Exposed for unit tests; the app uses
 * the `ENV` singleton below.
 */
export function resolveEnvironment(source: NodeJS.ProcessEnv = process.env): AppEnvironment {
  const parsed = rawEnvironmentSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigurationError(`Invalid environment configuration -> ${formatIssues(parsed.error.issues)}`);
  }

  const raw = parsed.data;
  const mode: ApiMode = raw.API_MODE;
  const env: ApiEnv = raw.API_ENV;
  const profile = ENVIRONMENTS[env];

  const override = raw.BASE_URL !== undefined && raw.BASE_URL !== '' ? raw.BASE_URL : undefined;

  const mockPort = raw.MOCK_PORT ?? MOCK_DEFAULTS.port;
  const mockAdminKey = raw.MOCK_ADMIN_KEY ?? MOCK_DEFAULTS.adminKey;

  let baseUrl: string;
  if (mode === 'mock') {
    baseUrl = `http://127.0.0.1:${mockPort}`;
  } else {
    const candidate = override ?? (profile.baseUrl !== '' ? profile.baseUrl : undefined);
    if (candidate === undefined) {
      throw new ConfigurationError(
        `API_MODE=real with API_ENV=${env} requires a base URL. ` +
          `Provide BASE_URL (workflow input or repository/environment variable) or set the profile baseUrl in config/environments.ts.`,
      );
    }
    baseUrl = assertHttpUrl(candidate, 'BASE_URL');
  }

  const hasUsername = raw.API_USERNAME !== undefined;
  const hasPassword = raw.API_PASSWORD !== undefined;
  if (hasUsername !== hasPassword) {
    throw new ConfigurationError('API_USERNAME and API_PASSWORD must be provided together');
  }

  const allowPublicDefaults = mode === 'mock' || env === 'prod';
  const credentials: Credentials = {
    username: raw.API_USERNAME ?? (allowPublicDefaults ? PUBLIC_SANDBOX_CREDENTIALS.username : ''),
    password: raw.API_PASSWORD ?? (allowPublicDefaults ? PUBLIC_SANDBOX_CREDENTIALS.password : ''),
  };

  if (credentials.username === '' || credentials.password === '') {
    throw new ConfigurationError(
      `API_MODE=real with API_ENV=${env} requires API_USERNAME and API_PASSWORD (environment-scoped secrets).`,
    );
  }

  const requestedWorkers = raw.WORKERS ?? DEFAULT_WORKERS;
  const workerCeiling = mode === 'mock' ? MAX_MOCK_WORKERS : profile.maxWorkers;
  const workers = Math.min(requestedWorkers, workerCeiling);

  const isPublicSandbox =
    mode === 'real' && baseUrl === assertHttpUrl(ENVIRONMENTS.prod.baseUrl, 'prod baseUrl');
  const runBehaviourTests = raw.RUN_BEHAVIOUR_TESTS === 'true' || isPublicSandbox;

  return Object.freeze({
    mode,
    env,
    profile,
    baseUrl,
    mockPort,
    mockAdminKey,
    credentials: Object.freeze(credentials),
    workers,
    requestedWorkers,
    requestTimeoutMs: raw.REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS,
    tokenTtlMs: raw.TOKEN_TTL_MS ?? DEFAULT_TOKEN_TTL_MS,
    logLevel: raw.LOG_LEVEL ?? 'info',
    isCi: raw.CI === 'true' || raw.CI === '1',
    isMock: mode === 'mock',
    runId: RUN_ID,
    runBehaviourTests,
  });
}

/** The single resolved configuration used by the application. */
export const ENV: AppEnvironment = resolveEnvironment();

/** Short, secret-free description for logs and the Allure environment block. */
export function describeTarget(environment: AppEnvironment = ENV): string {
  if (environment.mode === 'mock') {
    return `mock (${environment.baseUrl})`;
  }
  return `${environment.env} (${environment.baseUrl})`;
}
