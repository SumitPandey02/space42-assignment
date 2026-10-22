/**
 * Run-scoped unique identifiers.
 *
 * The public booking API is shared with the entire internet and enforces no
 * isolation, so every record this framework creates carries a run-unique
 * fingerprint. That makes test data findable (exact-match query filters work on
 * restful-booker) and guarantees two parallel workers can never collide.
 */

const PROCESS_EPOCH = Date.now();

function sanitizeToken(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9]/g, '').slice(0, 18);
}

export function createRunId(source: NodeJS.ProcessEnv = process.env): string {
  const githubRunId = source.GITHUB_RUN_ID?.trim();
  if (githubRunId !== undefined && githubRunId !== '') {
    const attempt = sanitizeToken(source.GITHUB_RUN_ATTEMPT?.trim() ?? '1') || '1';
    return `${sanitizeToken(githubRunId)}-${attempt}`;
  }
  return `${PROCESS_EPOCH.toString(36)}-${process.pid.toString(36)}`;
}

export const RUN_ID = createRunId();

/**
 * Build a name that is unique across runs, workers and sequential creations.
 * Example: `Bk-abc123-1-0-4` (prefix-runId-workerIndex-sequence).
 */
export function uniqueName(prefix: string, workerIndex: number, sequence: number): string {
  return `${prefix}-${RUN_ID}-${workerIndex}-${sequence}`;
}

/** Monotonic counter; one instance per factory/worker. */
export class Sequence {
  private value = 0;

  next(): number {
    this.value += 1;
    return this.value;
  }

  get current(): number {
    return this.value;
  }
}
