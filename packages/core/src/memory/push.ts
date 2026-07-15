import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { hashContent } from "./hash.js";
import { canonicalize, parseEdits, serializeEdits } from "./edits.js";
import { readMemoryState, writeMemoryState, type MemoryState } from "./state.js";
import {
  materializeProjectMemorySnapshot,
  computePrincipalFingerprint,
  snapshotHash,
  MEMORY_FILENAME,
  EDITS_FILENAME,
} from "./materialize.js";
import { withProjectMemoryLock } from "./lock.js";
import { mergeProjectMemoryControls, assertNoDelimiterEntries } from "./merge.js";
import type { ProjectMemory } from "../models/types.js";
import type { ClaudeSyncClient, PutProjectMemoryControlsOptions } from "../client/client.js";

/**
 * Options accepted by {@link planProjectMemoryPush}.
 */
export interface PlanProjectMemoryPushOptions {
  /**
   * The project's current memory as just fetched from the claude.ai API (e.g.
   * via `getProjectMemory`). Planning performs no network I/O itself -- the
   * caller owns the fetch and passes the result in, so the same fetch can be
   * reused by {@link applyProjectMemoryPush} without a redundant round-trip.
   */
  remote: ProjectMemory;
  /**
   * claude.ai account identifier for the principal performing the push.
   * Fingerprinted via {@link computePrincipalFingerprint} and compared
   * against the sidecar's recorded `principal_fingerprint` to fail closed on
   * an account switch.
   */
  accountId: string;
  /**
   * Project UUID this push targets. Compared against the sidecar's
   * `project_uuid` to fail closed on a directory reused for the wrong
   * project.
   */
  projectId: string;
  /**
   * The `memory/` directory to read the sidecar and `edits.md` from. Must
   * already contain a sidecar written by a prior `pullProjectMemory` (or a
   * prior push) -- there is no implicit first-push initialization.
   */
  dir: string;
  /**
   * When provided, used as the local control entries instead of reading
   * `edits.md` from `dir` -- e.g. an empty array for an explicit
   * `edits clear`, or a CLI-supplied replacement list. A missing `edits.md`
   * is only tolerated when this is supplied; otherwise it is an error.
   */
  localControlsOverride?: string[];
}

/**
 * The outcome of planning a project memory push: a pure decision plus the
 * exact array that would be sent to `putProjectMemoryControls`, computed
 * without any network I/O or filesystem writes.
 *
 * `mergedControls` and `remoteControls` carry raw control-entry text and
 * exist only for the apply engine (and advanced callers) to act on --
 * per the privacy rule, callers that render a plan to a user or log MUST
 * use only {@link ProjectMemoryPushPlan.localAdds},
 * {@link ProjectMemoryPushPlan.localDeletes},
 * {@link ProjectMemoryPushPlan.remoteAdds}, and
 * {@link ProjectMemoryPushPlan.remoteDeletes}, never these two fields.
 */
export interface ProjectMemoryPushPlan {
  /** The project UUID this plan was computed for, echoed from the options for convenience. */
  projectId: string;
  /**
   * What the plan recommends:
   * - `"no-memory"` -- the project has never had memory generated
   *   (`remote.memory === ""`); there is nothing to push. Note that
   *   `remote.controls === null` alone is NOT a reliable never-generated
   *   signal: a project with a fully generated memory doc but zero edit
   *   instructions also reports `controls: null`. That case is normalized
   *   to an empty controls array and merged normally -- it resolves to
   *   `"no-op"` or `"put"`, never `"no-memory"`.
   * - `"no-op"` -- the merged controls are identical (normalized,
   *   order-sensitive) to the live remote controls; a `PUT` would be a
   *   no-op write.
   * - `"put"` -- the merged controls differ from the live remote controls
   *   and should be sent via `putProjectMemoryControls`.
   */
  action: "put" | "no-op" | "no-memory";
  /**
   * The normalized array to `PUT` if `action === "put"` (or the array that
   * already matches the remote if `action === "no-op"`). Empty for
   * `"no-memory"`. Contains raw control-entry text -- never render this to
   * a user or log; see the interface-level privacy note.
   */
  mergedControls: string[];
  /**
   * The live remote controls, normalized the same way as
   * {@link ProjectMemoryPushPlan.mergedControls} (trimmed, blanks dropped).
   * Empty for `"no-memory"`. Contains raw control-entry text -- never
   * render this to a user or log; see the interface-level privacy note.
   */
  remoteControls: string[];
  /** The remote's `updated_at` as observed in `remote`, echoed for diagnostics. */
  remoteUpdatedAt: string | null;
  /** Count of local `edits.md` entries not present in the base and preserved into {@link ProjectMemoryPushPlan.mergedControls}. Zero for `"no-memory"`. */
  localAdds: number;
  /** Count of distinct base entries removed locally and dropped from {@link ProjectMemoryPushPlan.mergedControls}. Zero for `"no-memory"`. */
  localDeletes: number;
  /** Count of remote-only entries (added on claude.ai since the last pull) preserved into {@link ProjectMemoryPushPlan.mergedControls}. Zero for `"no-memory"`. */
  remoteAdds: number;
  /** Count of distinct base entries removed on the remote and dropped from {@link ProjectMemoryPushPlan.mergedControls}. Zero for `"no-memory"`. */
  remoteDeletes: number;
}

