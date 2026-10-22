# Architecture

## Goals

1. Exercise the booking lifecycle end-to-end against the real host.
2. Prove enterprise contracts (401/403/409/412, strict validation) that the public sandbox cannot demonstrate.
3. Stay hermetic and fast for pull requests, while still running against the live host nightly.
4. Keep secrets out of logs, reports and the repository.

## Layering

```text
tests/                  scenario intent, assertions, Allure steps
src/fixtures/           wiring + lifecycle (worker vs test scope), cleanup
src/builders/           test-data generation
src/clients/            HTTP semantics and endpoint knowledge
src/auth/               token cache and refresh policy
src/contracts/          Zod schemas -> runtime validation + inferred types
src/models/             domain projections (normalisation)
src/mock/               deterministic enterprise test double
src/utils/              cross-cutting primitives
config/                 environment resolution
```

Dependencies point downward. Tests never talk to `APIRequestContext` directly; the mock control client is the only test-only surface and is guarded by an admin key.

## Environment resolution

`resolveEnvironment(source)` is a pure function; `ENV` is the process-wide result.

Precedence: process env -> `.env` -> named profile -> defaults.

Profiles (`config/environments.ts`) carry:

- base URL (empty means "must be supplied through `BASE_URL`")
- capability flags: `authEnforced`, `roomOverlapEnforced`, `optimisticLockingEnforced`
- worker ceiling to stay polite on a shared host

The assessment target is registered as `prod` because it is the only concrete host supplied. `sandbox` and `uat` are reserved names for dedicated environments; their empty base URLs force an explicit `BASE_URL`, which is safer than silently hitting the wrong host.

Mock mode resolves `BASE_URL` to `http://127.0.0.1:${MOCK_PORT}` so the same transport/client code is exercised in both modes.

Configuration fails fast (`ConfigurationError`) when:

- `real` + `sandbox`/`uat` without `BASE_URL`
- credentials are half-provided
- a base URL is malformed or non-HTTP

## Request lifecycle

```text
BookingClient.create()
  -> TokenManager.getToken()            (cache or single-flight refresh)
  -> HttpTransport.send()               (URL + headers + retry policy)
  -> APIRequestContext.fetch()          (Playwright, no redirects hidden)
  -> RawResponse { status, headers, text, json, duration }
  -> assertStatus()                     (typed error for unexpected status)
  -> Zod parse                          (SchemaValidationError with issue paths)
```

`HttpTransport` never throws for a non-2xx response. Callers decide what is expected, which is what makes negative tests readable (`expect(response.status).toBe(409)`).

`assertStatus` maps:

- 401 -> `AuthenticationError` (repairable by refresh)
- 403 -> `ForbiddenError` (not repairable by refresh)
- anything else -> `ApiError` with method, redacted URL, status and redacted body

## Authentication

`TokenManager` owns exactly three things:

1. Cache with an acquisition timestamp. The API has no expiry, so the TTL is a local refresh threshold, never a fabricated `exp` claim.
2. Single-flight refresh. Concurrent callers in one runtime await the same promise, so parallel setup hooks cannot stampede `/auth`.
3. Failure hygiene. A rejected refresh clears the cached token and the in-flight promise; the next caller starts clean.

`BookingClient.authorizedSend`:

```text
token = cache.get()
response = send(Cookie: token=...)
if 401 and retry allowed:
    cache.invalidate()
    token = cache.refresh()    // single-flight
    send once more
else throw
```

Only writes use the token; reads are public. POST replay after a 401 is safe because a 401 means the write was rejected, not applied. 403 is never retried.

Scope: the lock is in-memory and per runtime (one Playwright worker). It does not coordinate workers. Each worker authenticates once per TTL window, which is cheap and avoids cross-process locking. This limitation is documented in the code and here.

## Retry safety

Policy: 2 retries, 300 ms base, 4 s cap, 20% jitter, bounded exponential backoff.

Retryable:

- status 408, 425, 429, 500, 502, 503, 504
- transport failures for GET/PUT/PATCH/DELETE (replay-safe)

Not retryable:

- POST after an ambiguous transport failure; the server may have applied the write
- any 4xx other than the retryable set

When the retry budget is exhausted, the transport returns the final HTTP response if one exists, so assertions see real status codes rather than a synthetic timeout. If no response exists, the last transport error propagates.

## Contracts and models

Zod is the single source of truth:

- `bookingBaseSchema` validates names, numbers, booleans, nested dates and optional `roomid`
- `bookingDatesSchema` enforces real calendar dates (`z.iso.date`) and checkout > checkin
- `bookingPatchSchema` is `.partial()`
- `authResponseSchema` is a union: `{ token }` or `{ reason }`

`z.infer` derives all TypeScript types. Models add projections, notably `normaliseBooking`, which strips `roomid` so a payload sent to the sandbox can be compared with the response that silently dropped it.

## Fixtures and test data

Worker scope: `apiContext`, `transport`, `authClient`, `tokenManager`, `bookingApi`, `factory`, viewer identity, mock control.

Test scope: `cleanup` (auto) and `target`.

`BookingFactory`:

- names include run id + worker + sequence, making leaked records attributable
- dates are relative to today, so they never expire
- default room and date window derive from worker + sequence to avoid accidental overlap
- tests that want an overlap pass the same room/dates explicitly

`CleanupTracker` records IDs at creation, supports `untrack` after an explicit delete, and in teardown deletes only tracked IDs, swallowing and logging failures (another actor may already have removed them).

## Mock design

`src/mock/mock-api.ts` is an in-memory HTTP server with:

- `POST /auth` (admin and viewer identities)
- full booking CRUD with filters
- token TTL (`MOCK_TOKEN_TTL_MS`)
- overlap enforcement: half-open date ranges per room, `409`
- optimistic locking: `ETag` on GET/create/update, `If-Match` -> `412`
- strict validation -> `400 { error, details }`
- admin control plane guarded by `x-admin-key`:
  - `POST /__admin/reset`
  - `POST /__admin/expire-tokens`
  - `POST /__admin/expire-token` (one token, so parallel workers are undisturbed)

Deliberate parity with the sandbox: auth failure is `200 { reason }`, `POST /booking` returns `201` (sandbox `200`; clients accept both), `GET /ping` returns `201`, `DELETE` returns `204` (sandbox `201`).

Deliberate differences: auth is enforced, unknown ids are `404` (sandbox `405`), overlap and ETags exist, invalid payloads are `400` (sandbox `500`). These are labelled as enterprise behaviour, never as sandbox observations.

`mock-api.standalone.ts` is started by Playwright's `webServer` in mock mode and can be run manually with `npm run mock:server`.

## Observability

- `Logger` is the only module allowed to call `console`; output is JSON lines.
- `redact` deep-clones and redacts tokens, passwords, cookies, authorization headers, API keys and free-form `key=value` patterns.
- `HttpTransport` records a bounded (50) sanitised history of every attempt.
- On failure, the fixture attaches that history to Allure; successful tests clear it.
- Global setup writes Allure `environment.properties` and, in CI, `executor.json`.

## Extension points

- New endpoint: add a schema, a client method, and a raw variant for negative tests.
- New environment: add a profile entry; supply `BASE_URL` and credentials at runtime.
- New enterprise rule: implement in the mock, add an `@enterprise` test, document the sandbox's contrasting behaviour if applicable.
- New auth scheme: implement `AuthTokenFetcher`; `TokenManager` stays unchanged.
