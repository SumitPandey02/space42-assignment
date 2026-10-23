# Test strategy

## Two-tier model

| Tier                 | Purpose                                                                                                            | Target                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `@core`              | Behaviour that must hold on any host: auth, lifecycle, idempotency, PATCH, concurrency, resilience, host contracts | Real host                |
| `@sandbox-behaviour` | Quirks unique to the public sandbox                                                                                | Real public sandbox only |

There is no offline unit tier and no mock. The brief asks for a test pipeline against the host; a local double was prototyped and removed to avoid maintaining a second API. What would have been unit-tested is either observable in the integration suite or documented as unobservable.

## Coverage by concern

### Authentication

- Valid credentials produce a token; bad credentials produce `{ reason }` with no token and HTTP 200.
- A write succeeds with the managed token.
- Tokens are cached and reused across tests in the same worker.
- The manager refreshes after its TTL threshold, invalidates on a 401, refreshes single-flight, and leaves no stale token after a failed refresh.
- 401 replay and 403 handling are implemented defensively but cannot be triggered on this host; the adaptive auth contract records that authentication is not enforced for writes.

### Booking lifecycle

Create -> read -> PUT replace -> PATCH merge -> delete -> verify gone. Every step validates the body with Zod and compares normalised state, so extra/missing fields are caught.

Post-deletion status is context-sensitive: hosts differ between 403, 404 and 405. Tests accept only "not found" semantics and never invent a resource version.

### Adaptive host contracts

Each contract accepts the legitimate outcome set and records the observed one:

- **Authentication:** rejected with 401/403, or accepted. If accepted, the booking must be readable; if rejected, no record may be found by its unique name.
- **Overlap:** rejected with 400/409/422 and no phantom record, or accepted with two distinct IDs that both exist.
- **Optimistic locking:** ETag enforced -> stale `If-Match` is 412 and the record is unchanged, current `If-Match` is 200 with a new ETag; ETag absent or unenforced -> `If-Match` is ignored and the update succeeds.
- **Validation:** missing fields -> 400/422/500, malformed JSON -> 400, unknown GET -> 404, unknown DELETE -> 404/405.

Any other status fails. The attached `*-capability` artifacts explain what the host did.

### Idempotency and retry safety

- The same complete PUT is sent three times; each response and persisted state must match.
- PATCH changes only `totalprice`; names, dates, deposit flag and additional needs are asserted unchanged.
- The transport retries only replay-safe operations and retryable statuses. POST is never replayed after an ambiguous network failure.
- Retry exhaustion returns the final server response when one exists.

### Concurrency

Two conflicting PATCHes are released through an `N`-party barrier and dispatched in one microtask batch. The test records per-request status, start/finish times and response bodies, then asserts:

- both writes succeed;
- the final record is internally consistent with exactly one contender;
- the dispatch delta is bounded.

It does not claim a shared millisecond. Last-write-wins is the observed outcome on this host.

### Resilience

- A booking deleted by another actor is treated as gone, not as a framework failure.
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

## Flake controls

- `fullyParallel: true`; worker count from `WORKERS`, capped by the profile.
- No sleeps for synchronisation; the barrier coordinates dispatch.
- Retryable statuses use bounded exponential backoff with jitter.
- Real-host POST create retries on explicit 5xx responses, never on ambiguous transport failures.
- Token refresh is single-flight.
- Failure-only diagnostics: sanitised HTTP exchange history attached to Allure.
- CI retries: one retry for smoke/full runs; local: zero.

## Known host deviations (documented, not assumed)

- `ping` returns 201.
- Bad credentials return 200 without a token.
- `POST /booking` returns 200; DELETE returns 201.
- `roomid` is silently dropped.
- Missing fields return 500.
- Unknown ids return 405 on DELETE/PUT/PATCH.
- `depositpaid` filtering is ignored.
- `checkin`/`checkout` filters are not reliable exact matches; the core suite avoids depending on them.

## What is intentionally not tested

- No assumption that the sandbox enforces uniqueness, authentication or locking.
- No invented version fields or idempotency keys.
- No distributed token lock across workers or jobs.
- No destructive operations on records the test did not create.
- No mock or unit tier; see README for the rationale.

## Running

```bash
npm run test:smoke        # fast @smoke path
npm run test:core         # all core specs
npm run test:behaviour    # public sandbox observations
npm run test:api          # core + behaviour
npm run test:concurrency  # race test only
```
