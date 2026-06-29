import {
  defaultClock,
  type Clock,
  type RequestLimiter,
} from "./limiter.js";

/**
 * Rejection raised when an {@link AbortSignal} fires while a request slot is
 * waiting. Named "AbortError" so callers can branch on `err.name` without
 * importing this class (it is local to the module).
 */
class AbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

/**
 * Tuning knobs for {@link AdaptiveController}'s AIMD loop and request pacer.
 * Passed once at construction; every field except {@link onThrottle} is required
 * so the controller never has to guess a policy.
 */
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
  /** Resolved options with the clock defaulted; {@link onThrottle} stays optional. */
  private readonly opts: Required<Omit<AdaptiveControllerOptions, "onThrottle">> &
    Pick<AdaptiveControllerOptions, "onThrottle">;
  /** Clock used for `now()` and cancellable sleeps; injectable for tests. */
  private readonly clock: Clock;

  /** Current concurrency limit, kept within `[min, max]`. */
  private currentLimit: number;
  /** Consecutive successes since the last increase or throttle. */
  private successStreak = 0;
  /** Epoch ms before which all request slots stay blocked (0 means no pause). */
  private pauseUntilMs = 0;
  /** Epoch ms the most recent slot was granted, used to enforce `minGapMs`. */
  private lastSlotMs = 0;
  /** Serialization point: each acquire chains off this so slots are paced globally. */
  private tail: Promise<void> = Promise.resolve();

  /**
   * @param options - Policy and pacing parameters. {@link AdaptiveControllerOptions.start}
   * is clamped into `[min, max]` defensively in case the caller passes an out-of-range seed.
   */
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

  /**
   * Whether requests are currently paused (within a throttle reset window).
   *
   * @param now - Epoch ms to test against; defaults to the clock's current time.
   * @returns True if the pause window has not yet elapsed.
   */
  isPaused(now: number = this.clock.now()): boolean {
    return this.pauseUntilMs > now;
  }

  /**
   * Reserve the next request slot, honoring both the global minimum gap and any
   * active pause window. Acquisitions are serialized through {@link tail} so a
   * burst of concurrent callers is spaced out rather than firing together.
   *
   * @param signal - Optional abort signal; aborting while queued rejects this call.
   * @returns Resolves when the caller may issue its request.
   * @throws AbortError if `signal` fires before the slot is granted.
   */
  acquireRequestSlot(signal?: AbortSignal): Promise<void> {
    const run = this.tail.then(() => this.reserve(signal));
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Loop that waits out the pause window, then the inter-request gap, before
   * stamping {@link lastSlotMs} and returning. Re-checks after each sleep since
   * a throttle may have extended the pause while this caller was waiting.
   *
   * @param signal - Optional abort signal checked on entry and during each sleep.
   * @throws AbortError if the signal is aborted.
   */
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

  /**
   * Record a successful request. Additive increase: after
   * {@link AdaptiveControllerOptions.increaseAfter} consecutive successes the
   * limit grows by one (capped at `max`) and the streak resets.
   */
  onRequestSuccess(): void {
    this.successStreak += 1;
    if (this.successStreak >= this.opts.increaseAfter) {
      this.successStreak = 0;
      this.currentLimit = Math.min(this.currentLimit + 1, this.opts.max);
    }
  }

  /**
   * Record a throttle (429). Multiplicative decrease plus a pause: the limit is
   * scaled by {@link AdaptiveControllerOptions.decreaseFactor} (floored at `min`)
   * and the pause window is extended to the server's reset time. The halving
   * fires at most once per congestion window -- with N tasks in flight a single
   * rate-limit can surface as N concurrent 429s, and halving on each would
   * collapse straight to `min`; subsequent 429s in the same window only extend
   * the pause.
   *
   * @param resetsAtSeconds - Server reset hint in epoch seconds; converted to ms.
   */
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