/**
 * Read `edits.md` from `dir` into the ordered control-entry array, throwing
 * if the file is missing. A missing file is deliberately never treated as an
 * implicit "clear all controls" -- that would silently turn an interrupted
 * or not-yet-run pull into a destructive push. Callers who intend to clear
 * controls must say so explicitly via `localControlsOverride: []`.
 *
 * @param dir - The `memory/` directory expected to contain `edits.md`.
 * @returns The parsed, trimmed, non-blank control entries.
 * @throws Error if `edits.md` does not exist in `dir`.
 */
function readLocalEditsOrThrow(dir: string): string[] {
  const editsPath = path.join(dir, EDITS_FILENAME);
  if (!fs.existsSync(editsPath)) {
    throw new Error(
      `planProjectMemoryPush: "${editsPath}" is missing. A missing edits.md is never treated as an implicit ` +
        "clear-all -- run `projects memory pull` first, or pass an explicit localControlsOverride (e.g. [] to clear).",
    );
  }
  return parseEdits(fs.readFileSync(editsPath, "utf-8"));
}

/**
 * Compare two string arrays for exact equality: same length, same values,
 * same order.
 *
 * @param a - First array.
 * @param b - Second array.
 * @returns True if both arrays contain the same strings in the same order.
 */
function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * Normalize a raw controls array to the canonical on-disk form (trimmed,
 * blank entries dropped), matching the normalization
 * {@link mergeProjectMemoryControls} applies internally to each of its
 * inputs. Used here so {@link ProjectMemoryPushPlan.mergedControls} can be
 * compared against the remote on equal footing for the no-op/put decision.
 *
 * @param entries - Raw control entries.
 * @returns The normalized entries, in the same relative order.
 */
function normalizeControls(entries: readonly string[]): string[] {
  return parseEdits(serializeEdits(Array.from(entries)));
}

