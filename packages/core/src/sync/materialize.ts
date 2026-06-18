/**
 * Materialize a fetched+built conversation onto the local filesystem.
 *
 * Extracted verbatim from the back half of `syncConversation` so that both the
 * legacy orchestrators (`syncConversation` -> `runOrgSync`, project export) and
 * the new surface seam (`FileSink`) share ONE materialization path. Keeping a
 * single implementation is what makes the seam a zero-behavior-change refactor:
 * every caller runs the same git/files/json write, changelog append, gitignore,
 * and state-file logic in the same order.
 *
 * This function owns persistence only. Fetch + build (`fetchAndBuild`) and the
 * skip decisions stay with the caller.
 */

import fs from "node:fs";
import path from "node:path";
import { rmSync } from "node:fs";
import type {
  ArtifactListResponse,
  Conversation,
  ConversationSummary,
} from "../models/types.js";
import type { GitBundle } from "../export/types.js";
import { exportToGit, appendToGit } from "../export/git-exporter.js";
import { diffConversation } from "./diff.js";
import {
  appendChangelog,
  renderChangelogSection,
  CHANGELOG_FILENAME,
} from "./changelog.js";
import {
  writeSyncState,
  STATE_FILENAME,
  type SyncState,
} from "./state.js";
import { buildMessageTree, findLeafMessages } from "../tree/message-tree.js";
import { replaceWithPreserve } from "./files-mode.js";

export type ExportFormat = "git" | "files" | "json";

export interface MaterializeArgs {
  bundle: GitBundle;
  conversation: Conversation;
  artifacts: ArtifactListResponse;
  summary: ConversationSummary;
  /** Prior state for this output (drives changelog diff + full/incremental). */
  prevState: SyncState | undefined;
  /** Conversation directory (files/git) or the dir that holds `<slug>.json`. */
  outputPath: string;
  format: ExportFormat;
  preserve: readonly string[];
}

export interface MaterializeResult {
  action: "full" | "incremental";
  changelogWritten: boolean;
}

/**
 * Writes the conversation to `outputPath` in the requested format, appends a
 * changelog section if anything changed, and rewrites the sync-state sidecar.
 */
export async function materializeConversation(
  args: MaterializeArgs
): Promise<MaterializeResult> {
  const { bundle, conversation, artifacts, summary, prevState, outputPath, format, preserve } =
    args;

  const stateDir = format === "json" ? path.dirname(outputPath) : outputPath;
  const diff = diffConversation(prevState, conversation, artifacts);
  const action: "full" | "incremental" = prevState ? "incremental" : "full";

  // For json mode: bundle is the full snapshot, written as a single JSON file.
  if (format === "json") {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath + ".json", JSON.stringify(bundle, null, 2), "utf-8");
    writeStateFile(stateDir, summary, conversation, artifacts, action);
    return { action, changelogWritten: false };
  }

  const isFresh = !fs.existsSync(outputPath);

  if (format === "git") {
    if (isFresh) {
      await exportToGit(bundle, outputPath);
    } else {
      await appendToGit(bundle, outputPath);
    }
  } else {
    await writeFilesMode(bundle, outputPath, preserve);
  }

  let changelogWritten = false;
  const section = renderChangelogSection(diff, new Date());
  if (section) {
    appendChangelog(outputPath, section);
    changelogWritten = true;
  }

  if (format === "git") {
    ensureGitignore(outputPath);
  }

  writeStateFile(outputPath, summary, conversation, artifacts, action);

  return { action, changelogWritten };
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
  bundle: GitBundle,
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
    model: conversation.model ?? null,
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
