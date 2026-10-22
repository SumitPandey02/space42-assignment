/**
 * Deterministic enterprise mock of the booking API.
 *
 * The public sandbox cannot demonstrate several behaviours the assessment asks
 * us to cover (401/403 handling, overlap rejection, optimistic locking, strict
 * validation). This server provides them on localhost so those tests are fast,
 * hermetic and repeatable, while the `real` mode continues to record what the
 * sandbox actually does.
 *
 * Contract parity with the sandbox that is deliberately preserved:
 *   - POST /auth returns 200 with `{ reason }` on bad credentials.
 *   - POST /booking returns 201 (the sandbox returns 200; clients accept both).
 *   - GET /ping returns 201 "Created".
 *   - DELETE returns 204 (the sandbox returns 201 "Created").
 *   - Missing bookings return 404 (the sandbox returns 403 for deletes).
 *
 * Enterprise additions (documented in docs/test-strategy.md):
 *   - Writes require a valid token; a viewer token gets 403.
 *   - Overlapping dates for the same room get 409.
 *   - `If-Match` is honoured; a stale ETag gets 412.
 *   - Invalid payloads get 400 with machine-readable details.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { z } from 'zod';

import {
  bookingCreateSchema,
  bookingPatchSchema,
  bookingUpdateSchema,
  type Booking,
  type BookingCreateInput,
  type BookingPatchInput,
} from '../contracts/booking.schema';
import { rangesOverlap } from '../utils/date-utils';
import type { Logger } from '../utils/logger';

const MAX_BODY_BYTES = 64 * 1024;

export type MockRole = 'admin' | 'viewer';

export interface MockServerOptions {
  readonly adminKey: string;
  readonly adminUsername: string;
  readonly adminPassword: string;
  readonly viewerUsername: string;
  readonly viewerPassword: string;
  readonly tokenTtlMs: number;
  readonly logger: Logger;
}

interface StoredBooking {
  readonly bookingid: number;
  readonly version: number;
  readonly booking: Booking;
}

interface IssuedToken {
  readonly role: MockRole;
  readonly expiresAt: number;
}

const credentialsSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const filterSchema = z.object({
  firstname: z.string().optional(),
  lastname: z.string().optional(),
  checkin: z.string().optional(),
  checkout: z.string().optional(),
  depositpaid: z.enum(['true', 'false']).optional(),
});

type Filter = z.infer<typeof filterSchema>;

function mergeBooking(current: Booking, patch: BookingPatchInput): Booking {
  return {
    firstname: patch.firstname ?? current.firstname,
    lastname: patch.lastname ?? current.lastname,
    totalprice: patch.totalprice ?? current.totalprice,
    depositpaid: patch.depositpaid ?? current.depositpaid,
    bookingdates: patch.bookingdates ?? current.bookingdates,
    ...(patch.additionalneeds !== undefined
      ? { additionalneeds: patch.additionalneeds }
      : current.additionalneeds !== undefined
        ? { additionalneeds: current.additionalneeds }
        : {}),
    ...(patch.roomid !== undefined
      ? { roomid: patch.roomid }
      : current.roomid !== undefined
        ? { roomid: current.roomid }
        : {}),
  };
}

function roomKey(booking: Booking): string {
  return booking.roomid === undefined ? 'unassigned' : String(booking.roomid);
}

export class MockBookingStore {
  private readonly bookings = new Map<number, StoredBooking>();
  private nextId = 1_000;

  reset(): void {
    this.bookings.clear();
    this.nextId = 1_000;
  }

  get size(): number {
    return this.bookings.size;
  }

  get bookingIds(): number[] {
    return [...this.bookings.keys()];
  }

  find(id: number): StoredBooking | undefined {
    return this.bookings.get(id);
  }

  list(filter: Filter): StoredBooking[] {
    return [...this.bookings.values()].filter(({ booking }) => {
      if (filter.firstname !== undefined && booking.firstname !== filter.firstname) return false;
      if (filter.lastname !== undefined && booking.lastname !== filter.lastname) return false;
      if (filter.checkin !== undefined && booking.bookingdates.checkin !== filter.checkin) return false;
      if (filter.checkout !== undefined && booking.bookingdates.checkout !== filter.checkout) return false;
      if (filter.depositpaid !== undefined && String(booking.depositpaid) !== filter.depositpaid)
        return false;
      return true;
    });
  }

  findOverlap(candidate: Booking, excludeId?: number): StoredBooking | undefined {
    return [...this.bookings.values()].find((stored) => {
      if (stored.bookingid === excludeId) return false;
      if (roomKey(stored.booking) !== roomKey(candidate)) return false;
      return rangesOverlap(
        stored.booking.bookingdates.checkin,
        stored.booking.bookingdates.checkout,
        candidate.bookingdates.checkin,
        candidate.bookingdates.checkout,
      );
    });
  }

  create(input: BookingCreateInput): StoredBooking {
    const id = this.nextId++;
    const stored: StoredBooking = { bookingid: id, version: 1, booking: input };
    this.bookings.set(id, stored);
    return stored;
  }

  replace(id: number, input: BookingCreateInput): StoredBooking {
    const current = this.bookings.get(id);
    if (current === undefined) {
      throw new Error(`Booking ${id} not found`);
    }
    const stored: StoredBooking = { bookingid: id, version: current.version + 1, booking: input };
    this.bookings.set(id, stored);
    return stored;
  }

  patch(id: number, patch: BookingPatchInput): StoredBooking {
    const current = this.bookings.get(id);
    if (current === undefined) {
      throw new Error(`Booking ${id} not found`);
    }
    const merged = mergeBooking(current.booking, patch);
    const stored: StoredBooking = { bookingid: id, version: current.version + 1, booking: merged };
    this.bookings.set(id, stored);
    return stored;
  }

  remove(id: number): boolean {
    return this.bookings.delete(id);
  }
}

export class MockTokenStore {
  private readonly tokens = new Map<string, IssuedToken>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  issue(role: MockRole): string {
    const token = `mock-${role}-${randomUUID()}`;
    this.tokens.set(token, { role, expiresAt: this.clock() + this.ttlMs });
    return token;
  }

  verify(token: string): MockRole | undefined {
    const issued = this.tokens.get(token);
    if (issued === undefined) return undefined;
    if (issued.expiresAt <= this.clock()) {
      this.tokens.delete(token);
      return undefined;
    }
    return issued.role;
  }

  expire(token: string): boolean {
    return this.tokens.delete(token);
  }

  expireAll(): void {
    this.tokens.clear();
  }

  get size(): number {
    return this.tokens.size;
  }
}

export interface MockApi {
  readonly server: Server;
  readonly store: MockBookingStore;
  readonly tokens: MockTokenStore;
  /** Binds to an ephemeral port when `port` is 0. */
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers);
  res.end();
}

