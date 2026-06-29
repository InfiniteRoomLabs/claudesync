import fs from "node:fs";
import path from "node:path";
import type { ClaudeSyncClient } from "../client/client.js";
import type { ConversationSummary } from "../models/types.js";
import { readSyncState, type SyncState } from "./state.js";
import { fetchAndBuild } from "./fetch.js";
import { displayName as toDisplayName } from "../util/naming.js";
import { materializeConversation, type ExportFormat } from "./materialize.js";

export type { ExportFormat };

/**
 * Caller-supplied knobs for {@link syncConversation}: output format, git author
 * identity, the three skip strategies, and the files-mode preserve list.
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
}

/** Outcome of one {@link syncConversation} call: what happened and why. */
export interface SyncConversationResult {
  /**
   * What the sync did. `skipped` means --skip-same matched stored state;
   * `skipped-existing` means --skip-existing found the output already on disk;
   * `full` is a first-time write; `incremental` is a re-sync over prior state.
   */
  action: "skipped" | "skipped-existing" | "full" | "incremental";
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
 * Orchestrates the sync of a single conversation: decides skip / full /
 * incremental, fetches data, then delegates persistence to
 * `materializeConversation` (shared with the surface seam's FileSink). Returns
 * metadata describing what happened.
 *
 * outputPath should be the conversation's directory (for files/git) or the
 * directory that will hold `<slug>.json` (for json mode).
 *
 * @param client - Authenticated claude.ai client used to fetch the conversation.
 * @param orgId - Organization uuid that owns the conversation.
 * @param summary - List-endpoint summary, used for skip decisions and labeling.
 * @param outputPath - Conversation directory (files/git) or json sidecar dir.
 * @param options - Format, author identity, skip flags, and preserve globs.
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

  // Single source of truth for fetch + build.
  const built = await fetchAndBuild(client, orgId, summary, {
    authorName: options.authorName,
    authorEmail: options.authorEmail,
    skipArtifacts: options.skipArtifacts,
    multiBranch: true,
  });
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
