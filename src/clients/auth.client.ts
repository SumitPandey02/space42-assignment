/**
 * POST /auth client.
 *
 * Implements `AuthTokenFetcher` so the token manager depends on an interface,
 * not on this concrete class (dependency inversion). That also lets unit tests
 * inject a scripted fetcher without any HTTP at all.
 */

import type { Credentials } from '../../config/environment';
import { authResponseSchema, hasToken, type AuthResponse } from '../contracts/auth.schema';
import { AuthenticationError, SchemaValidationError } from '../utils/errors';
import type { Logger } from '../utils/logger';
import { assertStatus, type HttpTransport, type RawResponse } from './http-client';

export interface AuthTokenFetcher {
  fetchToken(credentials: Credentials): Promise<string>;
}

export interface AuthenticationResult {
  readonly response: RawResponse;
  readonly body: AuthResponse;
}

export class AuthClient implements AuthTokenFetcher {
  constructor(
    private readonly transport: HttpTransport,
    private readonly logger: Logger,
  ) {}

  /** Raw-level authentication: returns the parsed body for explicit assertions. */
  async authenticate(credentials: Credentials): Promise<AuthenticationResult> {
    const response = await this.transport.send({
      method: 'POST',
      path: '/auth',
      body: { username: credentials.username, password: credentials.password },
      operation: 'POST /auth',
    });

    assertStatus(response, { expected: [200], operation: 'authenticate' });

    const parsed = authResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SchemaValidationError(
        'POST /auth',
        parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      );
    }

    return { response, body: parsed.data };
  }

  /**
   * Resolve a usable token or throw `AuthenticationError`.
   *
   * restful-booker responds 200 with `{ reason }` for bad credentials, so a
   * missing token - not the status code - is the failure signal.
   */
  async fetchToken(credentials: Credentials): Promise<string> {
    const { body } = await this.authenticate(credentials);
    if (!hasToken(body)) {
      throw new AuthenticationError(`Authentication rejected by the API: ${body.reason}`);
    }
    this.logger.debug('authentication succeeded');
    return body.token;
  }
}
