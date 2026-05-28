import {
  defaultClock,
  type Clock,
  type RequestLimiter,
} from "./limiter.js";

class AbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

export interface AdaptiveControllerOptions {
  /** Hard floor for concurrency. */
  min: number;
  /** Hard ceiling for concurrency. */
  max: number;
  /** Initial (skeptical) concurrency limit. */
  start: number;
  /** Consecutive request successes required to add one to the limit. */
  increaseAfter: number;
  /** Multiplier applied to the limit on a throttle (0 < f < 1). */
  decreaseFactor: number;
  /** Minimum spacing between request starts, in milliseconds. */
  minGapMs: number;
  /** Injectable clock (tests). Defaults to wall-clock. */
  clock?: Clock;
  /** Observer fired on each throttle, for progress reporting. */
  onThrottle?: (limit: number, resumeInSec: number) => void;
}

/**
 * AIMD congestion controller + request pacer + pause gate, all in one shared
 * instance. The worker pool reads {@link limit} to decide how many tasks may run
 * concurrently; the API client drives it as a {@link RequestLimiter} per request.
 *
 * - Additive increase: after `increaseAfter` consecutive successes, limit += 1.
 * - Multiplicative decrease: on throttle, limit = floor(limit * decreaseFactor).
 * - Pause: on throttle, block all request slots until the server's resets_at.
 *
 * Request-slot acquisition is serialized through a promise chain so that the
 * minimum gap is enforced globally rather than per-caller (otherwise a burst of
 * concurrent tasks would all read the same timestamp and fire together).
 */
export class AdaptiveController implements RequestLimiter {
  private readonly opts: Required<Omit<AdaptiveControllerOptions, "onThrottle">> &
    Pick<AdaptiveControllerOptions, "onThrottle">;
  private readonly clock: Clock;

  private currentLimit: number;
  private successStreak = 0;
  private pauseUntilMs = 0;
  private lastSlotMs = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: AdaptiveControllerOptions) {
    const clock = options.clock ?? defaultClock;
    this.clock = clock;
    this.opts = { clock, ...options };
    // Clamp start into [min, max] defensively.
    this.currentLimit = Math.min(
      Math.max(options.start, options.min),
      options.max
    );
  }

  /** Current maximum concurrent tasks the pool should run. */
  get limit(): number {
    return this.currentLimit;
  }

  /** Whether requests are currently paused (within a throttle reset window). */
  isPaused(now: number = this.clock.now()): boolean {
    return this.pauseUntilMs > now;
  }

  acquireRequestSlot(signal?: AbortSignal): Promise<void> {
    const run = this.tail.then(() => this.reserve(signal));
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async reserve(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new AbortError();
      const now = this.clock.now();
      if (this.pauseUntilMs > now) {
        await this.clock.sleep(this.pauseUntilMs - now, signal);
        continue;
      }
      const target = this.lastSlotMs + this.opts.minGapMs;
      if (target > now) {
        await this.clock.sleep(target - now, signal);
        continue;
      }
      this.lastSlotMs = this.clock.now();
      return;
    }
  }

  onRequestSuccess(): void {
    this.successStreak += 1;
    if (this.successStreak >= this.opts.increaseAfter) {
      this.successStreak = 0;
      this.currentLimit = Math.min(this.currentLimit + 1, this.opts.max);
    }
  }

  onThrottle(resetsAtSeconds: number): void {
    const now = this.clock.now();
    // Snapshot BEFORE extending the window: were we already inside a pause we
    // had reacted to? With N tasks in flight a single rate-limit event can
    // produce up to N concurrent 429s; halving on each would collapse straight
    // to `min`. React (halve) only once per congestion window, then just extend
    // the window so acquireRequestSlot keeps the rest blocked until it clears.
    const alreadyPaused = now < this.pauseUntilMs;

    const resetMs = resetsAtSeconds * 1000;
    if (resetMs > this.pauseUntilMs) {
      this.pauseUntilMs = resetMs;
    }

    if (alreadyPaused) {
      return;
    }

    this.successStreak = 0;
    this.currentLimit = Math.max(
      Math.floor(this.currentLimit * this.opts.decreaseFactor),
      this.opts.min
    );
    if (this.opts.onThrottle) {
      const resumeInSec = Math.max(
        0,
        Math.ceil((this.pauseUntilMs - now) / 1000)
      );
      this.opts.onThrottle(this.currentLimit, resumeInSec);
    }
  }
}
