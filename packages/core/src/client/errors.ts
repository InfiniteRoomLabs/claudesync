/**
 * Base error for every failure surfaced by the claude.ai transport layer.
 *
 * Thrown by {@link ClaudeSyncClient} for non-2xx HTTP responses and for local
 * precondition failures (e.g. an artifact path that fails the traversal guard).
 * Carrying the HTTP status on the error lets callers branch on it without
 * re-parsing a message string.
 */
export class ClaudeSyncError extends Error {
  /**
   * @param message - Human-readable failure description.
   * @param statusCode - Originating HTTP status, when the failure came from a
   * response. Omitted for client-side validation errors.
   */
  constructor(
    message: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "ClaudeSyncError";
  }
}

/**
 * Raised when claude.ai answers with HTTP 429 (rate limited).
 *
 * Specializes {@link ClaudeSyncError} with the reset timestamp parsed from the
 * `error.resets_at` field of the 429 body so callers (and the rate limiter) can
 * back off until the window reopens.
 */
export class RateLimitError extends ClaudeSyncError {
  /**
   * @param resetsAt - Unix epoch time in seconds at which the limit resets.
   * @param message - Optional override; defaults to a message embedding the
   * ISO-8601 reset time.
   */
  constructor(
    public readonly resetsAt: number,
    message?: string
  ) {
    super(
      message ??
        `Rate limited. Resets at ${new Date(resetsAt * 1000).toISOString()}`,
      429
    );
    this.name = "RateLimitError";
  }

  /**
   * Whole seconds to wait before retrying, clamped to a minimum of 0 so an
   * already-elapsed reset time never yields a negative sleep.
   */
  get sleepSeconds(): number {
    return Math.max(0, Math.ceil(this.resetsAt - Date.now() / 1000));
  }
}