function etagOf(version: number): string {
  return `"v${version}"`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (raw.trim() === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

function validationDetails(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
}

function readCookieToken(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie;
  if (typeof cookie !== 'string') return undefined;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'token') return rest.join('=');
  }
  return undefined;
}

/** Creates the mock API without binding it to a port (test-friendly). */
export function createMockApi(options: MockServerOptions): MockApi {
  const store = new MockBookingStore();
  const tokens = new MockTokenStore(options.tokenTtlMs);

  const isAdminRequest = (req: IncomingMessage): boolean => req.headers['x-admin-key'] === options.adminKey;

  const currentRole = (req: IncomingMessage): MockRole | undefined => {
    const token = readCookieToken(req);
    return token === undefined ? undefined : tokens.verify(token);
  };

  const preconditionsPass = (req: IncomingMessage, stored: StoredBooking): boolean => {
    const ifMatch = req.headers['if-match'];
    if (typeof ifMatch !== 'string' || ifMatch === '') return true;
    return ifMatch === etagOf(stored.version);
  };

  const sourceOf = (req: IncomingMessage): string => `${req.method ?? 'GET'} ${req.url ?? '/'}`;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://mock.local');
    const method = req.method ?? 'GET';
    const path = url.pathname;

    // ------------------------------------------------------------ admin API
    if (path.startsWith('/__admin/')) {
      if (!isAdminRequest(req)) {
        sendJson(res, 403, { error: 'Forbidden', reason: 'Missing or invalid x-admin-key' });
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'MethodNotAllowed' });
        return;
      }
      if (path === '/__admin/reset') {
        store.reset();
        tokens.expireAll();
        sendJson(res, 200, { status: 'reset', bookings: store.size, tokens: tokens.size });
        return;
      }
      if (path === '/__admin/expire-tokens') {
        tokens.expireAll();
        sendJson(res, 200, { status: 'tokens-expired', tokens: tokens.size });
        return;
      }
      if (path === '/__admin/expire-token') {
        const parsed = parseJson(await readBody(req));
        const token = parsed.ok ? z.object({ token: z.string().min(1) }).safeParse(parsed.value) : undefined;
        if (token === undefined || !token.success) {
          sendJson(res, 400, { error: 'ValidationError', details: ['token: required string'] });
          return;
        }
        sendJson(res, 200, { status: 'token-expired', removed: tokens.expire(token.data.token) });
        return;
      }
      sendJson(res, 404, { error: 'NotFound' });
      return;
    }

    // ------------------------------------------------------------ health/auth
    if (path === '/ping' && method === 'GET') {
      sendText(res, 201, 'Created');
      return;
    }

    if (path === '/auth' && method === 'POST') {
      const raw = await readBody(req);
      const parsedJson = parseJson(raw);
      if (!parsedJson.ok) {
        sendJson(res, 400, { error: 'ValidationError', details: ['(root): invalid JSON body'] });
        return;
      }
      const parsed = credentialsSchema.safeParse(parsedJson.value);
      if (!parsed.success) {
        sendJson(res, 400, { error: 'ValidationError', details: validationDetails(parsed.error) });
        return;
      }
      const { username, password } = parsed.data;
      if (username === options.adminUsername && password === options.adminPassword) {
        sendJson(res, 200, { token: tokens.issue('admin') });
        return;
      }
      if (username === options.viewerUsername && password === options.viewerPassword) {
        sendJson(res, 200, { token: tokens.issue('viewer') });
        return;
      }
      sendJson(res, 200, { reason: 'Bad credentials' });
      return;
    }

    // ------------------------------------------------------------ collection
    if (path === '/booking' && method === 'GET') {
      const parsedFilter = filterSchema.safeParse({
        firstname: url.searchParams.get('firstname') ?? undefined,
        lastname: url.searchParams.get('lastname') ?? undefined,
        checkin: url.searchParams.get('checkin') ?? undefined,
        checkout: url.searchParams.get('checkout') ?? undefined,
        depositpaid: url.searchParams.get('depositpaid') ?? undefined,
      });
      if (!parsedFilter.success) {
        sendJson(res, 400, { error: 'ValidationError', details: validationDetails(parsedFilter.error) });
        return;
      }
      sendJson(
        res,
        200,
        store.list(parsedFilter.data).map(({ bookingid }) => ({ bookingid })),
      );
      return;
    }

    if (path === '/booking' && method === 'POST') {
      const role = currentRole(req);
      if (role === undefined) {
        sendJson(res, 401, { error: 'Unauthorized', reason: 'A valid token cookie is required' });
        return;
      }
      if (role !== 'admin') {
        sendJson(res, 403, { error: 'Forbidden', reason: 'Viewer role cannot create bookings' });
        return;
      }

      const raw = await readBody(req);
      const parsedJson = parseJson(raw);
      if (!parsedJson.ok) {
        sendJson(res, 400, { error: 'ValidationError', details: ['(root): invalid JSON body'] });
        return;
      }
      const parsed = bookingCreateSchema.safeParse(parsedJson.value);
      if (!parsed.success) {
        sendJson(res, 400, { error: 'ValidationError', details: validationDetails(parsed.error) });
        return;
      }
      if (store.findOverlap(parsed.data) !== undefined) {
        sendJson(res, 409, {
          error: 'Conflict',
          reason: 'Booking dates overlap an existing reservation for this room',
        });
        return;
      }
      const stored = store.create(parsed.data);
      sendJson(
        res,
        201,
        { bookingid: stored.bookingid, booking: stored.booking },
        { etag: etagOf(stored.version) },
      );
      return;
    }

    // ------------------------------------------------------------ item
    const itemMatch = /^\/booking\/([^/]+)$/.exec(path);
    if (itemMatch !== null) {
      const rawId = itemMatch[1];
      const id = rawId === undefined ? Number.NaN : Number(rawId);
      const validId = Number.isInteger(id) && id > 0;

      if (!validId) {
        sendText(res, 404, 'Not Found');
        return;
      }

      if (method === 'GET') {
        const stored = store.find(id);
        if (stored === undefined) {
          sendText(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, stored.booking, { etag: etagOf(stored.version) });
        return;
      }

      const role = currentRole(req);
      if (role === undefined) {
        sendJson(res, 401, { error: 'Unauthorized', reason: 'A valid token cookie is required' });
        return;
      }
      if (role !== 'admin') {
        sendJson(res, 403, { error: 'Forbidden', reason: 'Viewer role cannot mutate bookings' });
        return;
      }

      const stored = store.find(id);
      if (stored === undefined) {
        sendJson(res, 404, { error: 'NotFound', reason: `Booking ${id} does not exist` });
        return;
      }

      if (method === 'PUT' || method === 'PATCH') {
        if (!preconditionsPass(req, stored)) {
          sendJson(res, 412, {
            error: 'PreconditionFailed',
            reason: `If-Match does not match current ETag ${etagOf(stored.version)}`,
          });
          return;
        }

        const raw = await readBody(req);
        const parsedJson = parseJson(raw);
        if (!parsedJson.ok) {
          sendJson(res, 400, { error: 'ValidationError', details: ['(root): invalid JSON body'] });
          return;
        }

        if (method === 'PUT') {
          const parsed = bookingUpdateSchema.safeParse(parsedJson.value);
          if (!parsed.success) {
            sendJson(res, 400, { error: 'ValidationError', details: validationDetails(parsed.error) });
            return;
          }
          if (store.findOverlap(parsed.data, id) !== undefined) {
            sendJson(res, 409, {
              error: 'Conflict',
              reason: 'Booking dates overlap an existing reservation for this room',
            });
            return;
          }
          const updated = store.replace(id, parsed.data);
          sendJson(res, 200, updated.booking, { etag: etagOf(updated.version) });
          return;
        }

        const parsed = bookingPatchSchema.safeParse(parsedJson.value);
        if (!parsed.success) {
          sendJson(res, 400, { error: 'ValidationError', details: validationDetails(parsed.error) });
          return;
        }
        const candidate = mergeBooking(stored.booking, parsed.data);
        if (store.findOverlap(candidate, id) !== undefined) {
          sendJson(res, 409, {
            error: 'Conflict',
            reason: 'Booking dates overlap an existing reservation for this room',
          });
          return;
        }
        const updated = store.patch(id, parsed.data);
        sendJson(res, 200, updated.booking, { etag: etagOf(updated.version) });
        return;
      }

      if (method === 'DELETE') {
        if (!preconditionsPass(req, stored)) {
          sendJson(res, 412, { error: 'PreconditionFailed', reason: 'Stale ETag' });
          return;
        }
        store.remove(id);
        sendEmpty(res, 204);
        return;
      }

      sendJson(res, 405, { error: 'MethodNotAllowed' });
      return;
    }

    sendJson(res, 404, { error: 'NotFound', path });
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      // Only one response per request; guard idempotently by checking headersSent.
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : 'Unexpected mock failure';
        options.logger.error('mock request failed', { source: sourceOf(req), error: message });
        sendJson(res, 500, { error: 'InternalServerError', reason: message });
      }
    });
  });

  return {
    server,
    store,
    tokens,
    listen: (port, host = '127.0.0.1') =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('Mock server did not bind to a TCP port'));
            return;
          }
          resolve(address.port);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
