/**
 * Booking API client.
 *
 * Two layers, on purpose:
 *   - `*Raw` methods return the `RawResponse` untouched so negative tests can
 *     assert exact status codes (409 conflict, 400 validation, 404 purge...).
 *   - typed methods assert the expected status AND validate the body with Zod,
 *     returning domain objects that are guaranteed to satisfy the contract.
 *
 * Authentication: typed writes go through `authorizedSend(..., { retryOn401: true })`,
 * which invalidates and refreshes the token once, then replays. Replaying is safe
 * because a 401 means the request was rejected, not applied. 403 is never retried:
 * a refresh cannot repair an authorization failure.
 */

import type {
  Booking,
  BookingCreateInput,
  BookingPatchInput,
  BookingResponse,
  BookingSummary,
  BookingUpdateInput,
} from '../contracts/booking.schema';
import { bookingListSchema, bookingResponseSchema, bookingSchema } from '../contracts/booking.schema';
import { AuthenticationError, SchemaValidationError } from '../utils/errors';
import type { Logger } from '../utils/logger';
import type { TokenManager } from '../auth/token-manager';
import { assertStatus, type HttpTransport, type RawResponse, type RequestSpec } from './http-client';

export interface BookingFilter {
  readonly firstname?: string;
  readonly lastname?: string;
  readonly checkin?: string;
  readonly checkout?: string;
  readonly depositpaid?: boolean;
}

export interface RawWriteOptions {
  /** Set false to deliberately send an unauthenticated write (auth contract tests). */
  readonly authenticated?: boolean;
}

