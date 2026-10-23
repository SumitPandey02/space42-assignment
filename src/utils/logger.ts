/**
 * Structured, redacted logging. This is the ONLY module allowed to touch
 * `console` (enforced by ESLint `no-console`), which keeps log hygiene in one
 * reviewable place instead of scattered across the codebase.
 *
 * Output is one JSON object per line so CI logs stay greppable.
 */

import { redact } from './sanitizer';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(scope: string, context?: Record<string, unknown>): Logger;
}

function parseLevel(raw: string | undefined): LogLevel {
  const candidate = raw?.trim().toLowerCase();
  if (candidate !== undefined && candidate in LEVEL_WEIGHT) {
    return candidate as LogLevel;
  }
  return 'info';
}

let currentLevel: LogLevel = parseLevel(process.env.LOG_LEVEL);

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function isEnabled(level: Exclude<LogLevel, 'silent'>): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[currentLevel];
}

function emit(
  level: Exclude<LogLevel, 'silent'>,
  scope: string,
  message: string,
  context: Record<string, unknown>,
): void {
  if (!isEnabled(level)) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    ...(Object.keys(context).length > 0 ? { context: redact(context) } : {}),
  };

  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(scope: string, baseContext: Record<string, unknown> = {}): Logger {
  const merged = (context?: Record<string, unknown>): Record<string, unknown> => ({
    ...baseContext,
    ...context,
  });

  return {
    debug: (message, context) => emit('debug', scope, message, merged(context)),
    info: (message, context) => emit('info', scope, message, merged(context)),
    warn: (message, context) => emit('warn', scope, message, merged(context)),
    error: (message, context) => emit('error', scope, message, merged(context)),
    child: (childScope, context) => createLogger(`${scope}.${childScope}`, merged(context)),
  };
}

/** Shared root logger; feature modules should create scoped children. */
export const logger: Logger = createLogger('space42');
