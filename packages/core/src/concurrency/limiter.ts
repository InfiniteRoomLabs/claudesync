/**
 * Request-level rate limiting interface shared by the API client and the
 * adaptive scheduler. The client consults a limiter before every HTTP request
 * and reports the outcome, so pacing and backpressure live in one place.
 */
export interface RequestLimiter {
  /**
   * Resolves when the caller is allowed to issue its next request. May block to
   * enforce inter-request spacing or to honor a server-imposed pause window.
   * Rejects with an AbortError if the signal fires while waiting.
   */
  acquireRequestSlot(signal?: AbortSignal): Promise<void>;
  /** Report that a request completed successfully (2xx). */
  onRequestSuccess(): void;
  /** Report a 429/throttle. `resetsAtSeconds` is the server's reset hint (epoch seconds). */
  onThrottle(resetsAtSeconds: number): void;
}

/** Wall-clock + cancellable sleep, injectable for deterministic tests. */
export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
  /**
   * Resolve after `ms` milliseconds, or reject early if `signal` aborts.
   *
   * @param ms - Delay in milliseconds; values <= 0 resolve on the next tick.
   * @param signal - Optional abort signal that rejects the sleep.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Rejection raised when an {@link AbortSignal} fires during a sleep or while a
 * slot is queued. Named "AbortError" so callers can branch on `err.name`.
 */
class AbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

/**
 * Default {@link Clock.sleep}: a `setTimeout` wrapped so an abort signal clears
 * the timer and rejects with {@link AbortError}, leaving no dangling listener.
 *
 * @param ms - Delay in milliseconds; <= 0 resolves immediately (or rejects if already aborted).
 * @param signal - Optional abort signal.
 * @returns Resolves after the delay; rejects with AbortError on abort.
 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return signal?.aborted ? Promise.reject(new AbortError()) : Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new AbortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new AbortError());
        return;
      }
      signal.addEventListener("abort", onAbort);
    }
  });
}

/** Wall-clock implementation of {@link Clock} backed by `Date.now` and {@link defaultSleep}. */
export const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: defaultSleep,
};

/**
 * Minimal fixed-gap limiter. Reproduces the client's legacy behavior: enforce a
 * constant minimum spacing between requests, ignore success/throttle signals.
 * Used as the default when no adaptive controller is supplied, so single-shot
 * commands and the MCP server are unaffected by the parallel sync machinery.
 */
export class FixedGapLimiter implements RequestLimiter {
  /** Epoch ms the most recent slot was granted, used to enforce `minGapMs`. */
  private lastSlotMs = 0;
  /** Serialization point so concurrent acquires are spaced rather than coincident. */
  private tail: Promise<void> = Promise.resolve();

  /**
   * @param minGapMs - Minimum spacing between request starts, in milliseconds.
   * @param clock - Injectable clock; defaults to {@link defaultClock}.
   */
  constructor(
    private readonly minGapMs: number,
    private readonly clock: Clock = defaultClock
  ) {}

  /**
   * Reserve the next slot, sleeping if needed so at least `minGapMs` has elapsed
   * since the previous grant. Serialized through {@link tail}.
   *
   * @param signal - Optional abort signal; aborting while queued rejects this call.
   * @returns Resolves when the caller may issue its request.
   * @throws AbortError if `signal` fires before the slot is granted.
   */
  acquireRequestSlot(signal?: AbortSignal): Promise<void> {
    const run = this.tail.then(() => this.reserve(signal));
    // Keep the chain alive even if this acquire rejects (e.g. aborted).
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Wait out the fixed gap (if any) and stamp {@link lastSlotMs}.
   *
   * @param signal - Optional abort signal checked on entry and during the sleep.
   * @throws AbortError if the signal is aborted.
   */
  private async reserve(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new AbortError();
    const now = this.clock.now();
    const target = this.lastSlotMs + this.minGapMs;
    if (target > now) {
      await this.clock.sleep(target - now, signal);
    }
    this.lastSlotMs = this.clock.now();
  }

  /** No-op: a fixed gap does not adapt to success signals. */
  onRequestSuccess(): void {
    /* no-op: fixed gap does not adapt */
  }

  /** No-op: in the legacy path callers handle RateLimitError themselves. */
  onThrottle(): void {
    /* no-op: callers handle RateLimitError themselves in the legacy path */
  }
}
