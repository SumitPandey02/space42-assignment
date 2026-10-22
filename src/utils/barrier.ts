/**
 * N-way synchronisation barrier.
 *
 * Used by the race-condition test to release two (or more) HTTP writes in the
 * same microtask turn. JavaScript cannot guarantee a shared wall-clock
 * millisecond, so the test *measures* the actual dispatch delta instead of
 * claiming simultaneity it cannot substantiate.
 */

export class Barrier {
  private arrivals = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly parties: number) {
    if (!Number.isInteger(parties) || parties < 1) {
      throw new Error(`Barrier requires an integer party count >= 1, received ${parties}`);
    }
  }

  get arrived(): number {
    return this.arrivals;
  }

  get remaining(): number {
    return Math.max(0, this.parties - this.arrivals);
  }

  /** Resolves once `parties` callers have arrived. The barrier then re-arms. */
  wait(): Promise<void> {
    this.arrivals += 1;

    if (this.arrivals >= this.parties) {
      const waiters = this.waiters.splice(0);
      this.arrivals = 0;
      for (const resolve of waiters) {
        resolve();
      }
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

/**
 * Run every task after all of them have reached the barrier. All requests are
 * therefore dispatched from the same microtask batch.
 */
export async function runAtBarrier<T>(tasks: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
  if (tasks.length === 0) {
    return [];
  }

  const barrier = new Barrier(tasks.length);
  return Promise.all(tasks.map((task) => barrier.wait().then(() => task())));
}