/**
 * Pure decision engine for a project memory push: no network I/O, no
 * filesystem writes. Reads and validates the local sidecar and (usually)
 * `edits.md`, three-way merges local intent against the caller-supplied
 * `remote` snapshot, and returns the exact plan {@link applyProjectMemoryPush}
 * would execute.
 *
 * Validation and decision order:
 * 1. The sidecar must exist in `opts.dir` -- thrown if absent, directing the
 *    caller to `projects memory pull` first. There is no implicit
 *    first-push initialization.
 * 2. The sidecar's `project_uuid` must match `opts.projectId` -- thrown if
 *    not, guarding against a directory reused for the wrong project.
 * 3. The sidecar's `principal_fingerprint` must match
 *    `computePrincipalFingerprint(opts.accountId)` -- thrown if not, naming
 *    `--adopt-legacy-principal` as the only sanctioned migration path for a
 *    sidecar synced under a different account.
 * 4. If `opts.remote.memory === ""` (memory never generated for this
 *    project), the plan is `"no-memory"` immediately -- `edits.md` is never
 *    read or required in this case, since there is nothing to merge against.
 *    `opts.remote.controls === null` is deliberately NOT checked here: a
 *    project can have a fully generated memory doc and zero edit
 *    instructions, which also reports `controls: null` -- that is not the
 *    never-generated case and must fall through to step 5.
 * 5. Otherwise, `opts.remote.controls` is normalized to `[]` if `null` (the
 *    zero-edit-instructions case from step 4's note), then the local control
 *    entries are obtained (from `opts.localControlsOverride` if supplied,
 *    else by reading `edits.md` -- throwing if that file is missing),
 *    validated via {@link assertNoDelimiterEntries}, and merged against the
 *    normalized remote controls with `state.controls_base` as the three-way
 *    merge base via {@link mergeProjectMemoryControls}.
 * 6. If the merged controls (normalized) exactly equal the remote controls
 *    (normalized, order-sensitive), the plan is `"no-op"`; otherwise `"put"`.
 *
 * @param opts - See {@link PlanProjectMemoryPushOptions}.
 * @returns The computed {@link ProjectMemoryPushPlan}.
 * @throws Error if no sidecar exists in `opts.dir`.
 * @throws Error if the sidecar's `project_uuid` does not match `opts.projectId`.
 * @throws Error if the sidecar's `principal_fingerprint` does not match the
 * fingerprint of `opts.accountId`.
 * @throws Error if `edits.md` is missing from `opts.dir` and
 * `opts.localControlsOverride` was not supplied, and `opts.remote.memory`
 * is not `""` (i.e. this is not the `"no-memory"` case).
 * @throws Error if any local control entry contains a line equal to the
 * `edits.md` delimiter (`---`), per {@link assertNoDelimiterEntries}.
 */
export function planProjectMemoryPush(opts: PlanProjectMemoryPushOptions): ProjectMemoryPushPlan {
  const { remote, accountId, projectId, dir, localControlsOverride } = opts;

  const state = readMemoryState(dir);
  if (state === undefined) {
    throw new Error(
      `planProjectMemoryPush: no project memory sidecar found in "${dir}". Run \`projects memory pull\` first.`,
    );
  }

  if (state.project_uuid !== projectId) {
    throw new Error(
      `planProjectMemoryPush: the sidecar in "${dir}" belongs to project "${state.project_uuid}", not "${projectId}".`,
    );
  }

  const principalFingerprint = computePrincipalFingerprint(accountId);
  if (state.principal_fingerprint !== principalFingerprint) {
    throw new Error(
      `planProjectMemoryPush: principal mismatch for "${dir}" -- this memory directory was last synced under a ` +
        "different account. Re-run with --adopt-legacy-principal to intentionally adopt it under the current account.",
    );
  }

  if (remote.memory === "") {
    return {
      projectId,
      action: "no-memory",
      mergedControls: [],
      remoteControls: [],
      remoteUpdatedAt: remote.updated_at,
      localAdds: 0,
      localDeletes: 0,
      remoteAdds: 0,
      remoteDeletes: 0,
    };
  }

  // `remote.controls` is null both when memory was never generated (already
  // handled above) and when memory HAS been generated but the project has
  // zero edit instructions -- the latter is a legitimate first-edit state,
  // not a no-memory state, so it normalizes to an empty list and merges
  // normally rather than short-circuiting.
  const remoteControls = remote.controls ?? [];

  const local = localControlsOverride ?? readLocalEditsOrThrow(dir);
  assertNoDelimiterEntries(local);

  const mergeResult = mergeProjectMemoryControls(state.controls_base, local, remoteControls);
  const remoteNormalized = normalizeControls(remoteControls);
  const action = stringArraysEqual(mergeResult.controls, remoteNormalized) ? "no-op" : "put";

  return {
    projectId,
    action,
    mergedControls: mergeResult.controls,
    remoteControls: remoteNormalized,
    remoteUpdatedAt: remote.updated_at,
    localAdds: mergeResult.localAdds,
    localDeletes: mergeResult.localDeletes,
    remoteAdds: mergeResult.remoteAdds,
    remoteDeletes: mergeResult.remoteDeletes,
  };
}

/**
 * Options accepted by {@link applyProjectMemoryPush}.
 */
