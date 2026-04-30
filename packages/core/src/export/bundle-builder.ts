import type { Conversation, ArtifactListResponse } from "../models/types.js";
import type { GitBundle, GitBundleCommit } from "./types.js";
import {
  buildMessageTree,
  getAllBranches,
  shortLeafLabel,
  findDivergencePoint,
} from "../tree/message-tree.js";
import { formatConversation } from "./conversation-formatter.js";
import { ClaudeSyncClient } from "../client/client.js";

export interface BuildGitBundleOptions {
  /** Git author name. Default: "Claude" */
  authorName?: string;
  /** Git author email. Default: "claude@anthropic.com" */
  authorEmail?: string;
  /** Include conversation.md and README.md in the first commit. Default: true */
  includeConversation?: boolean;
  /**
   * If true, emit one set of files per branch using the multi-branch layout
   * (current branch at the root, alts under branches/<short-uuid>/).
   * Default: false (legacy single-branch behavior).
   */
  multiBranch?: boolean;
}

/**
 * Builds a GitBundle from conversation data and downloaded artifact content.
 *
 * Single-branch mode (default): emits the linear current branch as
 * conversation.md + README.md plus optional artifacts under artifacts/.
 *
 * Multi-branch mode: also emits each alternate branch as
 * branches/<short-leaf>/conversation.md + README.md.
 *
 * The bundle stays format-agnostic: a writer (git-exporter or files) decides
 * how to materialize the file paths. For real git output, the writer maps
 * commits whose paths begin with `branches/<x>/` onto separate refs; for
 * files mode, the directory layout is taken literally.
 */
export function buildGitBundle(
  conversation: Conversation,
  artifacts: ArtifactListResponse,
  artifactContents: Map<string, string | Uint8Array>,
  options?: BuildGitBundleOptions
): GitBundle {
  const authorName = options?.authorName ?? "Claude";
  const authorEmail = options?.authorEmail ?? "claude@anthropic.com";
  const includeConversation = options?.includeConversation ?? true;
  const multiBranch = options?.multiBranch ?? false;

  const author = { name: authorName, email: authorEmail };
  const commits: GitBundleCommit[] = [];

  if (includeConversation) {
    const nodeMap = buildMessageTree(conversation.chat_messages);
    const branchMap = getAllBranches(nodeMap);
    const leafUuids = Array.from(branchMap.keys());
    const mainLeafUuid = conversation.current_leaf_message_uuid;

    // Determine the main branch to render at the root.
    let mainMessages = mainLeafUuid ? branchMap.get(mainLeafUuid) : undefined;
    if (!mainMessages) {
      // Fallback for conversations without a current_leaf or one that points
      // outside the loaded tree: take the first leaf or the flat message list.
      mainMessages =
        leafUuids.length > 0
          ? branchMap.get(leafUuids[0])!
          : conversation.chat_messages;
    }

    const rootFiles: Record<string, string | Uint8Array> = {
      "conversation.md": formatConversation(mainMessages),
      "README.md": buildReadme(conversation, mainMessages),
    };

    commits.push({
      message: `Export conversation: ${conversation.name}`,
      timestamp: conversation.created_at,
      author,
      files: rootFiles,
    });

    if (multiBranch) {
      const mainUuid = mainLeafUuid && branchMap.has(mainLeafUuid)
        ? mainLeafUuid
        : leafUuids[0];

      for (const [leafUuid, branchMessages] of branchMap) {
        if (leafUuid === mainUuid) continue;
        const label = shortLeafLabel(leafUuid, leafUuids);
        const divergence = findDivergencePoint(
          mainMessages,
          branchMessages
        );
        const dir = `branches/${label}/`;
        const branchFiles: Record<string, string | Uint8Array> = {
          [`${dir}conversation.md`]: formatConversation(branchMessages),
          [`${dir}README.md`]: buildBranchReadme(
            conversation,
            branchMessages,
            divergence
          ),
        };
        commits.push({
          message: `Export branch: alt-${label}`,
          timestamp:
            branchMessages[branchMessages.length - 1]?.created_at ??
            conversation.created_at,
          author,
          files: branchFiles,
        });
      }
    }
  }

  // Artifact commit (only if there are artifacts).
  if (artifacts.files_metadata.length > 0) {
    const artifactFiles: Record<string, string | Uint8Array> = {};
    for (const meta of artifacts.files_metadata) {
      const filename = ClaudeSyncClient.safeFilename(meta.path);
      const content = artifactContents.get(meta.path);
      if (content !== undefined) {
        artifactFiles[`artifacts/${filename}`] = content;
      }
    }
    if (Object.keys(artifactFiles).length > 0) {
      const count = Object.keys(artifactFiles).length;
      commits.push({
        message: `Add artifacts (${count} files)`,
        timestamp: artifacts.files_metadata[0].created_at,
        author,
        files: artifactFiles,
      });
    }
  }

  return {
    metadata: {
      conversationId: conversation.uuid,
      conversationName: conversation.name,
      model: conversation.model,
      createdAt: conversation.created_at,
      exportedAt: new Date().toISOString(),
    },
    commits,
  };
}

function buildReadme(
  conversation: Conversation,
  branch: import("../models/types.js").ChatMessage[]
): string {
  const lines: string[] = [];
  lines.push(`# ${conversation.name}`);
  lines.push("");
  lines.push(`- **Conversation ID:** ${conversation.uuid}`);
  lines.push(`- **Model:** ${conversation.model ?? "unknown"}`);
  lines.push(`- **Created:** ${conversation.created_at}`);
  lines.push(`- **Updated:** ${conversation.updated_at}`);
  lines.push(`- **Messages on current branch:** ${branch.length}`);
  if (conversation.is_starred) lines.push(`- **Starred:** yes`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("Exported by [ClaudeSync](https://github.com/infiniteroomlabs/claudesync)");
  lines.push("");
  return lines.join("\n");
}

function buildBranchReadme(
  conversation: Conversation,
  branch: import("../models/types.js").ChatMessage[],
  divergencePointUuid: string | undefined
): string {
  const leaf = branch[branch.length - 1];
  const lines: string[] = [];
  lines.push(`# ${conversation.name} -- alternate branch`);
  lines.push("");
  lines.push(`- **Conversation ID:** ${conversation.uuid}`);
  lines.push(`- **Branch leaf:** ${leaf?.uuid ?? "unknown"}`);
  lines.push(`- **Branch length:** ${branch.length} message(s)`);
  if (divergencePointUuid) {
    lines.push(`- **Divergence point:** ${divergencePointUuid}`);
  }
  lines.push("");
  lines.push(
    "This is an orphan/edited branch. The current branch lives at the root of this directory; this file lives under `branches/<short-leaf>/`.",
  );
  lines.push("");
  return lines.join("\n");
}
