# Interview preparation

## 60-second walkthrough

"This is a Playwright + TypeScript API framework for the restful-booker booking lifecycle. It has four tiers: offline unit tests, deterministic enterprise contracts on a local mock, a core suite that runs on mock or real, and sandbox-observation tests that document the public host's quirks. Requests go through a small transport that owns retries and sanitised diagnostics; authentication is a token manager with caching, a TTL refresh threshold and single-flight refresh. Every response is validated with Zod, and every booking is created with unique data and cleaned up by ID. CI runs hermetic suites on PRs and the real sandbox nightly behind an environment approval gate."

## Why a mock?

The public sandbox is permissive: no auth enforcement, no overlap rule, no ETags, `500` for invalid payloads. If I asserted enterprise contracts there, they would fail or pass for the wrong reason. The mock makes those contracts deterministic and fast, and the sandbox observations keep the real behaviour documented rather than hidden.

The mock is not a product; it lives under `src/mock`, is started only in `API_MODE=mock`, and its control plane is admin-key protected.

## Why Zod instead of hand-written interfaces?

Interfaces vanish at runtime. Zod validates untrusted JSON and `z.infer` derives the TypeScript types from the same declaration, so compile-time and runtime cannot drift. The error path is also better: `SchemaValidationError` includes issue paths.

## Why not Axios / fetch?

Playwright is already the runner and provides `APIRequestContext` with per-context cookies, timeouts, tracing integration and no extra dependency. A custom transport adds only retry policy, typed errors and redacted history.

## Authentication details

- restful-booker returns HTTP 200 for bad credentials. The success signal is a non-empty token, not the status code. The auth schema is a union for exactly this reason.
- No expiry field exists. `TOKEN_TTL_MS` is a local refresh threshold measured from acquisition; no `exp` is invented.
- A 401 is repairable: invalidate, refresh, replay once. A 403 is not: it throws `ForbiddenError` and never refreshes.
- Single-flight: concurrent callers share the in-progress promise. A rejected refresh clears both the promise and the cached token.
- The lock is per process/worker. Cross-worker coordination is unnecessary at this scale and would add complexity; the limitation is documented.

## Retry safety

- GET/PUT/PATCH/DELETE are replay-safe by HTTP semantics.
- POST is retried only when the server explicitly returned a retryable status (408/425/429/5xx). An ambiguous network failure is not replayed because the write may have succeeded.
- The transport returns the final server response when the budget is exhausted, so tests assert real status codes instead of a synthetic timeout.

## Idempotency

Repeated identical PUTs converge on the same state. The test sends the same payload three times, re-reads after each, and checks no extra records exist. It does not assert version stability because the sandbox exposes no version.

## Concurrency

Two conflicting PATCHes are released through an `N`-party barrier and dispatched in one microtask batch. The test records start/finish times and statuses, then checks the final record is internally consistent with one contender. It explicitly avoids claiming a shared millisecond. Last-write-wins is the observed behaviour; the mock does not add locking to plain PATCH.

## Test-data strategy

Names contain run id + worker + sequence, so leaked data is attributable and filter assertions are not polluted. Dates are relative to today. Default room/date windows differ per worker and sequence; overlap tests pass the same room/dates explicitly.

## Cleanup

The fixture tracks only IDs created by the current test. Teardown runs even on failure and deletes best-effort. Explicit deletes untrack first, so the suite does not issue a second delete. Other actors' records are never touched.

## Sandbox quirks worth mentioning

- `/ping` -> 201, not 200.
- Bad credentials -> 200 with `{ reason }`.
- POST -> 200; DELETE -> 201.
- `roomid` silently dropped.
- Missing fields -> 500.
- Unknown id on DELETE/PUT/PATCH -> 405.
- `depositpaid` filter ignored.
- `checkin`/`checkout` filters are not reliable exact matches; the core suite avoids depending on them.

These are in `tests/sandbox-behaviour` and the README table, not buried in comments.

## CI/CD

- Quality job: lint, Prettier check, typecheck.
- Mock job on push/PR: unit + enterprise + core.
- Nightly real job behind the `prod` Environment approval rule.
- Manual dispatch supports mode, environment, workers and a grep filter.
- Allure reports and failure diagnostics uploaded as artifacts.
- Node 24 only; Allure 3 needs no Java.

## Tradeoffs I would defend

- Mock complexity vs deterministic enterprise coverage: worth it because the sandbox cannot demonstrate the rules the assessment asks about.
- No cross-worker token lock: each worker authenticates once per TTL; a distributed lock would add failure modes without meaningful benefit.
- HTTP history capped at 50: enough for failure diagnosis without unbounded memory.
- Logs are JSON lines: greppable in CI, at the cost of human-friendly local output.

## Things I would add next

- Contract tests generated from an OpenAPI spec if one existed.
- A Postman/Newman parity collection only if the team requires it.
- Allure TestOps or GitHub Pages publishing for report history.
- Optional per-worker sharding metrics to tune `WORKERS`.
- Chaos injection (delays, dropped connections) in the mock to exercise retry paths end-to-end.

## Demo path

1. `npm run test:unit` - show fast, offline verification.
2. `npm run test:mock` - show 401/403/409/412 and lifecycle together.
3. `API_MODE=real API_ENV=prod npm run test:prod` - show the same core suite on the live host plus quarantine observations.
4. `npm run allure:generate && npm run allure:open` - show environment metadata, steps and the attached HTTP exchanges on failure.
5. Break one assertion intentionally to show the diagnostic attachment, then revert.
