# Assessment mapping

| Requirement                                         | Implementation                                                       | Evidence                                         |
| --------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| Playwright + TypeScript API framework               | `playwright.config.ts`, `tsconfig.json`, `src/clients/*`             | `npm run typecheck`, `npm test`                  |
| Playwright `APIRequestContext` (no Axios)           | `src/clients/http-client.ts`                                         | transport behaviour used by every spec           |
| Configurable base URL                               | `config/environment.ts`, `config/environments.ts`                    | `BASE_URL`, `API_ENV`                            |
| Environment-specific settings, no hardcoded secrets | profiles + env precedence, `.env.example`, CI secrets                | `resolveEnvironment`                             |
| Worker count configurable                           | `WORKERS`, profile ceilings                                          | `playwright.config.ts`                           |
| Allure reporting                                    | `allure-playwright`, `allurerc.mjs`, `src/reporting/global-setup.ts` | `npm run allure:generate`                        |
| Diagnostics on failure                              | sanitised HTTP history attached in `src/fixtures/api.fixture.ts`     | failed-test attachment                           |
| Typed clients for auth and bookings                 | `AuthClient`, `BookingClient`                                        | client methods                                   |
| Zod runtime validation                              | `src/contracts/*.schema.ts`                                          | every parsed response                            |
| Dynamic token generation                            | `AuthClient.fetchToken`                                              | `tests/auth/authentication.spec.ts`              |
| Token caching, configurable refresh threshold       | `TokenManager` TTL from acquisition                                  | auth lifecycle test + stats                      |
| 401 invalidation, refresh, safe replay              | `BookingClient.authorizedSend`                                       | implemented; unobservable on this host           |
| 403 handled separately                              | `ForbiddenError`, no refresh on 403                                  | `http-client` error mapping                      |
| Single-flight refresh                               | `TokenManager.refresh`                                               | concurrent callers share one promise             |
| Refresh failure leaves no stale token               | `TokenManager.acquire` catch path                                    | source behaviour, no public trigger              |
| Avoid refreshing per test                           | worker-scoped manager + cache                                        | token reuse test                                 |
| Health check                                        | `BookingClient.ping`                                                 | `booking-lifecycle.spec.ts`, sandbox observation |
| Create/read/PUT/PATCH/delete lifecycle              | `tests/booking/booking-lifecycle.spec.ts`                            | `@smoke` lifecycle                               |
| Schema/structure validation, checkout > checkin     | Zod `bookingDatesSchema`                                             | lifecycle and contract parsing                   |
| Date-range generation, no hardcoded dates           | `BookingFactory`, `date-utils.ts`                                    | lifecycle and overlap tests                      |
| Overlap scenario against a second context           | same host, duplicate stay; adaptive outcome                          | `tests/contracts/host-capabilities.spec.ts`      |
| Actual rejection status recorded                    | attached `overlap-capability` artifact                               | Allure report                                    |
| Repeated PUT (3x)                                   | `tests/booking/booking-idempotency.spec.ts`                          | state convergence                                |
| PATCH drift                                         | `tests/booking/booking-patch.spec.ts`                                | preserved fields                                 |
| Reusable retry utility                              | `src/utils/retry.ts`                                                 | used by transport and resilience                 |
| Bounded exponential backoff + jitter                | `computeBackoffDelay`                                                | transport policy                                 |
| No unsafe POST retry                                | transport `REPLAY_SAFE_METHODS`                                      | transport comments + behaviour                   |
| Concurrency barrier + conflicting writes            | `src/utils/barrier.ts`, `tests/booking/booking-concurrency.spec.ts`  | `@concurrency`                                   |
| Record timings/statuses/responses                   | attached `concurrency-observations`                                  | Allure attachment                                |
| No false millisecond claims                         | documented + bounded dispatch delta                                  | concurrency spec                                 |
| Unique test data                                    | `BookingFactory`                                                     | per-run/worker/sequence names                    |
| Safe cleanup even after failure                     | auto cleanup fixture                                                 | resilience spec                                  |
| Context-sensitive 403/404/405                       | lifecycle, resilience, sandbox observations                          | post-deletion assertions                         |
| Bounded recovery + clear diagnostics                | `retry` + `ApiError`                                                 | resilience spec                                  |
| Parallel isolation                                  | worker-scoped fixtures, unique names/rooms                           | full run with 4 workers                          |
| Flake control                                       | no sleeps, barrier, bounded retries, single-flight                   | test strategy                                    |
| CI on GitHub Actions                                | `.github/workflows/api-tests.yml`                                    | quality + sandbox + real-other jobs              |
| PR smoke, nightly full                              | workflow conditions and `@smoke`                                     | `sandbox` job                                    |
| Documentation                                       | README + `docs/*`                                                    | this folder                                      |

## Enterprise behaviours recorded adaptively

| Behaviour                                  | Test                                  |
| ------------------------------------------ | ------------------------------------- |
| Unauthenticated write accepted or rejected | `contracts/host-capabilities.spec.ts` |
| Duplicate overlap accepted or rejected     | same                                  |
| ETag enforced, absent, or unenforced       | same                                  |
| Missing fields/malformed JSON/unknown ids  | same                                  |

## Sandbox behaviours recorded, not assumed

| Behaviour                         | Test                                             |
| --------------------------------- | ------------------------------------------------ |
| `/ping` -> 201                    | `sandbox-behaviour/sandbox-observations.spec.ts` |
| Auth failure -> 200 without token | same                                             |
| POST -> 200, `roomid` dropped     | same                                             |
| DELETE -> 201                     | same                                             |
| Non-numeric id -> 404             | same                                             |
| `depositpaid` filter ignored      | same                                             |

## Deliberately not included

- Unit tests: the brief asks for a pipeline; behaviour is covered through the host.
- Mock server: documented in the README as an interview-discussion option, not shipped.
- Strict 401/403/409/412 assertions: impossible on this host, so the contract tests record both possible outcomes and tighten automatically on a capable target.