export interface ApplyProjectMemoryPushOptions {
  /**
   * The subset of {@link ClaudeSyncClient} the apply engine needs: a fresh
   * read before planning, and the single confirmed write. Typed as a
   * `Pick` so tests can supply a minimal fake object instead of a full
   * client instance.
   */
  client: Pick<ClaudeSyncClient, "getProjectMemory" | "putProjectMemoryControls">;
  /** Organization UUID the project belongs to. */
  orgId: string;
  /** claude.ai account identifier for the principal performing the push; see {@link PlanProjectMemoryPushOptions.accountId}. */
  accountId: string;
  /** Project UUID this push targets; see {@link PlanProjectMemoryPushOptions.projectId}. */
  projectId: string;
  /** The `memory/` directory holding the sidecar, `MEMORY.md`, and `edits.md`; see {@link PlanProjectMemoryPushOptions.dir}. */
  dir: string;
  /** ISO 8601 timestamp used both to stamp the advisory lock and as `now` for any materialized sidecar update. */
  now: string;
  /** Forwarded to {@link planProjectMemoryPush}; see {@link PlanProjectMemoryPushOptions.localControlsOverride}. */
  localControlsOverride?: string[];
  /** Forwarded to `putProjectMemoryControls` as its write timeout; omitted uses that method's own default. */
  timeoutMs?: number;
}

/**
 * Outcome of a single {@link applyProjectMemoryPush} call.
 */
export interface ProjectMemoryPushOutcome {
  /**
   * What actually happened:
   * - `"no-memory"` -- the project has never had memory generated; nothing
   *   was sent or written.
   * - `"unchanged"` -- the plan was a no-op; local files were converged to
   *   the live remote (which may be a byte-identical rewrite) but no `PUT`
   *   was sent.
   * - `"written"` -- the `PUT` succeeded and the post-write verification GET
   *   confirmed the server's controls match what was sent; `MEMORY.md`,
   *   `edits.md`, and the sidecar were all advanced.
   * - `"verify-mismatch"` -- the `PUT` succeeded but the post-write
   *   verification GET returned controls that differ from what was sent
   *   (e.g. a concurrent external write raced this one). Only `MEMORY.md`
   *   and the sidecar's `memory_content_sha256`/`remote_updated_at` were
   *   updated; `edits.md` and `controls_base` were deliberately left
   *   untouched so the next push re-merges the still-pending local intent
   *   instead of silently treating a dropped local add as an accepted
   *   deletion. Callers should treat this as a warning-level failure
   *   (nonzero exit in a CLI).
   */
  action: "written" | "unchanged" | "no-memory" | "verify-mismatch";
  /**
   * Number of edit-control entries now live for this project, as observed
   * in the response used to decide `action` (0 for `"no-memory"`). Does not
   * imply `edits.md` reflects this count -- see `"verify-mismatch"` above.
   */
  controlsCount: number;
  /**
   * Whether the memory document's content hash differs from the sidecar's
   * prior `memory_content_sha256`. Always false for `"no-memory"`.
   */
  memoryChanged: boolean;
  /** The remote's `updated_at` as observed in the response used to decide `action`. */
  remoteUpdatedAt: string | null;
}

/**
 * Write `text` to `filePath` atomically (unique-suffixed tmp file + rename)
 * with owner-only permissions, mirroring `materialize.ts`'s writer so the
 * hybrid verify-mismatch path (which must NOT go through the full
 * materializer, since it must not touch `edits.md` or `controls_base`) gets
 * the same crash-safety guarantee.
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
 * The dedicated partial writer for the hybrid verify-mismatch case: writes
 * only `MEMORY.md` from the server-authoritative post-write snapshot, and
 * updates only `memory_content_sha256`, `remote_updated_at`, and (to keep
 * those two fields internally consistent) `remote_snapshot_sha256` -- all
 * derived from the same unchanged `controls_base` the sidecar already
 * carries -- in the sidecar. `edits.md` is never opened, and `controls_base`
 * is copied through verbatim, so the next push still sees the local intent
 * that did not make it to the server and re-merges it, rather than treating
 * the server's unexpected controls as the new base.
 *
 * @param remote - The post-`PUT` verification snapshot (`controls` must be
 * non-null; callers check this before calling in).
 * @param prior - The sidecar state read before this push began. Every field
 * except `memory_content_sha256`, `remote_updated_at`, and
 * `remote_snapshot_sha256` is carried through unchanged.
 * @param dir - The `memory/` directory to write `MEMORY.md` and the sidecar into.
 * @returns The normalized live control count (for {@link ProjectMemoryPushOutcome.controlsCount})
 * and whether the memory content changed relative to `prior`.
 */
