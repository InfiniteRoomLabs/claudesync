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

/** On-disk export layout: a git repo, a flat file tree, or a single JSON blob. */
export type ExportFormat = "git" | "files" | "json";

/** Inputs to {@link materializeConversation}: the built data plus where/how to write it. */
export interface MaterializeArgs {
  /** Replayable git bundle (commits + metadata); the json snapshot source. */
  bundle: GitBundle;
  /** Full conversation, used for state-file leaves and changelog diffing. */
  conversation: Conversation;
  /** Artifact list, recorded in state and diffed for changelog entries. */
  artifacts: ArtifactListResponse;
  /** List-endpoint summary; supplies `updated_at` for the state file. */
  summary: ConversationSummary;
  /** Prior state for this output (drives changelog diff + full/incremental). */
  prevState: SyncState | undefined;
  /** Conversation directory (files/git) or the dir that holds `<slug>.json`. */
  outputPath: string;
  /** On-disk layout to produce: `git`, `files`, or `json`. */
  format: ExportFormat;
  /** Files-mode preserve globs, relative to the conversation directory. */
  preserve: readonly string[];
}

/** Outcome of {@link materializeConversation}: write kind and changelog status. */
export interface MaterializeResult {
  /** `full` on first write (no prior state), `incremental` on a re-sync. */
  action: "full" | "incremental";
  /** True when a CHANGELOG.md section was appended (never for json mode). */
  changelogWritten: boolean;
}

/**
 * Writes the conversation to `outputPath` in the requested format, appends a
 * changelog section if anything changed, and rewrites the sync-state sidecar.
 *
 * For `git`, exports a fresh repo when the output is new and replays onto the
 * existing one otherwise, then ensures the state file is gitignored. For
 * `files`, rebuilds the tree via {@link writeFilesMode}. For `json`, dumps a
 * single `<outputPath>.json` snapshot and skips the changelog entirely.
 *
 * @param args - Built bundle/conversation/artifacts plus output target and format.
 * @returns The action taken (`full` vs `incremental`) and whether a changelog wrote.
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
 *
 * @param bundle - Built bundle replayed into the directory via {@link exportToGit}.
 * @param outputPath - Conversation directory to (re)build.
 * @param preserve - POSIX globs of locally-added files to rescue across the rebuild.
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

/**
 * Idempotently add the sync-state sidecar (and its `.tmp`) to the repo's
 * `.gitignore`, so the local-only state file never lands in git history.
 * No-op when the line is already present.
 */
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

/**
 * Compute and persist the sync-state sidecar for this conversation. Snapshots
 * the leaf messages (from the rebuilt message tree), artifact metadata, the
 * server `updated_at`, and the current leaf uuid -- the inputs
 * {@link isSameByListMetadata} and {@link diffConversation} read on the next run.
 *
 * @param dir - Directory the state file is written into.
 * @param summary - List-endpoint summary supplying `updated_at`.
 * @param conversation - Full conversation; source of the message tree and leaves.
 * @param artifacts - Artifact list recorded for next-run diffing.
 * @param action - Whether this write was a full or incremental sync.
 */
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
