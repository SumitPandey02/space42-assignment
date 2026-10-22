# Assessment mapping

| Requirement                                         | Implementation                                                       | Evidence                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Playwright + TypeScript API framework               | `playwright.config.ts`, `tsconfig.json`, `src/clients/*`             | `npm run typecheck`, `npm test`                            |
| Playwright `APIRequestContext` (no Axios)           | `src/clients/http-client.ts`                                         | transport unit tests                                       |
| Configurable base URL                               | `config/environment.ts`, `config/environments.ts`                    | `BASE_URL`, `API_ENV`                                      |
| Environment-specific settings, no hardcoded secrets | profiles + env precedence, `.env.example`, CI secrets                | `resolveEnvironment`                                       |
| Worker count configurable                           | `WORKERS`, profile ceilings                                          | `playwright.config.ts`                                     |
| Allure reporting                                    | `allure-playwright`, `allurerc.mjs`, `src/reporting/global-setup.ts` | `npm run allure:generate`                                  |
| Diagnostics on failure                              | sanitised HTTP history attached in `src/fixtures/api.fixture.ts`     | failed-test attachment                                     |
| Typed clients for auth and bookings                 | `AuthClient`, `BookingClient`                                        | client methods                                             |
| Zod runtime validation                              | `src/contracts/*.schema.ts`                                          | `tests/unit/contracts.spec.ts`                             |
| Dynamic token generation                            | `AuthClient.fetchToken`                                              | `tests/auth/authentication.spec.ts`                        |
| Token caching + upload refresh threshold            | `TokenManager` TTL from acquisition                                  | `tests/unit/token-manager.spec.ts`                         |
| 401 invalidation, refresh, safe retry               | `BookingClient.authorizedSend`                                       | enterprise authorization spec                              |
| 403 handled separately                              | `ForbiddenError`, no refresh on 403                                  | enterprise authorization spec                              |
| Single-flight refresh                               | `TokenManager.refresh`                                               | unit single-flight test                                    |
| Refresh failure leaves no stale token               | `TokenManager.acquire` catch path                                    | unit failure test                                          |
| Avoid refreshing per test                           | worker-scoped manager + cache                                        | cache reuse tests                                          |
| Mirrored / controlled auth failures                 | mock token expiry + admin endpoint                                   | 401 mid-suite test                                         |
| Health check                                        | `BookingClient.ping`                                                 | lifecycle + sandbox ping test                              |
| Create/read/PUT/PATCH/delete lifecycle              | `tests/booking/booking-lifecycle.spec.ts`                            | `@smoke` lifecycle                                         |
| Schema/structure validation                         | Zod parse on every response                                          | lifecycle, contracts                                       |
| Date invariants, no hardcoded dates                 | `date-utils.ts`, `BookingFactory`                                    | date unit tests, factory tests                             |
| Overlap scenario                                    | mock `409`, sandbox observation                                      | `tests/enterprise/conflicts.spec.ts`, sandbox overlap test |
| Actual status recorded, no assumed 409              | mode-aware assertions                                                | sandbox observations                                       |
| Repeated PUT (3x)                                   | `booking-idempotency.spec.ts`                                        | state convergence                                          |
| PATCH drift                                         | `booking-patch.spec.ts`                                              | preserved fields                                           |
| Reusable retry utility                              | `src/utils/retry.ts`                                                 | retry unit tests                                           |
| Bounded exponential backoff + jitter                | `computeBackoffDelay`                                                | retry unit tests                                           |
| No unsafe POST retry                                | transport `REPLAY_SAFE_METHODS`                                      | transport unit tests                                       |
| Concurrency barrier + conflicting writes            | `src/utils/barrier.ts`, `booking-concurrency.spec.ts`                | `@concurrency`                                             |
| Record timings/statuses/outcome                     | attached `concurrency-observations`                                  | Allure attachment                                          |
| No false millisecond claims                         | documented + measured delta                                          | concurrency spec                                           |
| Unique test data                                    | `BookingFactory`                                                     | factory tests                                              |
| Safe cleanup in finally                             | auto cleanup fixture                                                 | resilience tests                                           |
| Context-sensitive 404/403/405                       | lifecycle, resilience, sandbox observations                          | post-deletion assertions                                   |
| Bounded recovery + clear diagnostics                | `retry` + `ApiError`                                                 | resilience spec                                            |
| Parallel isolation                                  | worker-scoped fixtures, unique names/rooms                           | mock run with 4+ workers                                   |
| Flake control                                       | no sleeps, barrier, bounded retries, single-flight                   | test strategy                                              |
| CI on GitHub Actions                                | `.github/workflows/api-tests.yml`                                    | quality/mock/real jobs                                     |
| Parallel workers in CI                              | `WORKERS` input, `fullyParallel`                                     | workflow                                                   |
| Mock vs real separation                             | `API_MODE` + test tiers                                              | docs and tags                                              |
| Environment approval for prod                       | GitHub Environment `prod`                                            | workflow `environment: prod`                               |
| Documentation                                       | README + `docs/*`                                                    | this folder                                                |

## Enterprise behaviours verified only on the mock

| Behaviour                                 | Test                               |
| ----------------------------------------- | ---------------------------------- |
| Unauthenticated write -> 401              | `enterprise/authorization.spec.ts` |
| Viewer write -> 403, no refresh           | `enterprise/authorization.spec.ts` |
| Expired token -> refresh + replay         | `enterprise/authorization.spec.ts` |
| Same-room overlap -> 409 (create and PUT) | `enterprise/conflicts.spec.ts`     |
| Stale `If-Match` -> 412                   | `enterprise/preconditions.spec.ts` |
| Missing fields/invalid types -> 400       | `enterprise/validation.spec.ts`    |

## Sandbox behaviours recorded, not assumed

| Behaviour                         | Test                                             |
| --------------------------------- | ------------------------------------------------ |
| `/ping` -> 201                    | `sandbox-behaviour/sandbox-observations.spec.ts` |
| Auth failure -> 200 without token | same                                             |
| POST -> 200, `roomid` dropped     | same                                             |
| Overlap allowed                   | same                                             |
| Unauthenticated writes accepted   | same                                             |
| DELETE -> 201; unknown id -> 405  | same                                             |
| Missing fields -> 500             | same                                             |
| `depositpaid` filter ignored      | same                                             |
