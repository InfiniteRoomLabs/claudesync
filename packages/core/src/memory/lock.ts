import fs from "node:fs";
import path from "node:path";

/**
 * Filename of the per-project advisory lock created inside a project's
 * `memory/` directory by {@link withProjectMemoryLock}. Leading dot keeps it
 * out of casual listings; its content is only a pid and a timestamp, never
 * memory or edit text.
 */
export const MEMORY_LOCK_FILENAME = ".claudesync-memory.lock";

/**
 * Default staleness threshold for {@link withProjectMemoryLock}, in
 * milliseconds. Chosen to comfortably exceed the ~57s blocking
 * `putProjectMemoryControls` write plus scheduling slack, so a lock is only
 * ever taken over from a process that has genuinely died or hung, not one
 * still mid-write.
 */
const DEFAULT_STALE_TTL_MS = 600_000;

/**
 * Options accepted by {@link withProjectMemoryLock}.
 */
export interface WithProjectMemoryLockOptions {
  /**
   * ISO 8601 timestamp to treat as "now" for both stamping a newly acquired
   * lock and evaluating staleness of an existing one. Defaults to
   * `new Date().toISOString()`. Injectable so tests never depend on the
   * wall clock.
   */
  now?: string;
  /**
   * Milliseconds after which an existing lock's recorded `acquired_at` is
   * considered stale and eligible for takeover. Defaults to
   * {@link DEFAULT_STALE_TTL_MS} (10 minutes).
   */
  staleTtlMs?: number;
}

/**
 * Shape of the JSON written into the lockfile: enough to identify who holds
 * the lock and since when, for diagnostics and staleness evaluation. Never
 * carries memory content.
 */
interface LockFileContents {
  /** Process ID of the holder, as reported by `process.pid` at acquire time. */
  pid: number;
  /** ISO 8601 timestamp the lock was acquired at (the caller-supplied or wall-clock `now`). */
  acquired_at: string;
}

/**
 * Narrow an unknown parsed-JSON value down to {@link LockFileContents}.
 * Anything else -- wrong shape, wrong field types -- is treated as corrupt
 * by the caller, which folds into the "treat as stale" path.
 *
 * @param value - Result of `JSON.parse` on the lockfile's raw text.
 * @returns Whether `value` has the exact shape of {@link LockFileContents}.
 */
function isLockFileContents(value: unknown): value is LockFileContents {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.pid === "number" && typeof record.acquired_at === "string";
}

/**
 * Read and parse the lockfile at `lockPath`, tolerating any failure (missing
 * file, invalid JSON, wrong shape) by returning undefined instead of
 * throwing. This is a best-effort read used only to enrich diagnostics and
 * to evaluate staleness -- an unreadable lockfile is never treated as a
 * held lock, since a caller cannot tell it apart from a torn write.
 *
 * @param lockPath - Path to the lockfile.
 * @returns The parsed contents, or undefined if the file is missing, not
 * valid JSON, or does not match {@link LockFileContents}.
 */
