import type { Conversation, ArtifactListResponse } from "../models/types.js";
import type { GitBundle, GitBundleCommit } from "./types.js";
import { buildMessageTree, getLinearBranch } from "../tree/message-tree.js";
import { formatConversation } from "./conversation-formatter.js";
import { ClaudeSyncClient } from "../client/client.js";

export interface BuildGitBundleOptions {
  /** Git author name. Default: "Claude" */
  authorName?: string;
  /** Git author email. Default: "claude@anthropic.com" */
  authorEmail?: string;
  /** Include conversation.md and README.md in the first commit. Default: true */
  includeConversation?: boolean;
}

/**
 * Builds a GitBundle from conversation data and downloaded artifact content.
 *
 * The bundle contains 1 or 2 commits:
 * - Commit 1 (if includeConversation is true): conversation.md + README.md
 * - Commit 2 (if artifacts exist): all artifact files under artifacts/
 *
 * @param conversation - Full conversation with chat_messages
 * @param artifacts - Artifact list response from the wiggle API
 * @param artifactContents - Map of artifact path -> downloaded content
 * @param options - Optional overrides for author name/email and conversation inclusion
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

  const author = { name: authorName, email: authorEmail };

  const commits: GitBundleCommit[] = [];

  // Commit 1: conversation text + metadata README
  if (includeConversation) {
    const nodeMap = buildMessageTree(conversation.chat_messages);
    const leafUuid = conversation.current_leaf_message_uuid;
    const linearMessages = leafUuid
      ? getLinearBranch(nodeMap, leafUuid)
      : conversation.chat_messages;

    const conversationMd = formatConversation(linearMessages);
    const readmeMd = buildReadme(conversation);

    const files: Record<string, string | Uint8Array> = {
      "conversation.md": conversationMd,
      "README.md": readmeMd,
    };

    commits.push({
      message: `Export conversation: ${conversation.name}`,
      timestamp: conversation.created_at,
      author,
      files,
    });
  }

  // Commit 2: artifact files (only if there are artifacts)
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

/**
 * Builds a README.md with conversation metadata.
 */
function buildReadme(conversation: Conversation): string {
  const lines: string[] = [];
  lines.push(`# ${conversation.name}`);
  lines.push("");
  lines.push(`- **Conversation ID:** ${conversation.uuid}`);
  lines.push(`- **Model:** ${conversation.model ?? "unknown"}`);
  lines.push(`- **Created:** ${conversation.created_at}`);
  lines.push(`- **Updated:** ${conversation.updated_at}`);
  if (conversation.is_starred) {
    lines.push(`- **Starred:** yes`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("Exported by [ClaudeSync](https://github.com/infiniteroomlabs/claudesync)");
  lines.push("");
  return lines.join("\n");
}
