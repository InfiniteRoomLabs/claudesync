import fs from "node:fs";
import path from "node:path";

import { hashContent } from "./hash.js";
import { canonicalize, parseEdits, serializeEdits } from "./edits.js";
import { readMemoryState } from "./state.js";
import {
  materializeProjectMemorySnapshot,
  computePrincipalFingerprint,
  snapshotHash,
  MEMORY_FILENAME,
  EDITS_FILENAME,
} from "./materialize.js";
import type { ProjectMemory } from "../models/types.js";

export { computePrincipalFingerprint };

/**
 * Outcome of a single {@link pullProjectMemory} call, reporting what happened
 * to the local mirror without requiring the caller to re-inspect the
 * filesystem.
 */
export interface MemoryPullOutcome {
  /**
   * What the pull did to the local files:
   * - `"written"` -- `MEMORY.md`/`edits.md`/sidecar were created or overwritten.
   * - `"unchanged"` -- the remote snapshot matches the sidecar and neither
   *   local file is dirty; nothing was touched, not even file timestamps.
   * - `"conflict"` -- a local file was modified since the last pull's base
   *   hash while the remote snapshot also changed; nothing was overwritten.
   *   Passing `force` turns this case into `"written"` instead.
   * - `"no-memory"` -- the project has never had memory generated
   *   (`remote.controls === null` and `remote.memory === ""`); nothing was
   *   written.
   */
  action: "written" | "unchanged" | "conflict" | "no-memory";
  /**
   * Whether the memory document's content hash differs from the sidecar's
   * prior `memory_content_sha256`. False when there was no prior sidecar to
   * compare against (initial pull), or when the memory content is unchanged.
   */
  memoryChanged: boolean;
  /**
   * Number of edit-control entries that actually land in `edits.md` -- i.e.
   * `remote.controls` after {@link serializeEdits}/{@link parseEdits}
   * normalization drops blank/whitespace-only entries (0 if `remote.controls`
   * is null, e.g. on a `"no-memory"` outcome).
   */
  controlsCount: number;
}

/**
 * Options accepted by {@link pullProjectMemory}.
 */
export interface PullProjectMemoryOptions {
  /**
   * The project memory payload already fetched from the claude.ai API (e.g.
   * via `getProjectMemory`). {@link pullProjectMemory} performs no network
   * I/O itself -- callers own the fetch and pass the result in.
   */
  remote: ProjectMemory;
  /** claude.ai account identifier; fingerprinted to detect a switched account pulling into the same directory. */
  accountId: string;
  /** Project UUID this memory belongs to, recorded in the sidecar for diagnostics. */
  projectId: string;
  /** The `memory/` directory to read/write `MEMORY.md`, `edits.md`, and the state sidecar in. */
  dir: string;
  /** ISO 8601 timestamp to record as `last_pull_at` in the sidecar. */
  now: string;
  /**
   * When true, bypasses the principal-mismatch throw and overwrites local
   * files even if they are dirty (a conflict becomes a `"written"` re-pull).
   */
  force?: boolean;
}

/**
 * Read a local mirror file if present.
 *
 * @param filePath - Path to read.
 * @returns The file's UTF-8 text, or undefined if the file does not exist.
 */
function readIfExists(filePath: string): string | undefined {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : undefined;
}

/**
 * Compare two ordered hash arrays for exact equality (same length, same
 * values, same order).
 *
 * @param a - First array.
 * @param b - Second array.
 * @returns True if both arrays contain the same hashes in the same order.
 */
function hashArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i]);
}

/**
 * Fetch, decide, and materialize a project's memory into a local directory.
 *
 * Pure of the network: the caller fetches `remote` (e.g. via
 * `getProjectMemory`) and this function does only filesystem work. It writes
 * `MEMORY.md`, `edits.md`, and the state sidecar atomically (tmp file +
 * rename, mode `0600`), and is idempotent -- an unchanged remote with clean
 * local files is a true no-op that leaves file timestamps untouched.
 *
 * Local-dirty detection compares the on-disk file against the *base*
 * recorded in the last pull's sidecar, not against the current `remote`:
 * - `MEMORY.md` -- `hashContent(canonicalize(read))` vs the sidecar's
 *   `memory_content_sha256`.
 * - `edits.md` -- the sidecar stores only per-entry control hashes
 *   (`controls_base`), not a whole-file hash, so the local file is parsed
 *   back into entries via {@link parseEdits} and each entry is hashed and
 *   compared against `controls_base` (same length, same order, same
 *   values). This is equivalent to comparing whole-file hashes but avoids
 *   needing to persist edit-instruction text in the sidecar.
 *
 * Decision order:
 * 1. `remote.controls === null && remote.memory === ""` -> `"no-memory"`,
 *    nothing written.
 * 2. A prior sidecar with a different `principal_fingerprint` -> throws,
 *    unless `force` is set.
 * 3. A prior sidecar exists:
 *    a. Remote snapshot unchanged AND neither local file is dirty relative
 *       to its recorded base -> `"unchanged"`, nothing written (not even
 *       the sidecar).
 *    b. Either local file is dirty relative to its base -- regardless of
 *       whether the remote moved -- and `force` is not set -> `"conflict"`,
 *       nothing written. This also covers a dirty local file under an
 *       unchanged remote (e.g. re-pulling after hand-editing the mirror),
 *       which is otherwise indistinguishable from case (a) unless dirtiness
 *       is checked unconditionally.
 *    c. Otherwise (remote changed and local is clean, or `force` is set)
 *       -> fall through to write.
 * 4. No prior sidecar (first pull into this directory):
 *    a. `MEMORY.md` or `edits.md` already exists locally and differs from
 *       what would be written, and `force` is not set -> `"conflict"`,
 *       nothing written -- there is no recorded base to reconcile a
 *       pre-existing file against, so it is never silently overwritten.
 *    b. Otherwise -> fall through to write.
 * 5. Write `MEMORY.md`, `edits.md`, and the sidecar -> `"written"`.
 *
 * @param opts - See {@link PullProjectMemoryOptions}.
 * @returns The {@link MemoryPullOutcome} describing what happened.
 * @throws If a prior sidecar's `principal_fingerprint` does not match
 * `computePrincipalFingerprint(opts.accountId)` and `opts.force` is not set --
 * fails closed rather than silently mixing accounts' memory into one directory.
 */
