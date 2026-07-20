import { describe, it, expect } from "vitest";
import type { ChatMessage, Conversation, ConversationSummary } from "@core/models/types.js";
import { isEmptyConversation, summaryLooksEmpty, decideEmptyAction } from "@core/sync/empty.js";

/**
 * Builder for ChatMessage fixtures.
 */
function message(
  uuid: string,
  parentUuid: string,
  index: number,
  sender: "human" | "assistant",
  text: string,
): ChatMessage {
  return {
    uuid,
    text,
    sender,
    index,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    parent_message_uuid: parentUuid,
    attachments: [],
    files_v2: [],
    sync_sources: [],
  };
}

/**
 * Builder for Conversation fixtures.
 */
function conversation(uuid: string, name: string, messages: ChatMessage[]): Conversation {
  return {
    uuid,
    name,
    model: "claude-x",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
    current_leaf_message_uuid: messages.length > 0 ? messages[messages.length - 1].uuid : null,
    chat_messages: messages,
  };
}

/**
 * Builder for ConversationSummary fixtures.
 */
function summary(uuid: string, currentLeafMessageUuid: string | null): ConversationSummary {
  return {
    uuid,
    name: "Test Conversation",
    model: "claude-x",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
    current_leaf_message_uuid: currentLeafMessageUuid,
  };
}

describe("isEmptyConversation", () => {
  it("returns true for zero messages", () => {
    const conv = conversation("conv-1", "Empty", []);
    expect(isEmptyConversation(conv)).toBe(true);
  });

  it("returns true for assistant-only messages", () => {
    const messages = [
      message("msg-1", "", 0, "assistant", "Hello, how can I help?"),
      message("msg-2", "msg-1", 1, "assistant", "More info."),
    ];
    const conv = conversation("conv-2", "Assistant Only", messages);
    expect(isEmptyConversation(conv)).toBe(true);
  });

  it("returns false when at least one human message exists", () => {
    const messages = [
      message("msg-1", "", 0, "human", "Hello"),
      message("msg-2", "msg-1", 1, "assistant", "Hi there"),
    ];
    const conv = conversation("conv-3", "Has Human", messages);
    expect(isEmptyConversation(conv)).toBe(false);
  });

  it("returns false for whitespace-only human message", () => {
    const messages = [message("msg-1", "", 0, "human", "   \n  \t  ")];
    const conv = conversation("conv-4", "Whitespace Human", messages);
    expect(isEmptyConversation(conv)).toBe(false);
  });

  it("returns false when human exists on abandoned branch (non-leaf)", () => {
    // Two branches:
    // Branch 1 (abandoned): msg-1 (human) -> msg-2 (assistant)
    // Branch 2 (active/leaf): msg-1 (human) -> msg-3 (assistant)
    // current_leaf_message_uuid = "msg-3"
    // chat_messages is the flat array containing all messages from both branches
    const messages = [
      message("msg-1", "", 0, "human", "Hello"),
      message("msg-2", "msg-1", 1, "assistant", "Branch 1 response"),
      message("msg-3", "msg-1", 1, "assistant", "Branch 2 response"),
    ];
    const conv = conversation("conv-5", "Two Branches with Human", messages);
    expect(isEmptyConversation(conv)).toBe(false);
  });
});

describe("summaryLooksEmpty", () => {
  it("returns true when current_leaf_message_uuid is null", () => {
    const sum = summary("conv-1", null);
    expect(summaryLooksEmpty(sum)).toBe(true);
  });

  it("returns true when current_leaf_message_uuid is undefined", () => {
    const sum = summary("conv-2", undefined as unknown as string | null);
    expect(summaryLooksEmpty(sum)).toBe(true);
  });

  it("returns false when current_leaf_message_uuid is a valid uuid string", () => {
    const sum = summary("conv-3", "leaf-msg-uuid-1");
    expect(summaryLooksEmpty(sum)).toBe(false);
  });
});

describe("decideEmptyAction", () => {
  describe("when hasPriorState is false", () => {
    it('returns "skip" for policy "sync"', () => {
      expect(decideEmptyAction(false, "sync")).toBe("skip");
    });

    it('returns "skip" for policy "retain"', () => {
      expect(decideEmptyAction(false, "retain")).toBe("skip");
    });

    it('returns "skip" for policy "clean"', () => {
      expect(decideEmptyAction(false, "clean")).toBe("skip");
    });
  });

  describe("when hasPriorState is true", () => {
    it('returns "materialize-full" for policy "sync"', () => {
      expect(decideEmptyAction(true, "sync")).toBe("materialize-full");
    });

    it('returns "retain" for policy "retain"', () => {
      expect(decideEmptyAction(true, "retain")).toBe("retain");
    });

    it('returns "clean" for policy "clean"', () => {
      expect(decideEmptyAction(true, "clean")).toBe("clean");
    });
  });
});
