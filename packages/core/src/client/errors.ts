export class ClaudeSyncError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "ClaudeSyncError";
  }
}

export class RateLimitError extends ClaudeSyncError {
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

  /** Seconds until rate limit resets */
  get sleepSeconds(): number {
    return Math.max(0, Math.ceil(this.resetsAt - Date.now() / 1000));
  }
}