function issuesOf(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string[] {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
}

export class BookingClient {
  constructor(
    private readonly transport: HttpTransport,
    private readonly tokens: TokenManager,
    private readonly logger: Logger,
  ) {}

  // ---------------------------------------------------------------- health

  /** GET /ping. restful-booker answers 201, enterprise hosts usually 200. */
  async ping(): Promise<RawResponse> {
    const response = await this.transport.send({ method: 'GET', path: '/ping', operation: 'GET /ping' });
    assertStatus(response, { expected: [200, 201], operation: 'health check' });
    return response;
  }

  // ---------------------------------------------------------------- create

  async createRaw(input: BookingCreateInput, options: RawWriteOptions = {}): Promise<RawResponse> {
    const spec: Omit<RequestSpec, 'headers'> = {
      method: 'POST',
      path: '/booking',
      body: input,
      operation: 'POST /booking',
    };
    return options.authenticated === false ? this.transport.send(spec) : this.authorizedSend(spec);
  }

  async create(input: BookingCreateInput): Promise<BookingResponse> {
    const response = await this.authorizedSend(
      { method: 'POST', path: '/booking', body: input, operation: 'POST /booking' },
      { retryOn401: true },
    );
    assertStatus(response, { expected: [200, 201], operation: 'create booking' });

    const parsed = bookingResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SchemaValidationError('POST /booking response', issuesOf(parsed.error));
    }
    return parsed.data;
  }

  // ------------------------------------------------------------------- read

  async getRaw(id: number): Promise<RawResponse> {
    return this.transport.send({ method: 'GET', path: `/booking/${id}`, operation: `GET /booking/${id}` });
  }

  async getById(id: number): Promise<Booking> {
    const response = await this.getRaw(id);
    assertStatus(response, { expected: [200], operation: `get booking ${id}` });

    const parsed = bookingSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SchemaValidationError(`GET /booking/${id} response`, issuesOf(parsed.error));
    }
    return parsed.data;
  }

  /** Non-throwing existence probe used by the resilience layer. */
  async exists(id: number): Promise<boolean> {
    const response = await this.getRaw(id);
    return response.status === 200;
  }

  async listRaw(filter: BookingFilter = {}): Promise<RawResponse> {
    const query: Record<string, string | number | boolean> = {};
    if (filter.firstname !== undefined) query['firstname'] = filter.firstname;
    if (filter.lastname !== undefined) query['lastname'] = filter.lastname;
    if (filter.checkin !== undefined) query['checkin'] = filter.checkin;
    if (filter.checkout !== undefined) query['checkout'] = filter.checkout;
    if (filter.depositpaid !== undefined) query['depositpaid'] = filter.depositpaid;
    return this.transport.send({ method: 'GET', path: '/booking', query, operation: 'GET /booking' });
  }

  async list(filter: BookingFilter = {}): Promise<BookingSummary[]> {
    const response = await this.listRaw(filter);
    assertStatus(response, { expected: [200], operation: 'list bookings' });

    const parsed = bookingListSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SchemaValidationError('GET /booking response', issuesOf(parsed.error));
    }
    return parsed.data;
  }

  // ----------------------------------------------------------------- update

  async update(id: number, input: BookingUpdateInput): Promise<Booking> {
    const response = await this.authorizedSend(
      { method: 'PUT', path: `/booking/${id}`, body: input, operation: `PUT /booking/${id}` },
      { retryOn401: true },
    );
    assertStatus(response, { expected: [200], operation: `update booking ${id}` });
    return this.parseBookingBody(response, `PUT /booking/${id} response`);
  }

  async patchRaw(id: number, patch: BookingPatchInput, options: RawWriteOptions = {}): Promise<RawResponse> {
    const spec: Omit<RequestSpec, 'headers'> = {
      method: 'PATCH',
      path: `/booking/${id}`,
      body: patch,
      operation: `PATCH /booking/${id}`,
    };
    return options.authenticated === false ? this.transport.send(spec) : this.authorizedSend(spec);
  }

  async patch(id: number, patch: BookingPatchInput): Promise<Booking> {
    const response = await this.authorizedSend(
      { method: 'PATCH', path: `/booking/${id}`, body: patch, operation: `PATCH /booking/${id}` },
      { retryOn401: true },
    );
    assertStatus(response, { expected: [200], operation: `patch booking ${id}` });
    return this.parseBookingBody(response, `PATCH /booking/${id} response`);
  }

  // ----------------------------------------------------------------- delete

  async remove(id: number): Promise<void> {
    const response = await this.authorizedSend(
      { method: 'DELETE', path: `/booking/${id}`, operation: `DELETE /booking/${id}` },
      { retryOn401: true },
    );
    assertStatus(response, { expected: [200, 201, 204], operation: `delete booking ${id}` });
    this.logger.debug('booking deleted', { bookingId: id });
  }

  // --------------------------------------------------------------- internal

  private parseBookingBody(response: RawResponse, context: string): Booking {
    const parsed = bookingSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SchemaValidationError(context, issuesOf(parsed.error));
    }
    return parsed.data;
  }

  private static authHeaders(token: string): Record<string, string> {
    return { Cookie: `token=${token}` };
  }

  /**
   * Attach the current token. When `retryOn401` is true, a 401 invalidates the
   * cache, performs a single-flight refresh, and replays exactly once.
   */
  private async authorizedSend(
    spec: Omit<RequestSpec, 'headers'>,
    options: { retryOn401?: boolean } = {},
  ): Promise<RawResponse> {
    const retryOn401 = options.retryOn401 === true;
    const token = await this.tokens.getToken();

    const attempt = async (tokenValue: string): Promise<RawResponse> => {
      const response = await this.transport.send({
        ...spec,
        headers: BookingClient.authHeaders(tokenValue),
      });
      if (retryOn401 && response.status === 401) {
        throw new AuthenticationError(`401 intercepted for ${spec.operation ?? spec.path}`, 401);
      }
      return response;
    };

    try {
      return await attempt(token);
    } catch (error) {
      if (!retryOn401 || !(error instanceof AuthenticationError)) {
        throw error;
      }

      this.logger.warn('401 intercepted mid-suite; refreshing token and replaying once', {
        operation: spec.operation ?? spec.path,
      });
      this.tokens.invalidate();
      const refreshed = await this.tokens.refresh();
      return attempt(refreshed);
    }
  }
}
