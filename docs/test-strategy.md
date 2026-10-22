# Test strategy

## Tier model

| Tier                 | Purpose                                        | Target             | Network  |
| -------------------- | ---------------------------------------------- | ------------------ | -------- |
| `@unit`              | Pure logic and contracts                       | none               | none     |
| `@enterprise`        | Rules a real enterprise API must have          | deterministic mock | loopback |
| `@core`              | Booking behaviour that should hold on any host | mock or real       | yes      |
| `@sandbox-behaviour` | Documented quirks of the public host           | real `prod` only   | yes      |

The split exists because the public sandbox is a shared, permissive demo:

- it does not enforce authentication
- it allows overlapping bookings
- it has no ETags or optimistic locking
- it returns `500` for missing fields and `405` for unknown ids
- it silently drops `roomid`

Asserting enterprise behaviour there would either fail or, worse, pass for the wrong reason. Unit and mock tiers stay deterministic and offline; core tests are written against the documented happy path; sandbox observations are quarantined and labelled.

## Coverage by concern

### Authentication

- Valid credentials produce a token; bad credentials produce `{ reason }` with no token and HTTP 200.
- Token reuse: repeated `getToken()` calls acquire once.
- TTL: an injected clock proves refresh at the threshold.
- Single-flight: eight concurrent callers produce one acquisition.
- Refresh failure: no cached token, no permanently rejected promise; the next call recovers.
- 401 mid-suite: a token is expired server-side; a typed write refreshes once and replays successfully.
- 403: viewer writes are rejected and do not trigger refresh.

### Booking lifecycle

Create -> read -> PUT replace -> PATCH merge -> delete -> verify gone. Every step validates the body with Zod and compares normalised state, so extra/missing fields are caught.

Post-deletion status is context-sensitive: the sandbox answers `405` to DELETE of an unknown id and `404` to GET; the mock uses `404` for both. Tests accept only "not found" semantics and never invent a resource version.

### Validation and invariants

- ISO calendar validity: `2027-02-29` and `2026-02-30` are rejected (no JavaScript roll-over).
- Checkout strictly after check-in, including PATCH and PUT.
- Required fields, primitive types, positive `roomid`.
- Response schemas validated for every read and write.

### Idempotency and retry safety

- The same complete PUT is sent three times; each response and persisted state must match.
- PATCH changes only `totalprice`; names, dates, deposit flag and additional needs are asserted unchanged.
- The HTTP transport retries only what is safe: GET/PUT/PATCH/DELETE transport failures and the retryable status set. POST is never replayed after an ambiguous network failure.
- Retry diagnostics are logged per attempt; exhaustion returns the final server response when one exists.

### Concurrency

Two conflicting PATCHes are released through an `N`-party barrier and dispatched in one microtask batch. The test records:

- per-request start/finish timestamps
- status codes
- final state

It asserts only what can be substantiated: both writes succeed, the final record is internally consistent with exactly one contender, and dispatch delta is bounded. It does not claim a shared millisecond. Last-write-wins is the documented outcome; the mock does not add locking to plain PATCH.

### Search filters

Only `firstname` and `lastname` are asserted on the core path. They work on both the sandbox and the mock.

Observed sandbox deviations (documented, not asserted as enterprise truth):

- `depositpaid` is ignored (a `false` filter returns a deposit-paid booking).
- `checkin`/`checkout` do not behave as exact matches; combining them with a unique name can return zero results for a booking that exists. The core suite therefore avoids relying on date filters.

### Shared-state resilience

- A booking deleted by another actor (or purged) is treated as gone, not as a framework failure.
- Recovery recreates the prerequisite with fresh test-owned data.
- Bounded retries surface the last actionable error; they never hang.
- Cleanup only deletes IDs created by the current test.

## Test data

`BookingFactory` generates:

- unique first/last names containing run id, worker index and sequence
- dates relative to today (`startOffsetDays`, `nights`)
- a default room derived from worker + sequence
- explicit overrides for overlap scenarios

No hardcoded dates exist in the suite, so tests do not rot. Uniqueness prevents parallel workers and prior runs from polluting filter assertions.

## Isolation and cleanup

- Worker-scoped HTTP context and token cache; test-scoped cleanup tracker.
- `cleanup.create()` registers the ID immediately after a successful create.
- Explicit deletes call `untrack` to avoid a second delete.
- Teardown runs even after failure and only for tracked IDs.
- The mock is reset-capable but tests normally rely on unique rooms rather than global reset, so parallel workers do not interfere.

## Flake controls

- `fullyParallel: true`; worker count from `WORKERS`, capped per profile.
- No sleeps for synchronisation; the barrier coordinates dispatch.
- Retryable server statuses use bounded exponential backoff with jitter.
- Real-host POST create retries on explicit 5xx responses (the write may not have been applied), but never on ambiguous transport failures.
- Token refresh is single-flight, so parallel hooks do not race `/auth`.
- Failure-only diagnostics: sanitised HTTP exchange history attached to Allure.
- Retries in CI: one retry; local: zero.

## What is intentionally not tested

- No assumption that the sandbox enforces uniqueness, authentication or locking.
- No invented version fields or idempotency keys.
- No distributed token lock across workers or jobs.
- No destructive operations on records the test did not create.

## Running

```bash
npm run test:unit                 # offline, fastest feedback
npm run test:mock                 # enterprise + core, hermetic
npm run test:core                 # same core suite on the configured target
npm run test:prod                 # real prod + sandbox observations
npm run test:smoke                # cross-project smoke selection
npm run test:concurrency          # race test only
```
