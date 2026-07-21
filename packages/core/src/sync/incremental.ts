import fs from "node:fs";
import path from "node:path";
import type { ClaudeSyncClient } from "../client/client.js";
import type { ArtifactListResponse, ConversationSummary } from "../models/types.js";
import { readSyncState, writeSyncState, STATE_FILENAME, type SyncState } from "./state.js";
import { fetchAndBuild, type FetchAndBuildResult } from "./fetch.js";
import { displayName as toDisplayName } from "../util/naming.js";
import { materializeConversation, type ExportFormat } from "./materialize.js";
import { decideEmptyAction, type OnBecameEmpty } from "./empty.js";
import { buildGitBundle } from "../export/bundle-builder.js";
import { CHANGELOG_FILENAME } from "./changelog.js";
import { replaceWithPreserve } from "./files-mode.js";

export type { ExportFormat };

/**
 * Caller-supplied knobs for {@link syncConversation}: output format, git author
 * identity, the three skip strategies, the became-empty policy, and the
 * files-mode preserve list.
 */
export interface SyncConversationOptions {
  /** On-disk layout to produce: a git repo, a flat file tree, or one JSON blob. */
  format: ExportFormat;
  /** Author name stamped on git commits and exported metadata. */
  authorName: string;
  /** Author email stamped on git commits and exported metadata. */
  authorEmail: string;
  /** Skip download entirely if list metadata matches stored state. */
  skipSame?: boolean;
  /** Skip if outputPath already exists (irrespective of state). */
  skipExisting?: boolean;
  /** Don't fetch artifacts. */
  skipArtifacts?: boolean;
  /**
   * Glob patterns (POSIX-style) of locally-added files inside the
   * conversation directory that must survive a re-sync in `files` mode.
   * Matched against paths relative to the conversation directory. The
   * CHANGELOG.md sidecar is always preserved regardless of this list.
   * Examples: ["INDEX.md", "notes/**", "*.local.md"].
   */
  preserve?: string[];
  /**
   * When true (the default), a conversation found to have zero human messages
   * is diverted to the became-empty policy ({@link onBecameEmpty}) instead of
   * being materialized normally: hydration still happens (via
   * `fetchAndBuild`'s `detectEmpty`), but no artifact listing or download
   * occurs on any empty-conversation branch. Set `false` to bypass this
   * entirely -- an empty conversation then flows through the pre-existing
   * path exactly as if this option never existed.
   */
  skipEmpty?: boolean;
  /**
   * Policy applied when a conversation is found empty and {@link skipEmpty}
   * is in effect. Only consulted when prior sync state exists for this
   * conversation (a never-before-seen empty conversation is always skipped
   * regardless of this value); see {@link OnBecameEmpty} for what each policy
   * does. Defaults to `"sync"`.
   */
  onBecameEmpty?: OnBecameEmpty;
}

/** Outcome of one {@link syncConversation} call: what happened and why. */
export interface SyncConversationResult {
  /**
   * What the sync did:
   *
   * - `"skipped"`: --skip-same matched stored state.
   * - `"skipped-existing"`: --skip-existing found the output already on disk.
   * - `"full"`: a first-time write, or a became-empty `"sync"` policy forcing
   *   a full rebuild over prior state (see {@link decideEmptyAction}'s
   *   `"materialize-full"`).
   * - `"incremental"`: a re-sync over prior state.
   * - `"skipped-empty"`: the conversation has zero human messages and no
   *   prior sync state exists, so there is nothing to reconcile; no writes,
   *   no state.
   * - `"retained-stale"`: the conversation became empty and the became-empty
   *   policy is `"retain"`; the existing on-disk artifacts and state file are
   *   left byte-untouched.
   * - `"cleaned-empty"`: the conversation became empty and the became-empty
   *   policy is `"clean"`; generated content was removed (preserving
   *   CHANGELOG.md and any user `preserve` globs) while the state file was
   *   kept, rewritten with `last_sync_action: "cleaned-empty"`.
   */
  action:
    | "skipped"
    | "skipped-existing"
    | "full"
    | "incremental"
    | "skipped-empty"
    | "retained-stale"
    | "cleaned-empty";
  /** Human-readable explanation for a skip; unset for full/incremental writes. */
  reason?: string;
  /** True when a CHANGELOG.md section was appended this run. */
  changelogWritten: boolean;
  /** Human-readable label (falls back to `<unnamed <uuid>>` for nameless conversations). */
  displayName: string;
}