function writeVerifyMismatchMemoryOnly(
  remote: ProjectMemory & { controls: string[] },
  prior: MemoryState,
  dir: string,
): { controlsCount: number; memoryChanged: boolean } {
  const memoryPath = path.join(dir, MEMORY_FILENAME);
  const canonicalMemory = canonicalize(remote.memory);
  const memoryHash = hashContent(canonicalMemory);
  const memoryChanged = prior.memory_content_sha256 !== memoryHash;

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  writeFileAtomic(memoryPath, canonicalMemory);

  // NOTE: remote_updated_at is advanced to this verify GET's timestamp while
  // controls_base stays at the pre-push base (see the @returns/@param docs
  // above -- controls_base is carried through verbatim). remote_updated_at is
  // purely informational here and drives no branching; do not read it as the
  // observation time of controls_base.
  const newState: MemoryState = {
    ...prior,
    memory_content_sha256: memoryHash,
    remote_snapshot_sha256: snapshotHash(memoryHash, prior.controls_base),
    remote_updated_at: remote.updated_at,
  };
  writeMemoryState(dir, newState);

  const controlsCount = normalizeControls(remote.controls).length;
  return { controlsCount, memoryChanged };
}

/**
 * Fetch, plan, and (if needed) apply a project memory push: the single
 * mutation the claude.ai memory API offers, wrapped in the merge-before-PUT
 * safety net and the hybrid post-write verification.
 *
 * The whole body runs inside {@link withProjectMemoryLock} on `opts.dir`, so
 * two overlapping pushes against the same directory (most realistically the
 * user re-running a push that looks stuck during the ~57 s write) cannot
 * race each other.
 *
 * Flow:
 * 1. `GET` the project's current memory -- always fresh, never trusting the
 *    sidecar as a stand-in for current remote state.
 * 2. {@link planProjectMemoryPush} against that fresh snapshot.
 * 3. `"no-memory"` -- return immediately; no `PUT` is sent.
 * 4. `"no-op"` -- converge local files to the fetched remote via
 *    {@link materializeProjectMemorySnapshot} (`source: "push"`) and return
 *    `"unchanged"`. This also naturally covers the "crashed after a PUT that
 *    actually succeeded" case: the next run's opening GET already reflects
 *    the applied write, so the merge against it comes back a no-op instead
 *    of attempting to resend it.
 * 5. `"put"` -- call `putProjectMemoryControls` with the plan's merged
 *    controls. This call is never retried, by design (see
 *    {@link ClaudeSyncClient.putProjectMemoryControls}); a timeout or any
 *    other error propagates to the caller unchanged, since the write may
 *    already have applied server-side and blind retry could double-apply it.
 * 6. After a successful `PUT`, `GET` again to verify. If the server reports
 *    `controls === null` here, the write did not visibly take effect --
 *    either the server lost the write, or (for a project pushing its first
 *    edit instruction, i.e. `plan.remoteControls` was empty because the
 *    opening GET's `controls` was null despite a generated memory doc) the
 *    server does not support initializing the edit list via this API for
 *    this project. Either way this throws rather than silently reporting
 *    success; nothing has been materialized at this point, so `edits.md` and
 *    the sidecar's `controls_base` are untouched and local edits are
 *    preserved. Otherwise, if the normalized returned controls exactly equal
 *    the plan's merged controls, the full snapshot is materialized
 *    (`source: "push"`, advancing `MEMORY.md`, `edits.md`, and the sidecar
 *    including `controls_base` and `last_push_at`) and the outcome is
 *    `"written"`.
 * 7. Otherwise (the verification GET's controls differ from what was sent --
 *    a hybrid verify-mismatch, most likely a concurrent external write
 *    racing this one): only `MEMORY.md` and a narrow slice of the sidecar
 *    are updated via a dedicated writer (see
 *    {@link writeVerifyMismatchMemoryOnly}) that deliberately leaves
 *    `edits.md` and `controls_base` untouched, so the next push re-merges
 *    the local intent that did not make it to the server rather than
 *    silently discarding it. The outcome is `"verify-mismatch"`, which
 *    callers should treat as a warning-level failure.
 *
 * @param opts - See {@link ApplyProjectMemoryPushOptions}.
 * @returns The {@link ProjectMemoryPushOutcome} describing what happened.
 * @throws Whatever {@link planProjectMemoryPush} throws (sidecar/principal/
 * project-uuid/missing-edits/delimiter validation failures).
 * @throws Whatever `client.putProjectMemoryControls` throws, unmodified --
 * in particular a timeout's ambiguous-write error, which is never retried.
 * @throws Error if the post-write verification GET reports `controls === null`,
 * i.e. the write did not visibly take effect -- either the server lost it, or
 * it does not support initializing the edit list via this API for this
 * project. Local edits are preserved; nothing was materialized.
 * @throws Whatever {@link withProjectMemoryLock} throws if the lock is
 * already held by another non-stale push.
 */
