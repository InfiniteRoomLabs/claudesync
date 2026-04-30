import { describe, expect, it } from "vitest";
import { diffConversation } from "../diff.js";
import type { SyncState } from "../state.js";
import type {
  ArtifactListResponse,
  ChatMessage,
  Conversation,
} from "../../models/types.js";

function msg(uuid: string, parent: string, index: number, text = ""): ChatMessage {
  return {
    uuid,
    parent_message_uuid: parent,
    index,
    sender: index % 2 === 0 ? "human" : "assistant",
    text: text || `m${index}`,
    created_at: `2026-04-30T13:50:0${index}Z`,
    updated_at: `2026-04-30T13:50:0${index}Z`,
    attachments: [],
    files_v2: [],
    sync_sources: [],
  };
}

function conv(messages: ChatMessage[], leaf: string, name = "c"): Conversation {
  return {
    uuid: "conv-1",
    name,
    model: "claude-haiku-4-5",
    created_at: "2026-04-30T13:50:00Z",
    updated_at: messages[messages.length - 1].created_at,
    current_leaf_message_uuid: leaf,
    chat_messages: messages,
    is_starred: false,
    is_temporary: false,
    summary: "",
    settings: {},
  } as Conversation;
}

const noArtifacts: ArtifactListResponse = {
  success: true,
  files: [],
  files_metadata: [],
};

describe("diffConversation", () => {
  it("treats missing prevState as initial sync", () => {
    const c = conv(
      [msg("a", "00000000", 0), msg("b", "a", 1)],
      "b",
    );
    const d = diffConversation(undefined, c, noArtifacts);
    expect(d.isInitial).toBe(true);
    expect(d.isUnchanged).toBe(false);
    expect(d.branches).toHaveLength(1);
    expect(d.branches[0].isMain).toBe(true);
    expect(d.branches[0].isNew).toBe(true);
  });

  it("flags unchanged when nothing differs", () => {
    const c = conv(
      [msg("a", "00000000", 0), msg("b", "a", 1)],
      "b",
    );
    const prev: SyncState = {
      schema_version: 1,
      conversation_uuid: "conv-1",
      conversation_name: "c",
      updated_at: c.updated_at,
      current_leaf_message_uuid: "b",
      leaves: [{ uuid: "b", last_message_index: 1 }],
      artifacts: [],
      last_sync_at: "2026-04-30T13:55:00Z",
      last_sync_action: "full",
    };
    const d = diffConversation(prev, c, noArtifacts);
    expect(d.isUnchanged).toBe(true);
    expect(d.branches[0].hasNewMessages).toBe(false);
  });

  it("treats a forward-moving leaf as 'new messages on existing branch', not a new branch", () => {
    const c = conv(
      [msg("a", "00000000", 0), msg("b", "a", 1), msg("c", "b", 2)],
      "c",
    );
    const prev: SyncState = {
      schema_version: 1,
      conversation_uuid: "conv-1",
      conversation_name: "c",
      updated_at: "2026-04-30T13:50:01Z",
      current_leaf_message_uuid: "b",
      leaves: [{ uuid: "b", last_message_index: 1 }],
      artifacts: [],
      last_sync_at: "2026-04-30T13:55:00Z",
      last_sync_action: "full",
    };
    const d = diffConversation(prev, c, noArtifacts);
    expect(d.isUnchanged).toBe(false);
    const cBranch = d.branches.find((br) => br.leafUuid === "c")!;
    expect(cBranch.isNew).toBe(false);
    expect(cBranch.hasNewMessages).toBe(true);
    expect(cBranch.newMessageIndices).toEqual([2]);
  });

  it("detects new orphan branch when the tree gains a sibling", () => {
    // Initial: a -> b. New: a -> b (orphan), a -> c (current).
    const c = conv(
      [
        msg("a", "00000000", 0),
        msg("b", "a", 1),
        msg("c", "a", 2),
      ],
      "c",
    );
    const prev: SyncState = {
      schema_version: 1,
      conversation_uuid: "conv-1",
      conversation_name: "c",
      updated_at: "2026-04-30T13:50:01Z",
      current_leaf_message_uuid: "b",
      leaves: [{ uuid: "b", last_message_index: 1 }],
      artifacts: [],
      last_sync_at: "2026-04-30T13:55:00Z",
      last_sync_action: "full",
    };
    const d = diffConversation(prev, c, noArtifacts);
    expect(d.isUnchanged).toBe(false);
    // c is the new main; b is now an alt that already existed -> not "new".
    expect(d.branches.find((br) => br.leafUuid === "c")!.isNew).toBe(true);
    expect(d.branches.find((br) => br.leafUuid === "b")!.isNew).toBe(false);
  });

  it("detects added/changed/removed artifacts", () => {
    const c = conv([msg("a", "00000000", 0)], "a");
    const artifacts: ArtifactListResponse = {
      success: true,
      files: ["/mnt/user-data/outputs/new.md", "/mnt/user-data/outputs/changed.md"],
      files_metadata: [
        { path: "/mnt/user-data/outputs/new.md", size: 10, content_type: "text/plain", created_at: "2026-04-30T00:00:01Z", custom_metadata: { filename: "new.md" } },
        { path: "/mnt/user-data/outputs/changed.md", size: 50, content_type: "text/plain", created_at: "2026-04-30T00:00:02Z", custom_metadata: { filename: "changed.md" } },
      ],
    };
    const prev: SyncState = {
      schema_version: 1,
      conversation_uuid: "conv-1",
      conversation_name: "c",
      updated_at: "2026-04-30T13:50:00Z",
      current_leaf_message_uuid: "a",
      leaves: [{ uuid: "a", last_message_index: 0 }],
      artifacts: [
        { path: "/mnt/user-data/outputs/changed.md", size: 25, created_at: "2026-04-30T00:00:00Z" },
        { path: "/mnt/user-data/outputs/gone.md", size: 5, created_at: "2026-04-30T00:00:00Z" },
      ],
      last_sync_at: "2026-04-30T13:55:00Z",
      last_sync_action: "full",
    };
    const d = diffConversation(prev, c, artifacts);
    expect(d.artifacts.added.map((a) => a.path)).toEqual(["/mnt/user-data/outputs/new.md"]);
    expect(d.artifacts.changed.map((a) => a.path)).toEqual(["/mnt/user-data/outputs/changed.md"]);
    expect(d.artifacts.removed.map((a) => a.path)).toEqual(["/mnt/user-data/outputs/gone.md"]);
  });

  it("detects rename in metadata", () => {
    const c = conv([msg("a", "00000000", 0)], "a", "new name");
    const prev: SyncState = {
      schema_version: 1,
      conversation_uuid: "conv-1",
      conversation_name: "old name",
      updated_at: "2026-04-30T13:50:00Z",
      current_leaf_message_uuid: "a",
      leaves: [{ uuid: "a", last_message_index: 0 }],
      artifacts: [],
      last_sync_at: "2026-04-30T13:55:00Z",
      last_sync_action: "full",
    };
    const d = diffConversation(prev, c, noArtifacts);
    expect(d.metadata.renamed).toEqual({ from: "old name", to: "new name" });
  });
});
