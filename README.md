# Space42 API Automation

Enterprise-grade API test automation for the [restful-booker](https://restful-booker.herokuapp.com) booking lifecycle, built with **Playwright Test**, **TypeScript**, **Zod** and **Allure 3**.

The framework runs the same core suite against two very different targets:

| Mode             | Target                                                 | Purpose                                                                             |
| ---------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `mock` (default) | Deterministic in-process enterprise API on `127.0.0.1` | Fast, hermetic verification of 401/403/409/412, strict validation and overlap rules |
| `real`           | Named environment (`sandbox`, `uat`, `prod`)           | Lifecycle, idempotency, concurrency and resilience against a live host              |

`prod` is the public restful-booker sandbox; `sandbox`/`uat` are placeholders that require `BASE_URL` at runtime. See [docs/architecture.md](docs/architecture.md) for why.

## Requirements

- Node.js **24.x** (`.nvmrc` pins 24; CI runs 24 only)
- npm 11+

No Java is required: Allure 3 is a pure Node CLI.

## Quick start

```bash
npm ci
npm run test:mock        # enterprise + core against the local mock (run test:unit for offline checks)
npm run allure:generate
npm run allure:open      # opens ./allure-report
```

Against the live public sandbox:

```bash
API_MODE=real API_ENV=prod WORKERS=2 npm run test:prod
```

## Configuration

Configuration is resolved once in `config/environment.ts` with this precedence:

1. process environment (CI inputs, repository/environment variables, secrets)
2. local `.env` (git-ignored)
3. the named profile in `config/environments.ts`
4. built-in defaults

| Variable                        | Default              | Notes                                              |
| ------------------------------- | -------------------- | -------------------------------------------------- |
| `API_MODE`                      | `mock`               | `mock` or `real`                                   |
| `API_ENV`                       | `sandbox`            | `sandbox`, `uat`, `prod`                           |
| `BASE_URL`                      | profile              | Required for `real` + `sandbox`/`uat`              |
| `API_USERNAME` / `API_PASSWORD` | public sandbox creds | Required together for non-prod real targets        |
| `WORKERS`                       | `4`                  | Capped by the profile (mock ceiling 16)            |
| `REQUEST_TIMEOUT_MS`            | `15000`              | Per-request timeout                                |
| `TOKEN_TTL_MS`                  | `600000`             | Refresh threshold (the API exposes no expiry)      |
| `LOG_LEVEL`                     | `info`               | `debug`/`info`/`warn`/`error`/`silent`             |
| `MOCK_PORT`                     | `4010`               | Mock listen port                                   |
| `MOCK_ADMIN_KEY`                | `mock-admin`         | Guards `/__admin/*`; never used against real hosts |

Copy `.env.example` to `.env` for local overrides. Secrets are never committed.

## Test projects and tags

Playwright projects are behaviour-oriented:

| Project             | Contents                                                                         | Runs on                            |
| ------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| `unit`              | Pure utilities, schemas, retry, token manager, transport                         | No network                         |
| `enterprise`        | 401/403/409/412, strict validation                                               | Mock only (auto-skipped otherwise) |
| `core`              | Auth lifecycle, CRUD, idempotency, PATCH drift, filters, concurrency, resilience | Mock or real                       |
| `sandbox-behaviour` | Documented quirks of the public sandbox                                          | Real `prod` only                   |

Tags mirror the same split: `@unit`, `@enterprise`, `@core`, `@sandbox-behaviour`, plus `@smoke` and `@concurrency`.

```bash
npm test                  # every project
npm run test:unit
npm run test:enterprise
npm run test:core
npm run test:behaviour    # real sandbox only
npm run test:mock         # enterprise + core, mock
npm run test:prod         # core + behaviour, real prod
npm run test:smoke
npm run test:concurrency
```

## Architecture

```text
config/            env resolution + named profiles
src/contracts/     Zod schemas (single source of truth for runtime + types)
src/models/        domain types derived from schemas, normalisation
src/clients/       HttpTransport, AuthClient, BookingClient, MockControlClient
src/auth/          TokenManager (cache, TTL, single-flight, invalidation)
src/builders/      BookingFactory (unique data, relative dates)
src/fixtures/      Playwright fixtures + cleanup tracker
src/mock/          deterministic enterprise mock (standalone + in-process)
src/utils/         errors, retry, barrier, dates, logger, sanitizer
src/reporting/     Allure environment/executor metadata
tests/             unit, enterprise, auth, booking, resilience, sandbox-behaviour
```

Request path:

```text
test -> fixture -> BookingClient -> HttpTransport -> Playwright APIRequestContext
                              \-> TokenManager -> AuthClient -> HttpTransport
```

Key properties:

- **Contract-first.** Response bodies are parsed by Zod; `z.infer` produces the TypeScript types, so runtime and compile-time never drift.
- **Retry safety.** GET/PUT/PATCH/DELETE are replay-safe. POST is retried only when the server returned a retryable status; an ambiguous POST network failure is never replayed.
- **Auth lifecycle.** Tokens are cached per worker, refreshed after a configurable TTL, and on a 401 the client invalidates, performs a single-flight refresh and replays once. A 403 is never treated as an auth problem.
- **Isolation and cleanup.** Every booking is created with a run/worker/sequence-unique name and tracked by ID; teardown deletes only tracked IDs, best-effort, even after failures.
- **Safe diagnostics.** Logs and Allure attachments pass through a deep redactor that removes tokens, cookies, passwords and authorization headers.

More detail: [architecture](docs/architecture.md) and [test strategy](docs/test-strategy.md).

## Allure 3

```bash
npm run test:mock
npm run allure:generate   # ./allure-results -> ./allure-report
npm run allure:open
npm run allure:serve
```

Each run writes `environment.properties` (target, mode, workers, run id, Node) and, in CI, `executor.json`. Failed tests attach the sanitised HTTP exchange history under `http-exchanges`.

## CI/CD

`.github/workflows/api-tests.yml`:

- **quality** - lint, Prettier check, typecheck on every push/PR
- **mock** - unit + enterprise + core on pushes, PRs and manual mock runs
- **real-prod** - nightly at `06:00 UTC` or manual dispatch; guarded by the GitHub Environment `prod` (configure a required reviewer)
- **real-other** - manual real runs against `sandbox`/`uat` with `vars.BASE_URL` / `vars.UAT_BASE_URL`

Set these in the repository:

| Kind        | Name                           | Purpose                                                                                      |
| ----------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| Environment | `prod`                         | Approval gate for the public sandbox job                                                     |
| Secret      | `API_USERNAME`, `API_PASSWORD` | Environment-scoped credentials; empty values fall back to public sandbox defaults for `prod` |
| Variable    | `BASE_URL`                     | sandbox/uat base URL                                                                         |
| Variable    | `UAT_BASE_URL`                 | optional uat override                                                                        |
| Input       | `workers`                      | `1`, `2`, `4` or `8` on manual runs                                                          |

Allure reports and raw results are uploaded as artifacts; failed runs also upload `test-results` traces.

## Verified API behaviour

The framework encodes what the host actually does, not what a textbook API should do:

| Scenario                       | Public sandbox                        | Mock                       |
| ------------------------------ | ------------------------------------- | -------------------------- |
| `GET /ping`                    | `201 Created`                         | `201 Created`              |
| Bad credentials                | `200 { "reason": "Bad credentials" }` | same                       |
| Token expiry field             | none                                  | none (TTL tracked locally) |
| `POST /booking`                | `200`                                 | `201`                      |
| `DELETE /booking/:id`          | `201 Created`                         | `204`                      |
| Missing id on DELETE/PUT/PATCH | `405`                                 | `404`                      |
| Auth enforced on writes        | no                                    | yes (401/403)              |
| Overlapping same-room stays    | allowed                               | `409`                      |
| `roomid` on write              | silently dropped                      | honoured                   |
| `depositpaid` filter           | ignored                               | honoured                   |
| Missing required fields        | `500`                                 | `400` with details         |
| ETag / `If-Match`              | absent                                | present, stale = `412`     |

Because the sandbox allows unauthenticated writes, overlap and optimistic-locking behaviour is verified against the mock, while `tests/sandbox-behaviour` records the real quirks separately. Unit tests run with no network at all.

## Limitations and deliberate choices

- The in-memory token lock coordinates one runtime (one Playwright worker), not multiple processes. Each worker authenticates once per TTL window; no cross-process lock is needed at this scale.
- Token expiry is inferred from acquisition time because the API does not expose one. No `exp` field is invented.
- The mock is a test double, clearly isolated under `/__admin/*` and documented as such; it is not a production service.
- Date filters (`checkin`/`checkout`) on the public host do not behave as exact matches and are therefore not asserted in the core suite. The observed `depositpaid` filter is ignored and documented as a sandbox observation.
- `prod` is the only concrete host supplied by the assessment; the naming oddity is intentional and explained in `config/environments.ts`.