export function pullProjectMemory(opts: PullProjectMemoryOptions): MemoryPullOutcome {
  const { remote, accountId, projectId, dir, now, force = false } = opts;

  if (remote.controls === null && remote.memory === "") {
    return { action: "no-memory", memoryChanged: false, controlsCount: 0 };
  }

  const memoryPath = path.join(dir, MEMORY_FILENAME);
  const editsPath = path.join(dir, EDITS_FILENAME);

  const principalFingerprint = computePrincipalFingerprint(accountId);
  const prior = readMemoryState(dir);

  if (prior !== undefined && prior.principal_fingerprint !== principalFingerprint && !force) {
    throw new Error(
      `pullProjectMemory: principal mismatch for "${dir}" -- the memory sidecar was last pulled by a ` +
        "different account; pass force: true to overwrite intentionally.",
    );
  }

  const canonicalMemory = canonicalize(remote.memory);
  const memoryHash = hashContent(canonicalMemory);
  // Single source of truth for the edit list: serialize once, then derive the
  // stored per-entry base hashes from the SAME parsed-back form the read-back
  // dirty-check uses (parseEdits trims each entry and drops blanks). Hashing
  // the raw `remote.controls` here would mismatch the read-time recomputation
  // whenever an entry has surrounding whitespace or is blank, breaking
  // idempotency and producing false conflicts.
  const editsFileText = serializeEdits(remote.controls ?? []);
  const normalizedControls = parseEdits(editsFileText);
  const controlHashes = normalizedControls.map((c) => hashContent(c));
  const controlsCount = normalizedControls.length;
  const snapshot = snapshotHash(memoryHash, controlHashes);

  const localMemoryText = readIfExists(memoryPath);
  const localEditsText = readIfExists(editsPath);

  const remoteChanged = prior === undefined || prior.remote_snapshot_sha256 !== snapshot;

  if (prior !== undefined) {
    // A prior sidecar exists: local-dirty detection is independent of
    // whether the remote moved, so a hand-edit sitting under an unchanged
    // remote is still caught (previously this branch only ran when
    // `remoteChanged` was true, so a dirty local file under an unchanged
    // remote fell through to the unconditional write below and was
    // silently overwritten).
    const memoryDirty =
      localMemoryText !== undefined && hashContent(canonicalize(localMemoryText)) !== prior.memory_content_sha256;
    const editsDirty =
      localEditsText !== undefined &&
      !hashArraysEqual(parseEdits(localEditsText).map((c) => hashContent(c)), prior.controls_base);
    if (!remoteChanged && !memoryDirty && !editsDirty) {
      return { action: "unchanged", memoryChanged: false, controlsCount };
    }
    if ((memoryDirty || editsDirty) && !force) {
      return { action: "conflict", memoryChanged: false, controlsCount };
    }
    // Else: remote changed and local is clean (a normal pull), or force is
    // set -- fall through to the write below.
  } else {
    // No prior sidecar (initial pull for this directory). If a local file
    // already exists and differs from what we're about to write, we have no
    // recorded base to reconcile it against -- treat it as an unrecoverable
    // conflict rather than silently overwriting a reused/manually-copied
    // directory (previously this case had no guard at all).
    const memoryPreexists =
      localMemoryText !== undefined && hashContent(canonicalize(localMemoryText)) !== memoryHash;
    const editsPreexists =
      localEditsText !== undefined && !hashArraysEqual(parseEdits(localEditsText).map((c) => hashContent(c)), controlHashes);
    if ((memoryPreexists || editsPreexists) && !force) {
      return { action: "conflict", memoryChanged: false, controlsCount };
    }
    // Else: no stray local files, or they already match what we'd write.
  }

  const outcome = materializeProjectMemorySnapshot({
    remote: { ...remote, controls: remote.controls ?? [] },
    prior,
    accountId,
    projectId,
    dir,
    now,
    source: "pull",
  });

  return { action: "written", memoryChanged: outcome.memoryChanged, controlsCount: outcome.controlsCount };
}