/**
 * Cheap predicate for --skip-same: true when the conversation looks unchanged
 * since the last sync, judged only from the list-endpoint summary (no message
 * fetch). Compares `updated_at` and the current leaf message uuid against what
 * the sidecar state recorded. A missing `prevState` (never synced) is never a
 * match, so the first sync always proceeds and writes a state file.
 *
 * @param summary - List-endpoint fields for the conversation being checked.
 * @param prevState - State recorded by the previous sync, or undefined if none.
 * @returns True when both `updated_at` and leaf uuid match the prior state.
 */
export function isSameByListMetadata(
  summary: Pick<ConversationSummary, "updated_at" | "current_leaf_message_uuid">,
  prevState: SyncState | undefined
): boolean {
  if (!prevState) return false;
  if (prevState.updated_at !== summary.updated_at) return false;
  const prevLeaf = prevState.current_leaf_message_uuid ?? null;
  const newLeaf = summary.current_leaf_message_uuid ?? null;
  return prevLeaf === newLeaf;
}

/**
 * Artifact list literal used for every became-empty branch: skip, retain,
 * clean, and the forced-full "sync" rebuild all reason from a hydrated
 * conversation already known to have zero human messages, so none of them
 * ever list or download artifacts (see the module-level self-review note on
 * `syncConversation`). Exported so the surface seam's `FileSink` can build the
 * same empty-snapshot bundle for an `isEmpty` canonical item without
 * duplicating this literal.
 */
export const NO_ARTIFACTS: ArtifactListResponse = {
  success: true,
  files: [],
  files_metadata: [],
};

/**
 * Handles a conversation that {@link fetchAndBuild} found to be empty (zero
 * human messages), applying the became-empty policy and returning the
 * resulting {@link SyncConversationResult}. Never lists or downloads
 * artifacts -- the emptiness check already ran before any artifact I/O, and
 * every branch here reasons from the conversation alone.
 *
 * @param conversation - The hydrated (empty) conversation from
 *   {@link fetchAndBuild}'s early exit.
 * @param summary - List-endpoint summary for this conversation.
 * @param outputPath - Conversation directory (files/git) or json sidecar dir.
 * @param stateDir - Directory the sync-state sidecar lives in (equals
 *   `outputPath` for git/files, the parent directory for json).
 * @param prevState - State from the last sync, or undefined if none exists.
 * @param options - The full sync options, used for format/author/preserve.
 * @param displayLabel - Precomputed display label for the result.
 * @returns The outcome for this empty conversation: skip, a forced full
 *   materialization, retain, or clean.
 */
async function handleBecameEmpty(
  conversation: FetchAndBuildResult["conversation"],
  summary: ConversationSummary,
  outputPath: string,
  stateDir: string,
  prevState: SyncState | undefined,
  options: SyncConversationOptions,
  displayLabel: string
): Promise<SyncConversationResult> {
  const policy = options.onBecameEmpty ?? "sync";
  const action = decideEmptyAction(prevState !== undefined, policy);

  switch (action) {
    case "skip":
      return {
        action: "skipped-empty",
        reason: "conversation is empty and has no prior sync state to reconcile",
        changelogWritten: false,
        displayName: displayLabel,
      };

    case "retain":
      return {
        action: "retained-stale",
        reason: "conversation is empty; onBecameEmpty=retain keeps stale content untouched",
        changelogWritten: false,
        displayName: displayLabel,
      };

    case "materialize-full": {
      // Force a full (non-incremental) rebuild: diffConversation cannot model
      // a branch vanishing to zero messages (it only walks the CURRENT
      // branch map, which is empty here), so an incremental diff against
      // prevState would silently report "unchanged" and skip the changelog
      // entirely. Passing prevState: undefined makes materializeConversation
      // treat this as an initial diff, which correctly renders an "Initial
      // export" changelog section documenting the now-zero branch/message
      // counts. The actual file/git write mechanics are unaffected by this --
      // git mode still appends onto existing history via its own diffing;
      // files/json mode already fully rebuild on every call regardless.
      const bundle = buildGitBundle(conversation, NO_ARTIFACTS, new Map(), {
        authorName: options.authorName,
        authorEmail: options.authorEmail,
        multiBranch: true,
      });
      const res = await materializeConversation({
        bundle,
        conversation,
        artifacts: NO_ARTIFACTS,
        summary,
        prevState: undefined,
        outputPath,
        format: options.format,
        preserve: options.preserve ?? [],
      });
      return {
        action: res.action,
        changelogWritten: res.changelogWritten,
        displayName: displayLabel,
      };
    }

    case "clean": {
      await cleanEmptyConversation(outputPath, options.format, options.preserve ?? []);
      const state: SyncState = {
        schema_version: 1,
        conversation_uuid: conversation.uuid,
        conversation_name: conversation.name,
        model: conversation.model ?? null,
        updated_at: summary.updated_at,
        current_leaf_message_uuid: conversation.current_leaf_message_uuid ?? null,
        leaves: [],
        artifacts: [],
        last_sync_at: new Date().toISOString(),
        last_sync_action: "cleaned-empty",
      };
      writeSyncState(stateDir, state);
      return {
        action: "cleaned-empty",
        changelogWritten: false,
        displayName: displayLabel,
      };
    }
  }
}

