# Space42 API Automation

API test automation for the [restful-booker](https://restful-booker.herokuapp.com) booking lifecycle, built with **Playwright Test**, **TypeScript**, **Zod** and **Allure 3**.

The suite runs against the real, shared sandbox. It covers the booking lifecycle, authentication lifecycle, idempotency, PATCH drift, concurrency, sandbox resilience, and host-contract capabilities that differ between permissive sandboxes and enterprise deployments.

## Requirements

- Node.js **24.x** (`.nvmrc` pins 24; CI runs 24 only)
- npm 11+

No Java is required: Allure 3 is a pure Node CLI.

## Quick start

```bash
npm ci
npm run test:smoke      # fast @smoke path against the public sandbox
npm test                # full core suite
npm run allure:generate
npm run allure:open
```

## Configuration

Configuration is resolved once in `config/environment.ts` with this precedence:

1. process environment (CI inputs, repository/environment variables, secrets)
2. local `.env` (git-ignored)
3. built-in defaults

| Variable                        | Default              | Notes                                               |
| ------------------------------- | -------------------- | --------------------------------------------------- |
| `BASE_URL`                      | public sandbox URL   | Optional target override                            |
| `API_USERNAME` / `API_PASSWORD` | public sandbox creds | Must be provided together                           |
| `WORKERS`                       | `4`                  | Capped at 4 to stay polite on the shared host       |
| `REQUEST_TIMEOUT_MS`            | `15000`              | Per-request timeout                                 |
| `TOKEN_TTL_MS`                  | `600000`             | Local refresh threshold (the API exposes no expiry) |
| `LOG_LEVEL`                     | `info`               | `debug`/`info`/`warn`/`error`/`silent`              |

Copy `.env.example` to `.env` for local overrides. Secrets are never committed.

## Test project and tags

| Project | Contents                                                                       | Target        |
| ------- | ------------------------------------------------------------------------------ | ------------- |
| `core`  | Auth, lifecycle, adaptive contracts, idempotency, PATCH, concurrency, recovery | Any real host |

Tags: `@core`, `@smoke`, `@concurrency`.

```bash
npm test
npm run test:core
npm run test:api          # alias for the core project
npm run test:smoke
npm run test:concurrency
```

## Adaptive host-contract tests

`tests/contracts/host-capabilities.spec.ts` accepts both legitimate host behaviours and records the observed one in Allure:

| Scenario                     | Accepted outcomes                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Unauthenticated write        | Rejected 401/403, or accepted and readable                                              |
| Duplicate room/date stay     | Rejected 400/409/422 with no phantom record, or accepted with two distinct IDs          |
| `ETag` / `If-Match`          | Enforced (stale → 412, current → 200 with a new ETag), absent, or present but ignored   |
| Invalid payload / unknown id | Missing fields 400/422/500, malformed JSON 400, unknown GET 404, unknown DELETE 404/405 |

Any other status fails. This keeps the tests honest on a host that does not enforce enterprise rules, while automatically tightening when a future target does.

## Architecture

```text
config/            environment resolution (BASE_URL + optional credentials)
src/contracts/     Zod schemas (runtime validation + inferred types)
src/models/        domain projections/normalisation
src/clients/       HttpTransport, AuthClient, BookingClient
src/auth/          TokenManager (cache, TTL, single-flight, invalidation)
src/builders/      BookingFactory (unique data, relative dates)
src/fixtures/      Playwright fixtures + cleanup tracker
src/utils/         errors, retry, dates, logger, sanitizer
src/reporting/     Allure environment/executor metadata
tests/             auth, booking, contracts, resilience
```

Request path:

```text
test -> fixture -> BookingClient -> HttpTransport -> Playwright APIRequestContext
                              \-> TokenManager -> AuthClient -> HttpTransport
```

Key properties:

- **Contract-first.** Response bodies are parsed by Zod; `z.infer` produces the TypeScript types, so runtime and compile-time cannot drift.
- **Retry safety.** GET/PUT/PATCH/DELETE are replay-safe. POST is retried only when the server returned a retryable status; an ambiguous POST network failure is never replayed.
- **Auth lifecycle.** Tokens are cached per worker, refreshed after a configurable TTL, and on a 401 the client invalidates, performs a single-flight refresh and replays once. A 403 is never treated as an auth problem.
- **Isolation and cleanup.** Every booking is created with a run/worker/sequence-unique name and tracked by ID; teardown deletes only tracked IDs, best-effort, even after failures.
- **Safe diagnostics.** Logs and Allure attachments pass through a deep redactor that removes tokens, cookies, passwords and authorization headers. Failed tests attach the sanitised HTTP exchange history.

More detail: [architecture](docs/architecture.md) and [test strategy](docs/test-strategy.md).

## Why there is no mock or unit tier

The public sandbox cannot demonstrate authentication enforcement, overlap rejection or optimistic locking: it accepts unauthenticated writes, allows duplicate stays, exposes only an unenforced infrastructure ETag, and returns `500` for missing fields. A local enterprise mock was prototyped and removed on purpose, because:

- the brief asks for a test pipeline, not a test double;
- maintaining a second API doubles the surface area without exercising the real host;
- the adaptive contract tests already record both outcomes and become strict automatically if the target starts enforcing them.

If an enterprise target is added later, a contract double can be reintroduced under `tests/support` without changing the clients. It would cover 401 refresh/replay, 403, 409 overlap, 412 preconditions and strict validation — the paths this sandbox cannot trigger. Until then, the token-refresh and overlap-rejection logic is implemented defensively but unverified against this host, and that limitation is stated rather than hidden.

## Allure 3

```bash
npm run clean:allure      # remove stale raw results and previous report
npm test
npm run allure:generate   # ./allure-results -> ./allure-report
npm run allure:open
npm run allure:serve
```

`allure:generate --clean` cleans only the report output. Run `clean:allure` first when you want a report that contains only the latest test run.

Each run writes `environment.properties` (target, workers, run id, Node) and, in CI, `executor.json`.

## CI/CD

`.github/workflows/api-tests.yml`:

- **quality** — lint, Prettier check and typecheck on every push/PR
- **sandbox** — `@smoke` on pushes and PRs with 2 workers; full core suite nightly at `06:00 UTC` or on manual dispatch; Allure and failure diagnostics uploaded

The public sandbox needs no secrets or approval gate because its credentials are published demo values.

## Verified API behaviour

| Scenario                       | Public sandbox                        |
| ------------------------------ | ------------------------------------- |
| `GET /ping`                    | `201 Created`                         |
| Bad credentials                | `200 { "reason": "Bad credentials" }` |
| Token expiry field             | none                                  |
| `POST /booking`                | `200`                                 |
| `DELETE /booking/:id`          | `201 Created`                         |
| Unknown id on DELETE/PUT/PATCH | `405`                                 |
| Auth enforced on writes        | no                                    |
| Overlapping same-room stays    | allowed                               |
| `roomid` on write              | silently dropped                      |
| `depositpaid` filter           | ignored                               |
| Missing required fields        | `500`                                 |
| ETag / `If-Match`              | weak ETag, `If-Match` ignored         |

## Limitations

- Token expiry is inferred from acquisition time because the API does not expose one. No `exp` field is invented.
- 401 refresh/replay, 403 handling, 409 overlap rejection and 412 preconditions cannot be triggered on this host; the adaptive contracts record the sandbox's actual behaviour and the logic remains defensive.
- Date filters (`checkin`/`checkout`) on the public host are not reliable exact matches and are not used for assertions.
- The token lock is per Playwright worker, not cross-process; each worker authenticates once per TTL window.
