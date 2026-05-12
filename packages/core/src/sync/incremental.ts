import fs from "node:fs";
import path from "node:path";
import { rmSync } from "node:fs";
import type { ClaudeSyncClient } from "../client/client.js";
import type {
  ArtifactListResponse,
  Conversation,
  ConversationSummary,
} from "../models/types.js";
import { exportToGit, appendToGit } from "../export/git-exporter.js";
import { diffConversation } from "./diff.js";
import {
  appendChangelog,
  renderChangelogSection,
  CHANGELOG_FILENAME,
} from "./changelog.js";
import {
  readSyncState,
  writeSyncState,
  STATE_FILENAME,
  type SyncState,
} from "./state.js";
import { buildMessageTree, findLeafMessages } from "../tree/message-tree.js";
import { fetchAndBuild } from "./fetch.js";
import { displayName as toDisplayName } from "../util/naming.js";
import { replaceWithPreserve } from "./files-mode.js";

export type ExportFormat = "git" | "files" | "json";

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
 * incremental, fetches data, runs the right exporter, writes the state file
 * and changelog. Returns metadata describing what happened.
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
  const stateDir = options.format === "json"
    ? path.dirname(outputPath)
    : outputPath;

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
  const diff = diffConversation(prevState, conversation, artifacts);

  // For json mode: bundle is the full snapshot, written as a single JSON file.
  if (options.format === "json") {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath + ".json", JSON.stringify(bundle, null, 2), "utf-8");
    writeStateFile(stateDir, summary, conversation, artifacts, prevState ? "incremental" : "full");
    return {
      action: prevState ? "incremental" : "full",
      changelogWritten: false,
      displayName: built.displayName,
    };
  }

  const isFresh = !fs.existsSync(outputPath);

  if (options.format === "git") {
    if (isFresh) {
      await exportToGit(bundle, outputPath);
    } else {
      await appendToGit(bundle, outputPath);
    }
  } else {
    await writeFilesMode(bundle, outputPath, options.preserve ?? []);
  }

  let changelogWritten = false;
  const section = renderChangelogSection(diff, new Date());
  if (section) {
    appendChangelog(outputPath, section);
    changelogWritten = true;
  }

  if (options.format === "git") {
    ensureGitignore(outputPath);
  }

  writeStateFile(
    outputPath,
    summary,
    conversation,
    artifacts,
    prevState ? "incremental" : "full"
  );

  return {
    action: prevState ? "incremental" : "full",
    changelogWritten,
    displayName: built.displayName,
  };
}

/**
 * Files mode: replay bundle into outputPath via the same tmp+swap pattern as
 * exportToGit, but strip .git at the end.
 *
 * Preservation: every re-sync rebuilds the directory from scratch. Files that
 * the user (or a downstream tool) added locally would be wiped without
 * explicit rescue. We always preserve `CHANGELOG.md` (appended to by the
 * sync), drop the prior `.claudesync-state.json` (rewritten by the caller),
 * and copy back anything else in the stash matching the `preserve` glob list.
 */
async function writeFilesMode(
  bundle: import("../export/types.js").GitBundle,
  outputPath: string,
  preserve: readonly string[]
): Promise<void> {
  await replaceWithPreserve({
    outputPath,
    writeFresh: async () => {
      await exportToGit(bundle, outputPath);
      rmSync(path.join(outputPath, ".git"), { recursive: true, force: true });
    },
    alwaysPreserve: [CHANGELOG_FILENAME],
    alwaysDrop: [STATE_FILENAME],
    preserveGlobs: preserve,
  });
}

function ensureGitignore(repoDir: string): void {
  const gitignorePath = path.join(repoDir, ".gitignore");
  const line = STATE_FILENAME;
  let contents = "";
  if (fs.existsSync(gitignorePath)) {
    contents = fs.readFileSync(gitignorePath, "utf-8");
    if (contents.split(/\r?\n/).some((l) => l.trim() === line)) {
      return;
    }
    if (!contents.endsWith("\n")) contents += "\n";
  }
  contents += `${line}\n${STATE_FILENAME}.tmp\n`;
  fs.writeFileSync(gitignorePath, contents, "utf-8");
}

function writeStateFile(
  dir: string,
  summary: ConversationSummary,
  conversation: Conversation,
  artifacts: ArtifactListResponse,
  action: "full" | "incremental"
): void {
  const nodeMap = buildMessageTree(conversation.chat_messages);
  const leaves = findLeafMessages(nodeMap).map((m) => ({
    uuid: m.uuid,
    last_message_index: m.index,
  }));

  const state: SyncState = {
    schema_version: 1,
    conversation_uuid: conversation.uuid,
    conversation_name: conversation.name,
    updated_at: summary.updated_at,
    current_leaf_message_uuid: conversation.current_leaf_message_uuid ?? null,
    leaves,
    artifacts: artifacts.files_metadata.map((a) => ({
      path: a.path,
      size: a.size,
      created_at: a.created_at,
    })),
    last_sync_at: new Date().toISOString(),
    last_sync_action: action,
  };
  writeSyncState(dir, state);
}