function readLockFileBestEffort(lockPath: string): LockFileContents | undefined {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isLockFileContents(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Narrow an unknown thrown value down to a Node.js errno exception carrying
 * a `code` string, so callers can branch on `error.code === "EEXIST"`
 * without an `any` cast.
 *
 * @param error - The value caught from a failed `fs` call.
 * @returns Whether `error` is an `Error` with a string `code` property.
 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/**
 * Build the error thrown when {@link withProjectMemoryLock} finds the lock
 * already held by a non-stale holder. Names the lockfile path plus the
 * recorded pid/`acquired_at` when available, and suggests the manual escape
 * hatch (deleting the lockfile) for the case where the caller knows no other
 * push is actually running. Carries no memory content -- there is none in a
 * lock error to begin with.
 *
 * @param lockPath - Path to the held lockfile.
 * @param contents - The lockfile's parsed contents, or undefined if it could
 * not be read (rare race between the failed create and this read).
 * @returns An `Error` describing the held lock.
 */
function heldLockError(lockPath: string, contents: LockFileContents | undefined): Error {
  const pidText = contents ? String(contents.pid) : "unknown";
  const acquiredAtText = contents ? contents.acquired_at : "unknown time";
  return new Error(
    `Project memory lock ${lockPath} is already held by pid ${pidText} (acquired ${acquiredAtText}). ` +
      "Another push may be in progress. If you are certain no other push is running, delete the lockfile and retry.",
  );
}

/**
 * Decide whether an existing lock is stale relative to `now`, and therefore
 * eligible for takeover. A lockfile that is missing, unparseable, or has an
 * unparseable `acquired_at` is always treated as stale -- corruption should
 * never permanently wedge the lock.
 *
 * @param contents - The existing lockfile's parsed contents, or undefined if unreadable.
 * @param now - ISO 8601 timestamp to evaluate staleness against.
 * @param staleTtlMs - Staleness threshold in milliseconds.
 * @returns True if the lock should be taken over.
 */
function isStale(contents: LockFileContents | undefined, now: string, staleTtlMs: number): boolean {
  if (contents === undefined) return true;
  const acquiredMs = Date.parse(contents.acquired_at);
  if (Number.isNaN(acquiredMs)) return true;
  const nowMs = Date.parse(now);
  return nowMs - acquiredMs > staleTtlMs;
}

/**
 * Atomically create `lockPath` (`fs.openSync` with the `"wx"` create-exclusive
 * flag, owner-only mode) and write this process's pid and `now` into it as
 * JSON. Throws with `code === "EEXIST"` if the file already exists -- callers
 * use that to detect contention.
 *
 * @param lockPath - Path to create the lockfile at.
 * @param now - ISO 8601 timestamp recorded as `acquired_at`.
 * @returns The open file descriptor, ready to be closed by the caller on release.
 */
function createLockFile(lockPath: string, now: string): number {
  const fd = fs.openSync(lockPath, "wx", 0o600);
  const contents: LockFileContents = { pid: process.pid, acquired_at: now };
  fs.writeSync(fd, JSON.stringify(contents) + "\n");
  return fd;
}

/**
 * Run `fn` while holding an exclusive advisory lock on `<dir>/.claudesync-memory.lock`.
 *
 * This is an advisory lock against ClaudeSync racing itself -- specifically
 * the push engine's ~57s blocking GET->merge->PUT->verify->materialize body,
 * which makes "the user re-runs a push that looks stuck" a realistic
 * self-race. It is not a transaction framework: it does not coordinate with
 * other processes that ignore the lockfile, and it does not protect any
 * state beyond mutual exclusion of the wrapped `fn`.
 *
 * Acquisition is atomic (`fs.openSync(path, "wx")`), so two concurrent
 * callers can never both believe they hold the lock. If the lockfile already
 * exists and its recorded `acquired_at` is within `staleTtlMs` of `now`, this
 * throws an error naming the lockfile, the recorded pid, and `acquired_at`
 * (see {@link heldLockError}) rather than waiting -- callers that want
 * retry/backoff implement it themselves around this call. If the existing
 * lockfile is older than `staleTtlMs`, or is missing/corrupt in a way that
 * makes its age unknowable, it is treated as abandoned: unlinked and the
 * create is retried exactly once. A second `EEXIST` after that retry (a
 * racing process won the takeover) throws the same held-lock error instead
 * of looping.
 *
 * The lock is released (`fs.closeSync` then `fs.unlinkSync`) in a `finally`,
 * so it is released whether `fn` resolves or throws; both release calls are
 * best-effort and swallow their own errors so a release failure never masks
 * `fn`'s own result or error.
 *
 * @typeParam T - The type returned by `fn`.
 * @param dir - The project's `memory/` directory. Created recursively with
 * owner-only mode (0o700, matching the materializer) if it does not already
 * exist.
 * @param fn - The work to run while holding the lock.
 * @param opts - See {@link WithProjectMemoryLockOptions}.
 * @returns Whatever `fn` resolves to.
 * @throws If the lock is already held by a non-stale holder, or is still
 * held by a racing process immediately after a stale takeover.
 * @throws Whatever `fn` throws, after the lock has been released.
 */
export async function withProjectMemoryLock<T>(
  dir: string,
  fn: () => Promise<T>,
  opts: WithProjectMemoryLockOptions = {},
): Promise<T> {
  const now = opts.now ?? new Date().toISOString();
  const staleTtlMs = opts.staleTtlMs ?? DEFAULT_STALE_TTL_MS;

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  const lockPath = path.join(dir, MEMORY_LOCK_FILENAME);

  let fd: number;
  try {
    fd = createLockFile(lockPath, now);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") throw error;

    const existing = readLockFileBestEffort(lockPath);
    if (!isStale(existing, now, staleTtlMs)) {
      throw heldLockError(lockPath, existing);
    }

    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Best-effort: if the stale file is already gone, the retry below
      // will either succeed (we win the race) or fail with EEXIST (we
      // lost it), either of which is handled correctly.
    }

    try {
      fd = createLockFile(lockPath, now);
    } catch (retryError) {
      if (!isErrnoException(retryError) || retryError.code !== "EEXIST") throw retryError;
      throw heldLockError(lockPath, readLockFileBestEffort(lockPath));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Best-effort release: fn's result/error must not be masked by a
      // failure to close an already-broken descriptor.
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Best-effort release: same rationale as above.
    }
  }
}
