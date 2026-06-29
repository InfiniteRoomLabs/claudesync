/**
 * Public surface of the concurrency subsystem: the request-pacing limiters, the
 * AIMD adaptive controller, the eligibility-aware priority queue, and the
 * pull-based worker pool that together drive parallel sync. See each source
 * module for the full documentation of these symbols.
 */

// Rate-limiting interface, clock abstraction, and the non-adaptive limiter.
export type { RequestLimiter, Clock } from "./limiter.js";
export { FixedGapLimiter, defaultSleep, defaultClock } from "./limiter.js";

// AIMD congestion controller (limiter + pacer + pause gate) and its options.
export { AdaptiveController } from "./controller.js";
export type { AdaptiveControllerOptions } from "./controller.js";

// Stable min-priority queue with an optional eligibility predicate.
export { MinPriorityQueue } from "./priority-queue.js";

// Pull-based worker pool with dynamic concurrency, plus its task/option types.
export { WorkerPool } from "./worker-pool.js";
export type { PoolTask, WorkerPoolOptions } from "./worker-pool.js";
