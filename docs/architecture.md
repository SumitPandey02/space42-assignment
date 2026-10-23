# Architecture

## Goals

1. Exercise the booking lifecycle end-to-end against the real host.
2. Record how the host behaves when it cannot demonstrate enterprise rules, without weakening the suite.
3. Protect the shared sandbox: bounded workers, unique test data, cleanup by ID only.
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
src/utils/              cross-cutting primitives
config/                 environment resolution
```

Dependencies point downward. Tests never talk to `APIRequestContext` directly.

## Environment resolution

`resolveEnvironment(source)` is a pure function; `ENV` is the process-wide result.

Precedence: process env -> `.env` -> defaults.

`BASE_URL` defaults to the public restful-booker sandbox. Worker count is capped at 4 to stay polite on the shared host. Credentials default to the published demo values and must be supplied together when overridden.

Configuration fails fast when:

- credentials are half-provided
- a base URL is malformed or non-HTTP

## Request lifecycle

```text
BookingClient.create()
  -> TokenManager.getToken()            (cache or single-flight refresh)
  -> HttpTransport.send()               (URL + headers + retry policy)
  -> APIRequestContext.fetch()          (Playwright)
  -> RawResponse { status, headers, text, json, duration }
  -> assertStatus()                     (typed error for unexpected status)
  -> Zod parse                          (SchemaValidationError with issue paths)
```

`HttpTransport` never throws for a non-2xx response. Callers decide what is expected, which is what makes adaptive contract tests readable.

## Authentication

`TokenManager` owns exactly three things:

1. Cache with an acquisition timestamp. The API has no expiry, so the TTL is a local refresh threshold, never a fabricated `exp` claim.
2. Single-flight refresh. Concurrent callers in one runtime await the same promise, so parallel setup hooks cannot stampede `/auth`.
3. Failure hygiene. A rejected refresh clears both the cached token and the in-flight promise; the next caller starts clean.

`BookingClient.authorizedSend`:

```text
token = cache.get()
response = send(Cookie: token=...)
if 401 and retry allowed:
    cache.invalidate()
    token = cache.refresh()    // single-flight
    send once more
else return / throw
```

Only writes use the token; reads are public. A POST replay after a 401 is safe because a 401 means the write was rejected, not applied. 403 is never retried because a refresh cannot repair permissions.

Scope: the lock is in-memory and per runtime (one Playwright worker). Each worker authenticates once per TTL window; no cross-process lock is needed at this scale.

**Not observable on this host:** restful-booker never returns 401 for writes, exposes no refresh token, and its ETag is an unenforced infrastructure header. The manager performs re-authentication, not OAuth refresh. The adaptively tested auth contract records whether writes are enforced; it cannot force the 401 path.

## Retry safety

Policy: 2 retries, 300 ms base, 4 s cap, 20% jitter, bounded exponential backoff.

Retryable:

- status 408, 425, 429, 500, 502, 503, 504
- transport failures for GET/PUT/PATCH/DELETE (replay-safe)

Not retryable:

- POST after an ambiguous transport failure; the server may have applied the write
- any 4xx outside the retryable set

On exhaustion the transport returns the final HTTP response if one exists, so assertions see real status codes rather than a synthetic timeout.

## Contracts and models

Zod is the single source of truth:

- `bookingBaseSchema` validates names, numbers, booleans, nested dates and optional `roomid`
- `bookingDatesSchema` enforces real calendar dates (`z.iso.date`) and checkout > checkin
- `bookingPatchSchema` is `.partial()`
- `authResponseSchema` is a union: `{ token }` or `{ reason }`

`z.infer` derives all TypeScript types. `normaliseBooking` strips `roomid`, so a payload sent to a host that drops it can still be compared with the response.

## Fixtures and test data

Worker scope: `apiContext`, `transport`, `authClient`, `tokenManager`, `bookingApi`, `factory`.

Test scope: `cleanup` (auto).

`BookingFactory`:

- names include run id + worker + sequence, making leaked records attributable
- dates are relative to today, so they never expire
- default room and date window derive from worker + sequence; overlap tests pass the same room/dates explicitly

`CleanupTracker` records IDs at creation, supports `untrack` after an explicit delete, and in teardown deletes only tracked IDs, swallowing and logging failures.

## Adaptive host contracts

`tests/contracts/host-capabilities.spec.ts` covers behaviours that differ between a permissive sandbox and an enterprise deployment. Each test:

1. performs the operation with raw methods;
2. accepts the legitimate outcome set (accepted with safety checks, or rejected with no side effects);
3. attaches the observed capability to Allure so the report explains what the host actually did;
4. fails on any status outside the set.

This is intentionally not a mock: it tests the real host and documents its capability instead of simulating one.

## Observability

- `Logger` is the only module allowed to call `console`; output is JSON lines.
- `redact` deep-clones and redacts tokens, passwords, cookies, authorization headers, API keys and free-form `key=value` patterns.
- `HttpTransport` records a bounded (50) sanitised history of every attempt.
- On failure, the fixture attaches that history to Allure; successful tests clear it.
- Global setup writes Allure `environment.properties` and, in CI, `executor.json`.

## Extension points

- New endpoint: add a schema, a client method, and a raw variant for negative tests.
- New environment: supply `BASE_URL` and credentials at runtime.
- New capability: extend the adaptive contract spec and record the outcome.
- New auth scheme: implement `AuthTokenFetcher`; `TokenManager` stays unchanged.
