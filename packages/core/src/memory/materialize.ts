import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { hashContent } from "./hash.js";
import { canonicalize, parseEdits, serializeEdits } from "./edits.js";
import { writeMemoryState, type MemoryState } from "./state.js";
import type { ProjectMemory } from "../models/types.js";

/**
 * Filename of the local read-only mirror of the server-generated memory
 * document, written into a project's `memory/` directory by
 * {@link materializeProjectMemorySnapshot}.
 */
export const MEMORY_FILENAME = "MEMORY.md";

/**
 * Filename of the local read-only mirror of the server-tracked edit-control
 * list (serialized via {@link serializeEdits}), written into a project's
 * `memory/` directory by {@link materializeProjectMemorySnapshot}.
 */
export const EDITS_FILENAME = "edits.md";

/**
 * Deterministic fingerprint of a claude.ai account identifier, used to detect
 * when a memory directory that was synced under one account is being synced
 * again under a different one (e.g. a shared checkout, or a credential
 * swap). Shared by both the pull and push engines' principal-mismatch guards.
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
 * Write `text` to `filePath` atomically (unique-suffixed tmp file + rename)
 * with owner-only permissions. The tmp filename includes a random hex suffix
 * (`<file>.<random-hex>.tmp`) rather than a fixed `.tmp` suffix so that two
 * overlapping materialize calls targeting the same path (e.g. a pull and a
 * push racing against each other) never collide on the same tmp file. If the
 * process dies mid-write the previous file (if any) is left intact.
 *
 * @param filePath - Destination path.
 * @param text - Content to write.
 */
function writeFileAtomic(filePath: string, text: string): void {
  const suffix = randomBytes(8).toString("hex");
  const tmpPath = `${filePath}.${suffix}.tmp`;
  fs.writeFileSync(tmpPath, text, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

/**
 * Options accepted by {@link materializeProjectMemorySnapshot}.
 */
export interface MaterializeProjectMemorySnapshotOptions {
  /**
   * The project memory payload to materialize, with `controls` already
   * resolved to a non-null array (callers with a nullable `controls` field,
   * e.g. `pullProjectMemory`, must substitute `[]` for `null` before calling
   * -- the "no memory generated yet" case is a decision made upstream, not
   * inside the materializer).
   */
  remote: ProjectMemory & { controls: string[] };
  /**
   * The sidecar state read before this call, or undefined on a first
   * materialize into `dir`. Used to compute `memoryChanged` and to preserve
   * whichever of `last_pull_at`/`last_push_at` the current `source` does not
   * stamp.
   */
  prior: MemoryState | undefined;
  /** claude.ai account identifier; hashed into the sidecar's `principal_fingerprint`. */
  accountId: string;
  /** Project UUID this memory belongs to, recorded in the sidecar for diagnostics. */
  projectId: string;
  /** The `memory/` directory to write `MEMORY.md`, `edits.md`, and the state sidecar into. */
  dir: string;
  /** ISO 8601 timestamp to stamp into the sidecar as `last_pull_at` or `last_push_at`, per `source`. */
  now: string;
  /**
   * Which operation is materializing this snapshot. `"pull"` stamps
   * `last_pull_at: now` and preserves any existing `last_push_at` from
   * `prior`; `"push"` stamps `last_push_at: now` and preserves any existing
   * `last_pull_at` from `prior`.
   */
  source: "pull" | "push";
}

/**
 * Outcome of a single {@link materializeProjectMemorySnapshot} call.
 */
export interface MaterializeProjectMemorySnapshotResult {
  /**
   * Whether the memory document's content hash differs from the prior
   * sidecar's `memory_content_sha256`. False when `prior` is undefined
   * (nothing to compare against), or when the memory content is unchanged.
   */
  memoryChanged: boolean;
  /**
   * Number of edit-control entries that actually land in `edits.md` -- i.e.
   * `remote.controls` after {@link serializeEdits}/{@link parseEdits}
   * normalization drops blank/whitespace-only entries.
   */
  controlsCount: number;
}

/**
 * Unconditionally write a project's memory snapshot to disk: canonicalize the
 * memory document, compute content hashes (memory + normalized per-entry
 * control hashes), create `dir` owner-only, atomically write `MEMORY.md` and
 * `edits.md`, then write the state sidecar last (state-last crash ordering --
 * if the process dies after the file writes but before the sidecar write,
 * the sidecar still reflects the previous synced state rather than claiming
 * a snapshot that only partially landed).
 *
 * This is the single writer shared by {@link pullProjectMemory} and the
 * project-memory push path: both engines own their own decision logic (when
 * to write vs. report `"unchanged"`/`"conflict"`) and delegate only the
 * actual filesystem materialization here. Callers are expected to have
 * already decided that a write should happen -- this function performs no
 * conflict detection of its own.
 *
 * Control hashes are computed from the *normalized* form
 * (`parseEdits(serializeEdits(controls))`), not the raw `remote.controls`
 * array -- entries are trimmed and blanks are dropped. Hashing the raw array
 * would mismatch the read-time recomputation callers use for dirty-checking
 * whenever an entry has surrounding whitespace or is blank, breaking
 * idempotency and producing false conflicts. This is a regression-tested
 * invariant carried over unchanged from the Phase 1 pull engine.
 *
 * @param opts - See {@link MaterializeProjectMemorySnapshotOptions}.
 * @returns See {@link MaterializeProjectMemorySnapshotResult}.
 */
export function materializeProjectMemorySnapshot(
  opts: MaterializeProjectMemorySnapshotOptions,
): MaterializeProjectMemorySnapshotResult {
  const { remote, prior, accountId, projectId, dir, now, source } = opts;

  const memoryPath = path.join(dir, MEMORY_FILENAME);
  const editsPath = path.join(dir, EDITS_FILENAME);

  const principalFingerprint = computePrincipalFingerprint(accountId);

  const canonicalMemory = canonicalize(remote.memory);
  const memoryHash = hashContent(canonicalMemory);
  // Single source of truth for the edit list: serialize once, then derive the
  // stored per-entry base hashes from the SAME parsed-back form the read-back
  // dirty-check uses (parseEdits trims each entry and drops blanks).
  const editsFileText = serializeEdits(remote.controls);
  const normalizedControls = parseEdits(editsFileText);
  const controlHashes = normalizedControls.map((c) => hashContent(c));
  const controlsCount = normalizedControls.length;
  const snapshot = snapshotHash(memoryHash, controlHashes);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
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
    last_pull_at: source === "pull" ? now : prior?.last_pull_at,
    last_push_at: source === "push" ? now : prior?.last_push_at,
    remote_updated_at: remote.updated_at,
  };
  writeMemoryState(dir, newState);

  return { memoryChanged, controlsCount };
}
