import type {
  ArtifactListResponse,
  ChatMessage,
  Conversation,
} from "../models/types.js";
import {
  buildMessageTree,
  getAllBranches,
  shortLeafLabel,
} from "../tree/message-tree.js";
import type { SyncState } from "./state.js";

export interface BranchDiff {
  /** Leaf uuid identifying the branch. */
  leafUuid: string;
  /** Short label used for filesystem/git branch names (e.g. "019ddea7"). */
  shortLabel: string;
  /** True if the branch is the current/main branch (matches current_leaf_message_uuid). */
  isMain: boolean;
  /** True if the branch did not exist in the previous sync. */
  isNew: boolean;
  /** True if the branch existed but gained messages since last sync. */
  hasNewMessages: boolean;
  /** Indices of newly added messages on this branch (root->leaf order). */
  newMessageIndices: number[];
  /** Full root->leaf message array for the branch (always populated). */
  messages: ChatMessage[];
}

export interface ArtifactDiff {
  added: { path: string; size: number; created_at: string }[];
  changed: { path: string; size: number; created_at: string; prev_size: number; prev_created_at: string }[];
  removed: { path: string; size: number; created_at: string }[];
}

export interface MetadataDiff {
  renamed?: { from: string; to: string };
  modelChanged?: { from: string | null; to: string | null };
}

export interface ConversationDiff {
  /** True if there is no prior state (first sync of this conversation). */
  isInitial: boolean;
  /** True if state exists and nothing changed (caller may skip/log only). */
  isUnchanged: boolean;
  branches: BranchDiff[];
  artifacts: ArtifactDiff;
  metadata: MetadataDiff;
}

/**
 * Diffs a freshly fetched conversation (with full message tree from
 * ?tree=True) and its current artifact list against a previously stored
 * SyncState.
 *
 * If prevState is undefined the result describes an "initial" sync: every
 * branch is new, every artifact is added.
 */
export function diffConversation(
  prevState: SyncState | undefined,
  conversation: Conversation,
  artifacts: ArtifactListResponse
): ConversationDiff {
  const nodeMap = buildMessageTree(conversation.chat_messages);
  const branchMap = getAllBranches(nodeMap);
  const allLeafUuids = Array.from(branchMap.keys());

  const prevLeaves = new Map<string, number>();
  if (prevState) {
    for (const l of prevState.leaves) {
      prevLeaves.set(l.uuid, l.last_message_index);
    }
  }

  // For each current leaf, find the deepest ancestor that was a previous
  // leaf. If found, the current branch is an "extension" of that previous
  // branch (same conceptual branch, new messages). If not, it's a brand-new
  // branch. This avoids flagging "Branch main discovered" every time the
  // current leaf moves forward.
  const branches: BranchDiff[] = [];
  for (const [leafUuid, messages] of branchMap) {
    const exactMatchIndex = prevLeaves.get(leafUuid);
    let predecessorLeafUuid: string | undefined;
    let predecessorIndex: number | undefined;
    if (exactMatchIndex !== undefined) {
      predecessorLeafUuid = leafUuid;
      predecessorIndex = exactMatchIndex;
    } else {
      // Walk root->leaf and pick the deepest ancestor that was a previous leaf.
      for (const m of messages) {
        const idx = prevLeaves.get(m.uuid);
        if (idx !== undefined) {
          predecessorLeafUuid = m.uuid;
          predecessorIndex = idx;
        }
      }
    }
    const leafMsg = messages[messages.length - 1];
    const currentIndex = leafMsg?.index ?? -1;
    const isNew = predecessorLeafUuid === undefined;
    const hasNewMessages =
      !isNew && currentIndex > (predecessorIndex ?? -1);
    const newMessageIndices = isNew
      ? messages.map((m) => m.index)
      : messages
          .filter((m) => m.index > (predecessorIndex ?? -1))
          .map((m) => m.index);

    branches.push({
      leafUuid,
      shortLabel: shortLeafLabel(leafUuid, allLeafUuids),
      isMain: leafUuid === conversation.current_leaf_message_uuid,
      isNew,
      hasNewMessages,
      newMessageIndices,
      messages,
    });
  }

  // Sort: main first, then newest leaves first.
  branches.sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    const aLast = a.messages[a.messages.length - 1]?.created_at ?? "";
    const bLast = b.messages[b.messages.length - 1]?.created_at ?? "";
    return bLast.localeCompare(aLast);
  });

  // Artifacts
  const prevArtifacts = new Map<string, { size: number; created_at: string }>();
  if (prevState) {
    for (const a of prevState.artifacts) {
      prevArtifacts.set(a.path, { size: a.size, created_at: a.created_at });
    }
  }
  const currentArtifacts = new Map<string, { size: number; created_at: string }>();
  for (const a of artifacts.files_metadata) {
    currentArtifacts.set(a.path, { size: a.size, created_at: a.created_at });
  }

  const added: ArtifactDiff["added"] = [];
  const changed: ArtifactDiff["changed"] = [];
  const removed: ArtifactDiff["removed"] = [];

  for (const [p, info] of currentArtifacts) {
    const prev = prevArtifacts.get(p);
    if (!prev) {
      added.push({ path: p, ...info });
    } else if (prev.size !== info.size || prev.created_at !== info.created_at) {
      changed.push({
        path: p,
        size: info.size,
        created_at: info.created_at,
        prev_size: prev.size,
        prev_created_at: prev.created_at,
      });
    }
  }
  for (const [p, prev] of prevArtifacts) {
    if (!currentArtifacts.has(p)) {
      removed.push({ path: p, size: prev.size, created_at: prev.created_at });
    }
  }

  // Metadata
  const metadata: MetadataDiff = {};
  if (prevState && prevState.conversation_name !== conversation.name) {
    metadata.renamed = {
      from: prevState.conversation_name,
      to: conversation.name,
    };
  }
  // Note: we do not store the previous model in state v1 (could be added),
  // so model changes are only detected if state has it. Future-proof here.

  const isInitial = prevState === undefined;
  const isUnchanged =
    !isInitial &&
    branches.every((b) => !b.isNew && !b.hasNewMessages) &&
    added.length === 0 &&
    changed.length === 0 &&
    removed.length === 0 &&
    !metadata.renamed &&
    !metadata.modelChanged;

  return { isInitial, isUnchanged, branches, artifacts: { added, changed, removed }, metadata };
}
