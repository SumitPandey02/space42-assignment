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
npm run test:api        # core + sandbox-behaviour
npm run allure:generate
npm run allure:open
```

## Configuration

Configuration is resolved once in `config/environment.ts` with this precedence:

1. process environment (CI inputs, repository/environment variables, secrets)
2. local `.env` (git-ignored)
3. the named profile in `config/environments.ts`
4. built-in defaults

| Variable                        | Default              | Notes                                               |
| ------------------------------- | -------------------- | --------------------------------------------------- |
| `API_ENV`                       | `prod`               | `sandbox`, `uat`, `prod`                            |
| `BASE_URL`                      | profile              | Required for `sandbox`/`uat`                        |
| `API_USERNAME` / `API_PASSWORD` | public sandbox creds | Required together for non-prod targets              |
| `WORKERS`                       | `4`                  | Capped by the profile                               |
| `REQUEST_TIMEOUT_MS`            | `15000`              | Per-request timeout                                 |
| `TOKEN_TTL_MS`                  | `600000`             | Local refresh threshold (the API exposes no expiry) |
| `LOG_LEVEL`                     | `info`               | `debug`/`info`/`warn`/`error`/`silent`              |
| `RUN_BEHAVIOUR_TESTS`           | auto                 | Enables sandbox observations outside `prod`         |

Copy `.env.example` to `.env` for local overrides. Secrets are never committed.

The assessment target is registered as `prod` because it is the only concrete host supplied. `sandbox` and `uat` are reserved names for dedicated environments; their empty base URLs force an explicit `BASE_URL` rather than silently hitting the wrong host.

## Test projects and tags

| Project             | Contents                                                                                  | Target                               |
| ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------ |
| `core`              | Auth, lifecycle, adaptive contracts, idempotency, PATCH, filters, concurrency, resilience | Any real host                        |
| `sandbox-behaviour` | Quirks unique to the public sandbox                                                       | Auto-skipped unless `prod` is public |

Tags: `@core`, `@sandbox-behaviour`, `@smoke`, `@concurrency`.

```bash
npm test                  # both projects
npm run test:core
npm run test:behaviour
npm run test:api          # core + behaviour
npm run test:smoke
npm run test:concurrency
npm run test:sandbox      # future dedicated environment
npm run test:uat
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

`tests/sandbox-behaviour` documents the rest of the public host's quirks: `ping` returns 201, auth failures return HTTP 200 without a token, `roomid` is dropped, DELETE returns 201, non-numeric ids return 404, and `depositpaid` filtering is ignored.

## Architecture

```text
config/            env resolution + named profiles
src/contracts/     Zod schemas (runtime validation + inferred types)
src/models/        domain projections/normalisation
src/clients/       HttpTransport, AuthClient, BookingClient
src/auth/          TokenManager (cache, TTL, single-flight, invalidation)
src/builders/      BookingFactory (unique data, relative dates)
src/fixtures/      Playwright fixtures + cleanup tracker
src/utils/         errors, retry, barrier, dates, logger, sanitizer
src/reporting/     Allure environment/executor metadata
tests/             core (auth, booking, contracts, resilience) and sandbox observations
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
npm run test:api
npm run allure:generate   # ./allure-results -> ./allure-report
npm run allure:open
npm run allure:serve
```

Each run writes `environment.properties` (target, environment, workers, run id, Node) and, in CI, `executor.json`.

## CI/CD

`.github/workflows/api-tests.yml`:

- **quality** — lint, Prettier check and typecheck on every push/PR
- **sandbox** — `@smoke` on pushes and PRs with 2 workers; full core + behaviour nightly at `06:00 UTC` or on manual dispatch; Allure and failure diagnostics uploaded
- **real-other** — manual dispatch against a dedicated `sandbox`/`uat` host using `vars.BASE_URL` / `vars.UAT_BASE_URL` and scoped secrets

The public sandbox needs no secrets or approval gate because its credentials are published demo values. Dedicated environments should use environment-scoped secrets.

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