/**
 * Guards {@link cleanEmptyConversation} against mistaking an arbitrary
 * existing directory for a claudesync-managed conversation directory.
 *
 * This is the fix for a near-miss incident: `sink.exists()` / `fs.existsSync`
 * only prove that *some* directory is at the target path -- not that
 * claudesync ever wrote it. When the target was accidentally an entire
 * export archive root (or any other unrelated directory that happens to
 * exist), that false proxy let the became-empty `"clean"` policy attempt a
 * preserve-aware stash-and-rewrite of the WHOLE directory. Reading and
 * parsing the {@link STATE_FILENAME} sidecar is the actual proof: only a
 * directory previously written by claudesync carries one.
 *
 * @param dir - Directory expected to hold the {@link STATE_FILENAME} sidecar
 *   (the conversation directory for `git`/`files`, or the parent directory
 *   of the `<slug>.json` stem for `json`).
 * @throws If the sidecar is absent or fails to parse. The message names only
 *   `dir` -- never any content read from within it.
 */
function assertClaudesyncManagedDirectory(dir: string): void {
  let state: SyncState | undefined;
  try {
    state = readSyncState(dir);
  } catch {
    // Corrupted/unparseable sidecar counts as "no valid sidecar" for this
    // guard -- same as if the file were absent.
    state = undefined;
  }
  if (!state) {
    throw new Error(
      `Refusing to clean "${dir}": no claudesync state sidecar (${STATE_FILENAME}) found here. ` +
        "This does not look like a claudesync-managed conversation directory."
    );
  }
}

/**
 * Replaces a conversation's generated on-disk content with an empty set,
 * for the became-empty `"clean"` policy. Reuses {@link replaceWithPreserve}
 * for `git`/`files` formats (both address `outputPath` as a real directory)
 * so CHANGELOG.md and any user `preserve` globs survive exactly as they
 * would across a normal re-sync; the sync-state sidecar is dropped from the
 * stash restore because the caller rewrites it immediately after this
 * returns. `json` format has no directory to reconcile -- it is a single
 * `<outputPath>.json` file -- so that case just removes the file directly.
 *
 * Before any filesystem mutation, calls {@link assertClaudesyncManagedDirectory}
 * on the directory that should hold the state sidecar. This protects both
 * call paths that reach this function: the legacy `syncConversation` ->
 * `handleBecameEmpty` path, and the surface seam's `FileSink.writeEmpty`.
 *
 * Exported (in addition to being used by `handleBecameEmpty` above) so the
 * surface seam's `FileSink` can perform the identical clean for its
 * `ApplyOpts.cleanEmpty` directive without duplicating the preserve/drop logic.
 *
 * @param outputPath - Conversation directory (files/git) or json sidecar path
 *   stem (the actual file is `outputPath + ".json"`).
 * @param format - On-disk layout in effect for this conversation.
 * @param preserve - Files-mode preserve globs, relative to `outputPath`.
 * @throws If the target directory has no parseable state sidecar; see
 *   {@link assertClaudesyncManagedDirectory}. Thrown before any write.
 */
