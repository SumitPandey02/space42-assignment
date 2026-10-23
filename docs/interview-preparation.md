# Interview preparation

## 60-second walkthrough

"This is a Playwright + TypeScript API framework for the restful-booker booking lifecycle. It has two tiers: a core suite for auth, lifecycle, idempotency, PATCH drift, concurrency, resilience and adaptive host contracts; and a sandbox-behaviour suite that records the public host's quirks. Requests go through a small transport that owns retries and sanitised diagnostics; authentication is a token manager with caching, a TTL refresh threshold and single-flight refresh. Every response is validated with Zod, and every booking is created with unique data and cleaned up by ID. CI runs a smoke path on PRs and the full suite nightly."

## Why no mock or unit tier?

I prototyped both and removed them deliberately:

- The brief asks for a resilient pipeline against the host, not a second API implementation.
- The public sandbox cannot demonstrate 401/403/409/412, so a mock would show rules the target does not have. Maintaining it would double the surface area for little assessment value.
- Instead, `tests/contracts/host-capabilities.spec.ts` accepts both legitimate outcomes, records what actually happened in Allure, and fails on anything unexpected. If the target starts enforcing enterprise rules, the tests tighten automatically.
- Unit tests for date maths, token TTL and retry backoff were useful during development, but integration coverage plus the adaptive contracts is enough for this brief.

The tradeoff: the 401 refresh/replay path is implemented but cannot be triggered by this host. I state that openly rather than pretending it is covered.

## Why Zod instead of hand-written interfaces?

Interfaces vanish at runtime. Zod validates untrusted JSON and `z.infer` derives the TypeScript types from the same declaration, so compile-time and runtime cannot drift. `SchemaValidationError` includes issue paths.

## Authentication details

- restful-booker returns HTTP 200 for bad credentials. The success signal is a non-empty token, not the status code. The auth schema is a union for exactly this reason.
- There is no refresh token and no expiry field. `TOKEN_TTL_MS` is a local re-authentication threshold measured from acquisition; no `exp` is invented.
- A 401 is repairable: invalidate, refresh, replay once. A 403 is not: it throws `ForbiddenError` and never refreshes.
- Single-flight: concurrent callers share the in-progress promise. A rejected refresh clears both the promise and the cached token.
- The lock is per worker. Cross-worker coordination is unnecessary at this scale and would add complexity.

## Retry safety

- GET/PUT/PATCH/DELETE are replay-safe.
- POST is retried only when the server explicitly returned a retryable status. An ambiguous network failure is not replayed because the write may have succeeded.
- On exhaustion the transport returns the final server response, so tests assert real status codes.

## Idempotency

Repeated identical PUTs converge on the same state. The test sends the same payload three times, re-reads after each, and checks no extra records exist. It does not assert version stability because the host exposes no version.

## Concurrency

Two conflicting PATCHes are released through an `N`-party barrier and dispatched in one microtask batch. The test records start/finish times, statuses and bodies, then checks the final record is internally consistent with one contender. It avoids claiming a shared millisecond. Last-write-wins is the observed behaviour.

## Adaptive contracts

The key design decision: do not assert sandbox behaviour as if it were enterprise behaviour.

- Unauthenticated write: either rejected 401/403, or accepted with a readable booking.
- Duplicate stay: either rejected 400/409/422 with no phantom record, or accepted with two distinct IDs.
- ETag: either enforced (412 on stale, 200 + new ETag on current), absent, or present but ignored (as on the sandbox, where it is an infrastructure header).
- Invalid inputs: explicit allowed status sets; unknown ids must be not-found.

The observed outcome is attached to Allure, which makes the report explain the host rather than hide it.

## Test-data strategy

Names contain run id + worker + sequence, so leaked data is attributable and filter assertions are not polluted. Dates are relative to today. Default room/date windows differ per worker; overlap tests pass the same room/dates explicitly.

## Cleanup

Only IDs created by the current test are tracked. Teardown runs even on failure and deletes best-effort. Explicit deletes untrack first. Other actors' records are never touched.

## Sandbox quirks worth mentioning

- `/ping` -> 201.
- Bad credentials -> 200 with `{ reason }`.
- POST -> 200; DELETE -> 201.
- `roomid` silently dropped.
- Missing fields -> 500.
- Unknown id on DELETE/PUT/PATCH -> 405.
- `depositpaid` filter ignored.
- ETag header present but not enforced.
- `checkin`/`checkout` filters are not reliable exact matches.

## CI/CD

- Quality job: lint, Prettier check, typecheck.
- Sandbox job: `@smoke` on push/PR with 2 workers; full core + behaviour nightly with 4.
- Manual dispatch supports `sandbox`/`uat` with `BASE_URL` and scoped secrets.
- Allure reports and failure diagnostics uploaded as artifacts.
- Node 24 only; Allure 3 needs no Java.

## Tradeoffs I would defend

- No mock: tests the real host; adaptive contracts capture capability differences honestly.
- No unit tier: avoids maintaining tests for internals the integration suite already exercises.
- No cross-worker token lock: one authentication per worker per TTL is cheap.
- HTTP history capped at 50: enough diagnosis, bounded memory.
- Public sandbox defaults for `prod`: they are published demo values, not secrets.

## Things I would add next

- A contract double only if a real enterprise target is added, covering 401/403/409/412.
- Contract tests generated from an OpenAPI spec if one existed.
- Allure report publishing for history/trends.
- Chaos injection at the transport boundary for retry-path verification.

## Demo path

1. `npm run test:smoke` - auth and full booking lifecycle.
2. `npm run test:api` - core + adaptive contracts + sandbox observations.
3. Open Allure and show the `auth-capability`, `overlap-capability`, `etag-capability` attachments.
4. Break one assertion intentionally to show the sanitised HTTP history attachment, then revert.
