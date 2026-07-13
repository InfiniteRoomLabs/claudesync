import fs from "node:fs";
import path from "node:path";

import { hashContent } from "./hash.js";
import { canonicalize, parseEdits, serializeEdits } from "./edits.js";
import {
  readMemoryState,
  writeMemoryState,
  type MemoryState,
} from "./state.js";
import type { ProjectMemory } from "../models/types.js";

/**
 * Filename of the local read-only mirror of the server-generated memory
 * document, written into a project's `memory/` directory by
 * {@link pullProjectMemory}.
 */
const MEMORY_FILENAME = "MEMORY.md";

/**
 * Filename of the local read-only mirror of the server-tracked edit-control
 * list (serialized via {@link serializeEdits}), written into a project's
 * `memory/` directory by {@link pullProjectMemory}.
 */
const EDITS_FILENAME = "edits.md";

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
 * Deterministic fingerprint of a claude.ai account identifier, used to detect
 * when a memory directory that was pulled under one account is being pulled
 * again under a different one (e.g. a shared checkout, or a credential swap).
 *
 * @param accountId - The claude.ai account identifier.
 * @returns `hashContent(accountId)`.
 */
export function computePrincipalFingerprint(accountId: string): string {
  return hashContent(accountId);
}

/**
 * Stable fingerprint over the memory document hash and the ordered
 * per-control hashes, used as the sidecar's `remote_snapshot_sha256` for the
 * idempotency no-op check: if this hash is unchanged and neither local file
 * is dirty, a pull is a true no-op.
 *
 * @param memoryHash - `hashContent` of the canonicalized memory document.
 * @param controlHashes - Ordered per-entry `hashContent` of the `controls` array.
 * @returns `hashContent(memoryHash + "\n" + controlHashes.join("\n"))`.
 */
export function snapshotHash(memoryHash: string, controlHashes: string[]): string {
  return hashContent(memoryHash + "\n" + controlHashes.join("\n"));
}

/**
 * Write `text` to `filePath` atomically (tmp file + rename) with owner-only
 * permissions, mirroring the pattern `state.ts` uses for the sidecar. If the
 * process dies mid-write the previous file (if any) is left intact.
 *
 * @param filePath - Destination path.
 * @param text - Content to write.
 */
function writeFileAtomic(filePath: string, text: string): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, text, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
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
 * 3. No prior sidecar -> initial write (`"written"`).
 * 4. Prior sidecar whose `remote_snapshot_sha256` matches the freshly
 *    computed snapshot AND neither local file is dirty relative to its base
 *    -> `"unchanged"`, nothing written (not even the sidecar).
 * 5. Remote snapshot changed and (without `force`) either local file is
 *    dirty relative to its base -> `"conflict"`, nothing written.
 * 6. Otherwise -> write both files and the sidecar (`"written"`).
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

  if (prior !== undefined && !remoteChanged) {
    // Remote is identical to the last pull, so the base to compare local
    // files against is equivalently `remote`/`prior` (they match).
    const memoryClean =
      localMemoryText === undefined || hashContent(canonicalize(localMemoryText)) === prior.memory_content_sha256;
    const editsClean =
      localEditsText === undefined ||
      hashArraysEqual(parseEdits(localEditsText).map((c) => hashContent(c)), prior.controls_base);
    if (memoryClean && editsClean) {
      return { action: "unchanged", memoryChanged: false, controlsCount };
    }
  }

  if (prior !== undefined && remoteChanged && !force) {
    const memoryDirty =
      localMemoryText !== undefined && hashContent(canonicalize(localMemoryText)) !== prior.memory_content_sha256;
    const editsDirty =
      localEditsText !== undefined &&
      !hashArraysEqual(parseEdits(localEditsText).map((c) => hashContent(c)), prior.controls_base);
    if (memoryDirty || editsDirty) {
      return { action: "conflict", memoryChanged: false, controlsCount };
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(memoryPath, canonicalMemory);
  writeFileAtomic(editsPath, editsFileText);

  const memoryChanged = prior !== undefined && prior.memory_content_sha256 !== memoryHash;

  const newState: MemoryState = {
    schema_version: 1,
    project_uuid: projectId,
    principal_fingerprint: principalFingerprint,
    memory_content_sha256: memoryHash,
    controls_base: controlHashes,
    remote_snapshot_sha256: snapshot,
    last_pull_at: now,
    remote_updated_at: remote.updated_at,
  };
  writeMemoryState(dir, newState);

  return { action: "written", memoryChanged, controlsCount };
}