export async function cleanEmptyConversation(
  outputPath: string,
  format: ExportFormat,
  preserve: readonly string[]
): Promise<void> {
  const stateDir = format === "json" ? path.dirname(outputPath) : outputPath;
  assertClaudesyncManagedDirectory(stateDir);

  if (format === "json") {
    const jsonPath = outputPath + ".json";
    if (fs.existsSync(jsonPath)) {
      fs.rmSync(jsonPath);
    }
    return;
  }

  await replaceWithPreserve({
    outputPath,
    writeFresh: async () => {
      fs.mkdirSync(outputPath, { recursive: true });
    },
    alwaysPreserve: [CHANGELOG_FILENAME],
    alwaysDrop: [STATE_FILENAME],
    preserveGlobs: preserve,
  });
}

/**
 * Orchestrates the sync of a single conversation: decides skip / full /
 * incremental, fetches data, then delegates persistence to
 * `materializeConversation` (shared with the surface seam's FileSink). Returns
 * metadata describing what happened.
 *
 * outputPath should be the conversation's directory (for files/git) or the
 * directory that will hold `<slug>.json` (for json mode).
 *
 * Empty-conversation handling: unless `options.skipEmpty` is `false`, the
 * fetch step runs {@link fetchAndBuild}'s `detectEmpty` check immediately
 * after hydration and before any artifact call. A conversation found empty is
 * routed through {@link handleBecameEmpty} instead of the normal materialize
 * path; see {@link SyncConversationOptions.onBecameEmpty} for the policies.
 *
 * @param client - Authenticated claude.ai client used to fetch the conversation.
 * @param orgId - Organization uuid that owns the conversation.
 * @param summary - List-endpoint summary, used for skip decisions and labeling.
 * @param outputPath - Conversation directory (files/git) or json sidecar dir.
 * @param options - Format, author identity, skip flags, became-empty policy,
 * and preserve globs.
 * @returns Metadata describing the action taken and whether a changelog wrote.
 */
export async function syncConversation(
  client: ClaudeSyncClient,
  orgId: string,
  summary: ConversationSummary,
  outputPath: string,
  options: SyncConversationOptions
): Promise<SyncConversationResult> {
  const stateDir = options.format === "json" ? path.dirname(outputPath) : outputPath;

  // Pre-compute display label so even early-return code paths can include it.
  const prelimDisplayName = toDisplayName(summary.name, summary.uuid);

  // --skip-existing: legacy, dumb existence check.
  if (options.skipExisting) {
    const target = options.format === "json" ? outputPath + ".json" : outputPath;
    if (fs.existsSync(target)) {
      return {
        action: "skipped-existing",
        reason: "output exists",
        changelogWritten: false,
        displayName: prelimDisplayName,
      };
    }
  }

  // --skip-same: read prior state, compare list metadata.
  let prevState: SyncState | undefined;
  if (fs.existsSync(stateDir)) {
    try {
      prevState = readSyncState(stateDir);
    } catch {
      // Corrupted state -> fall through to full sync, will overwrite.
      prevState = undefined;
    }
  }

  if (options.skipSame && isSameByListMetadata(summary, prevState)) {
    return {
      action: "skipped",
      reason: "unchanged since last sync",
      changelogWritten: false,
      displayName: prelimDisplayName,
    };
  }

  const skipEmpty = options.skipEmpty ?? true;

  let built: FetchAndBuildResult;
  if (skipEmpty) {
    const fetched = await fetchAndBuild(client, orgId, summary, {
      authorName: options.authorName,
      authorEmail: options.authorEmail,
      skipArtifacts: options.skipArtifacts,
      multiBranch: true,
      detectEmpty: true,
    });
    if ("empty" in fetched) {
      return handleBecameEmpty(
        fetched.conversation,
        summary,
        outputPath,
        stateDir,
        prevState,
        options,
        prelimDisplayName
      );
    }
    built = fetched;
  } else {
    // skipEmpty: false bypasses empty handling entirely -- byte-identical to
    // the pre-existing fetch call (no detectEmpty key at all).
    built = await fetchAndBuild(client, orgId, summary, {
      authorName: options.authorName,
      authorEmail: options.authorEmail,
      skipArtifacts: options.skipArtifacts,
      multiBranch: true,
    });
  }

  const { conversation, artifacts, bundle } = built;

  const res = await materializeConversation({
    bundle,
    conversation,
    artifacts,
    summary,
    prevState,
    outputPath,
    format: options.format,
    preserve: options.preserve ?? [],
  });

  return {
    action: res.action,
    changelogWritten: res.changelogWritten,
    displayName: built.displayName,
  };
}
