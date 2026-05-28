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
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

class AbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

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
  private lastSlotMs = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly minGapMs: number,
    private readonly clock: Clock = defaultClock
  ) {}

  acquireRequestSlot(signal?: AbortSignal): Promise<void> {
    const run = this.tail.then(() => this.reserve(signal));
    // Keep the chain alive even if this acquire rejects (e.g. aborted).
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async reserve(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new AbortError();
    const now = this.clock.now();
    const target = this.lastSlotMs + this.minGapMs;
    if (target > now) {
      await this.clock.sleep(target - now, signal);
    }
    this.lastSlotMs = this.clock.now();
  }

  onRequestSuccess(): void {
    /* no-op: fixed gap does not adapt */
  }

  onThrottle(): void {
    /* no-op: callers handle RateLimitError themselves in the legacy path */
  }
}