export async function applyProjectMemoryPush(
  opts: ApplyProjectMemoryPushOptions,
): Promise<ProjectMemoryPushOutcome> {
  const { client, orgId, accountId, projectId, dir, now, localControlsOverride, timeoutMs } = opts;

  return withProjectMemoryLock(
    dir,
    async () => {
      const remote = await client.getProjectMemory(orgId, projectId);

      const plan = planProjectMemoryPush({ remote, accountId, projectId, dir, localControlsOverride });

      if (plan.action === "no-memory") {
        return {
          action: "no-memory",
          controlsCount: 0,
          memoryChanged: false,
          remoteUpdatedAt: remote.updated_at,
        };
      }

      if (plan.action === "no-op") {
        const prior = readMemoryState(dir);
        const materialized = materializeProjectMemorySnapshot({
          remote: { ...remote, controls: remote.controls ?? [] },
          prior,
          accountId,
          projectId,
          dir,
          now,
          source: "push",
        });
        return {
          action: "unchanged",
          controlsCount: materialized.controlsCount,
          memoryChanged: materialized.memoryChanged,
          remoteUpdatedAt: remote.updated_at,
        };
      }

      const putOptions: PutProjectMemoryControlsOptions = { timeoutMs };
      await client.putProjectMemoryControls(orgId, projectId, plan.mergedControls, putOptions);

      const verifyRemote = await client.getProjectMemory(orgId, projectId);
      if (verifyRemote.controls === null) {
        throw new Error(
          `applyProjectMemoryPush: project "${projectId}" reported no controls immediately after a successful ` +
            "write -- the server either lost the write or does not support initializing the edit list via API " +
            "for this project. The write did not take effect; local edits.md and the sidecar's controls_base " +
            "are unchanged. Re-run push to reconcile.",
        );
      }

      const verifyNormalized = normalizeControls(verifyRemote.controls);
      const prior = readMemoryState(dir);

      if (stringArraysEqual(verifyNormalized, plan.mergedControls)) {
        const materialized = materializeProjectMemorySnapshot({
          remote: { ...verifyRemote, controls: verifyRemote.controls },
          prior,
          accountId,
          projectId,
          dir,
          now,
          source: "push",
        });
        return {
          action: "written",
          controlsCount: materialized.controlsCount,
          memoryChanged: materialized.memoryChanged,
          remoteUpdatedAt: verifyRemote.updated_at,
        };
      }

      if (prior === undefined) {
        // Unreachable in practice: planProjectMemoryPush above already
        // succeeded, which requires a sidecar to exist in dir. Guarded
        // explicitly rather than asserted away, since this path is about to
        // write a sidecar update and must never silently invent one.
        throw new Error(
          `applyProjectMemoryPush: internal invariant violated -- no sidecar found in "${dir}" after a ` +
            "successful plan. This should be unreachable; please report it.",
        );
      }
      const { controlsCount, memoryChanged } = writeVerifyMismatchMemoryOnly(
        { ...verifyRemote, controls: verifyRemote.controls },
        prior,
        dir,
      );
      return {
        action: "verify-mismatch",
        controlsCount,
        memoryChanged,
        remoteUpdatedAt: verifyRemote.updated_at,
      };
    },
    { now },
  );
}
