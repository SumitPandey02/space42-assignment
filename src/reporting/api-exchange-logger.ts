/**
 * Framework-wide API exchange logging.
 *
 * The logger is stateless. Each request attempt carries its own correlation ID
 * and immutable snapshots, so concurrent requests cannot overwrite or mispair
 * each other's output. Console and Allure failures are caught locally: logging
 * must never change the outcome of the HTTP request.
 */

import { attachment } from 'allure-js-commons';

import type { Logger } from '../utils/logger';
import {
  buildApiExchangeName,
  formatApiExchangeAttachment,
  formatApiRequest,
  formatApiResponse,
  type ApiLoggingOptions,
  type ApiRequestSnapshot,
  type ApiResponseSnapshot,
} from './api-exchange-format';

export interface ApiExchangeLoggerSinks {
  readonly console: (block: string) => void;
  readonly allure: (name: string, content: string) => Promise<void>;
}

function defaultSinks(logger: Logger): ApiExchangeLoggerSinks {
  return {
    console: (block) => {
      logger.block(block);
    },
    allure: async (name, content) => {
      await attachment(name, content, { contentType: 'application/json' });
    },
  };
}

export class ApiExchangeLogger {
  private readonly sinks: ApiExchangeLoggerSinks;

  constructor(
    private readonly options: ApiLoggingOptions,
    private readonly logger: Logger,
    overrides: Partial<ApiExchangeLoggerSinks> = {},
  ) {
    const defaults = defaultSinks(logger);
    this.sinks = {
      console: overrides.console ?? defaults.console,
      allure: overrides.allure ?? defaults.allure,
    };
  }

  logRequest(request: ApiRequestSnapshot): void {
    if (!this.options.enabled) {
      return;
    }

    try {
      const block = formatApiRequest(request, this.options);
      if (block !== '') {
        this.sinks.console(block);
      }
    } catch (error) {
      this.warn('failed to log API request', error);
    }
  }

  async logResponse(request: ApiRequestSnapshot, response: ApiResponseSnapshot): Promise<void> {
    if (!this.options.enabled) {
      return;
    }

    try {
      const block = formatApiResponse(response, this.options);
      if (block !== '') {
        this.sinks.console(block);
      }
    } catch (error) {
      this.warn('failed to log API response', error);
    }

    try {
      const content = formatApiExchangeAttachment(request, response, this.options);
      await this.sinks.allure(buildApiExchangeName(request), content);
    } catch (error) {
      this.warn('failed to attach API exchange to Allure', error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.logger.warn(message, {
        error: error instanceof Error ? error.message : error,
      });
    } catch {
      // Logging must never mask the original request result.
    }
  }
}

export function createApiExchangeLogger(options: ApiLoggingOptions, logger: Logger): ApiExchangeLogger {
  return new ApiExchangeLogger(options, logger.child('api'));
}
