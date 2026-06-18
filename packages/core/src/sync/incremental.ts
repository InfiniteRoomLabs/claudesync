import fs from "node:fs";
import path from "node:path";
import type { ClaudeSyncClient } from "../client/client.js";
import type { ConversationSummary } from "../models/types.js";
import { readSyncState, type SyncState } from "./state.js";
import { fetchAndBuild } from "./fetch.js";
import { displayName as toDisplayName } from "../util/naming.js";
import { materializeConversation, type ExportFormat } from "./materialize.js";

export type { ExportFormat };

export interface SyncConversationOptions {
  format: ExportFormat;
  authorName: string;
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

export interface SyncConversationResult {
  action: "skipped" | "skipped-existing" | "full" | "incremental";
  reason?: string;
  changelogWritten: boolean;
  /** Human-readable label (falls back to `<unnamed <uuid>>` for nameless conversations). */
  displayName: string;
}

/**
 * Cheap predicate for --skip-same. Returns true when the list-endpoint summary
 * matches what the sidecar state file recorded on the previous sync. Caller
 * should still write a state file even when this returns false (bootstrap).
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
