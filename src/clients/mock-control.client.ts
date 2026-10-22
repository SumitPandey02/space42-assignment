/**
 * Control plane for the deterministic mock API.
 *
 * These endpoints exist only on the mock and are protected by an admin key, so
 * tests can reset state or expire tokens without any knowledge of the mock's
 * internals. Never call this against a real environment.
 */

import { assertStatus, type HttpTransport, type RawResponse } from './http-client';

export class MockControlClient {
  constructor(
    private readonly transport: HttpTransport,
    private readonly adminKey: string,
  ) {}

  private async post(path: string, operation: string, body?: unknown): Promise<RawResponse> {
    const response = await this.transport.send({
      method: 'POST',
      path,
      headers: { 'x-admin-key': this.adminKey },
      operation,
      ...(body === undefined ? {} : { body }),
    });
    assertStatus(response, { expected: [200], operation });
    return response;
  }

  reset(): Promise<RawResponse> {
    return this.post('/__admin/reset', 'mock reset');
  }

  expireTokens(): Promise<RawResponse> {
    return this.post('/__admin/expire-tokens', 'mock expire tokens');
  }

  /** Expire exactly one token, so tests never disturb parallel workers. */
  expireToken(token: string): Promise<RawResponse> {
    return this.post('/__admin/expire-token', 'mock expire token', { token });
  }
}
