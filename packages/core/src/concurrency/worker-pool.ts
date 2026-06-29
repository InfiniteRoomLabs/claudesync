/** A unit of work the pool runs. Must resolve; it should handle its own errors
 *  (requeue, log) rather than reject, since a rejection aborts the whole pool. */
export type PoolTask = () => Promise<void>;

export interface WorkerPoolOptions {
  /** Dynamic maximum number of concurrently running tasks. Read on every pump. */
  limit: () => number;
  /**
   * Return the next runnable task, or undefined if nothing is runnable *right
   * now* (queue empty, or all remaining work is gated/capped). The pool will
   * retry after a task finishes or after `idleDelayMs`.
   */
  pull: () => PoolTask | undefined;
  /** True when no further work will ever become available. Checked only when idle. */
  isDone: () => boolean;
  /** Optional abort signal; once aborted the pool drains in-flight tasks then resolves. */
  signal?: AbortSignal;
  /** Poll interval when idle but not done (work gated/paused). Default 25ms. */
  idleDelayMs?: number;
}

/**
 * Pull-based worker pool with dynamic concurrency. Workers are not long-lived
 * objects; instead a pump loop launches up to `limit()` tasks at a time, and
 * each task's completion re-pumps. This makes the concurrency limit trivially
 * adjustable at runtime (the AIMD controller raises/lowers it between pumps).
 *
 * Backpressure note: a throttle does not surface here. Tasks block inside the
 * limiter's `acquireRequestSlot` during the pause window, so they stay "active"
 * and the pool does not busy-poll. The idle poll only matters when work exists
 * but is temporarily gated (e.g. per-project cap) with no task in flight.
 */
export class WorkerPool {
  /**
   * @param options - Pull source, dynamic limit, completion check, and pacing knobs.
   */
  constructor(private readonly options: WorkerPoolOptions) {}

  /**
   * Run the pump loop until all work is done (or the signal aborts and in-flight
   * tasks drain), then resolve. Rejects only if a task itself rejects -- tasks
   * are expected to swallow their own errors, so a rejection tears down the pool.
   *
   * @returns Resolves when {@link WorkerPoolOptions.isDone} reports completion
   * with no tasks active, or after an abort drains the active set.
   * @throws Whatever a {@link PoolTask} rejects with; the first such rejection
   * settles the pool.
   */
  run(): Promise<void> {
    const { limit, pull, isDone, signal } = this.options;
    const idleDelayMs = this.options.idleDelayMs ?? 25;

    return new Promise<void>((resolve, reject) => {
      let active = 0;
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        resolve();
      };
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        reject(err);
      };

      const pump = () => {
        if (settled) return;
        if (signal?.aborted) {
          if (active === 0) finish();
          return;
        }
        while (active < limit()) {
          const task = pull();
          if (!task) break;
          active += 1;
          Promise.resolve()
            .then(task)
            .then(
              () => {
                active -= 1;
                pump();
              },
              (err) => {
                active -= 1;
                fail(err);
              }
            );
        }
        if (active === 0 && !settled) {
          if (isDone()) {
            finish();
            return;
          }
          // Work exists but nothing is runnable yet; retry shortly.
          idleTimer = setTimeout(pump, idleDelayMs);
        }
      };

      pump();
    });
  }
}
