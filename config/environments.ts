/**
 * Single source of truth for named environment profiles.
 *
 * SECURITY: this file is committed. It must never contain credentials. Base
 * URLs that are not public are supplied at runtime through `BASE_URL`
 * (workflow input / repository or environment variable), never hardcoded here.
 *
 * NAMING NOTE (deliberate, see docs/architecture.md):
 * The assessment target (https://restful-booker.herokuapp.com) is a public
 * shared sandbox. It is registered as the `prod` profile because it is the only
 * concrete, always-reachable host supplied with the assignment. The `sandbox`
 * and `uat` profiles are reserved for dedicated test environments and remain
 * empty until a real host is provided.
 */

export type ApiEnv = 'sandbox' | 'uat' | 'prod';

/** `real` talks to a network host; `mock` talks to the in-process enterprise mock. */
export type ApiMode = 'real' | 'mock';

export interface EnvironmentProfile {
  readonly name: ApiEnv;
  /** Empty string means "must be supplied at runtime through BASE_URL". */
  readonly baseUrl: string;
  readonly description: string;
  /**
   * Whether the target rejects unauthenticated writes. The public
   * restful-booker sandbox does NOT, which is why the enterprise authentication
   * contract is verified against the deterministic mock instead.
   */
  readonly authEnforced: boolean;
  /** Whether the target rejects overlapping bookings for the same room. */
  readonly roomOverlapEnforced: boolean;
  /** Whether the target exposes optimistic locking (If-Match / version). */
  readonly optimisticLockingEnforced: boolean;
  /** Upper bound on parallel workers, to stay polite on a shared host. */
  readonly maxWorkers: number;
}

export const ENVIRONMENTS: Readonly<Record<ApiEnv, EnvironmentProfile>> = Object.freeze({
  sandbox: {
    name: 'sandbox',
    baseUrl: '',
    description:
      'Dedicated, isolated test environment. Base URL is supplied at runtime via BASE_URL or vars.BASE_URL.',
    authEnforced: true,
    roomOverlapEnforced: true,
    optimisticLockingEnforced: true,
    maxWorkers: 4,
  },
  uat: {
    name: 'uat',
    baseUrl: '',
    description:
      'User acceptance environment. Base URL is supplied at runtime via BASE_URL or vars.UAT_BASE_URL.',
    authEnforced: true,
    roomOverlapEnforced: true,
    optimisticLockingEnforced: true,
    maxWorkers: 4,
  },
  prod: {
    name: 'prod',
    baseUrl: 'https://restful-booker.herokuapp.com',
    description:
      'Assessment target: the public restful-booker sandbox. Shared with the world, so it is treated politely and read defensively.',
    authEnforced: false,
    roomOverlapEnforced: false,
    optimisticLockingEnforced: false,
    maxWorkers: 4,
  },
});

export const API_ENVS = Object.keys(ENVIRONMENTS) as readonly ApiEnv[];
export const API_MODES: readonly ApiMode[] = ['mock', 'real'];

/**
 * Deterministic local mock settings. These are development defaults, not
 * secrets: the mock only ever listens on the loopback interface.
 */
export const MOCK_DEFAULTS = Object.freeze({
  port: 4_010,
  adminKey: 'mock-admin',
  adminUsername: 'admin',
  adminPassword: 'password123',
  viewerUsername: 'viewer',
  viewerPassword: 'viewerpass',
  tokenTtlMs: 900_000,
});

export const PUBLIC_SANDBOX_CREDENTIALS = Object.freeze({
  username: 'admin',
  password: 'password123',
});

/** Hard ceiling for mock mode, which has no shared host to protect. */
export const MAX_MOCK_WORKERS = 16;
