/**
 * Runtime configuration resolver.
 *
 * Precedence (highest first):
 *   1. process environment (CI inputs, repository/environment vars, secrets)
 *   2. local `.env` file (loaded here, never committed)
 *   3. built-in defaults
 *
 * `dotenv` never overrides variables that already exist in the environment, so
 * CI values always win over a developer's `.env`.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { ConfigurationError } from '../src/utils/errors';
import type { LogLevel } from '../src/utils/logger';
import { RUN_ID } from '../src/utils/run-id';

loadDotenv({ quiet: true });

const DEFAULT_BASE_URL = 'https://restful-booker.herokuapp.com';
const PUBLIC_SANDBOX_CREDENTIALS = Object.freeze({
  username: 'admin',
  password: 'password123',
});

const DEFAULT_WORKERS = 4;
const MAX_WORKERS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOKEN_TTL_MS = 600_000;

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalInt = (min: number, max: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).optional());

/** CI secrets render as an empty string when unset; treat that as absent. */
const optionalText = (schema: z.ZodString) => z.preprocess(emptyToUndefined, schema.optional());

const optionalBoolean = z.preprocess((value: unknown) => {
  if (typeof value !== 'string') {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '') {
    return undefined;
  }
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  return value;
}, z.boolean().optional());

const rawEnvironmentSchema = z.object({
  BASE_URL: optionalText(z.string().trim().min(1)),
  API_USERNAME: optionalText(z.string().trim().min(1)),
  API_PASSWORD: optionalText(z.string().min(1)),
  WORKERS: optionalInt(1, 64),
  REQUEST_TIMEOUT_MS: optionalInt(1_000, 120_000),
  TOKEN_TTL_MS: optionalInt(1_000, 86_400_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
  API_LOGGING_ENABLED: optionalBoolean,
  API_LOG_REQUEST_BODY: optionalBoolean,
  API_LOG_RESPONSE_BODY: optionalBoolean,
  CI: z.string().optional(),
});

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

export interface ApiLoggingConfig {
  readonly enabled: boolean;
  readonly requestBody: boolean;
  readonly responseBody: boolean;
}

export interface AppEnvironment {
  readonly baseUrl: string;
  readonly credentials: Credentials;
  /** Effective worker count after the shared-host cap is applied. */
  readonly workers: number;
  readonly requestTimeoutMs: number;
  readonly tokenTtlMs: number;
  readonly logLevel: LogLevel;
  readonly apiLogging: ApiLoggingConfig;
  readonly isCi: boolean;
  readonly runId: string;
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

export function resolveEnvironment(source: NodeJS.ProcessEnv = process.env): AppEnvironment {
  const parsed = rawEnvironmentSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigurationError(`Invalid environment configuration -> ${formatIssues(parsed.error.issues)}`);
  }

  const raw = parsed.data;
  const baseUrl = assertHttpUrl(raw.BASE_URL ?? DEFAULT_BASE_URL, 'BASE_URL');

  const hasUsername = raw.API_USERNAME !== undefined;
  const hasPassword = raw.API_PASSWORD !== undefined;
  if (hasUsername !== hasPassword) {
    throw new ConfigurationError('API_USERNAME and API_PASSWORD must be provided together');
  }

  const credentials: Credentials = {
    username: raw.API_USERNAME ?? PUBLIC_SANDBOX_CREDENTIALS.username,
    password: raw.API_PASSWORD ?? PUBLIC_SANDBOX_CREDENTIALS.password,
  };

  return Object.freeze({
    baseUrl,
    credentials: Object.freeze(credentials),
    workers: Math.min(raw.WORKERS ?? DEFAULT_WORKERS, MAX_WORKERS),
    requestTimeoutMs: raw.REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS,
    tokenTtlMs: raw.TOKEN_TTL_MS ?? DEFAULT_TOKEN_TTL_MS,
    logLevel: raw.LOG_LEVEL ?? 'info',
    apiLogging: Object.freeze({
      enabled: raw.API_LOGGING_ENABLED ?? true,
      requestBody: raw.API_LOG_REQUEST_BODY ?? true,
      responseBody: raw.API_LOG_RESPONSE_BODY ?? true,
    }),
    isCi: raw.CI === 'true' || raw.CI === '1',
    runId: RUN_ID,
  });
}

/** The single resolved configuration used by the application. */
export const ENV: AppEnvironment = resolveEnvironment();
