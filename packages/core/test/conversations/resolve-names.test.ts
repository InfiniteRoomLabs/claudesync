import { describe, it, expect } from "vitest";
import type { ChatMessage, Conversation, ConversationSummary } from "@core/models/types.js";
import {
  selectUnnamedConversations,
  planRename,
  classifyAmbiguousRename,
} from "@core/conversations/resolve-names.js";

/**
 * Builder for {@link ConversationSummary} fixtures. Mirrors the shape used by
 * `test/sync/empty.test.ts`'s `summary()` builder.
 *
 * @param uuid - The summary's own identifier.
 * @param name - The conversation's `name` field, as the list endpoint would send it.
 * @returns A fully populated {@link ConversationSummary} fixture.
 */
function summary(uuid: string, name: string): ConversationSummary {
  return {
    uuid,
    name,
    model: "claude-x",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
    current_leaf_message_uuid: `${uuid}-leaf`,
  };
}

/**
 * Builder for {@link ChatMessage} fixtures. Mirrors the shape used by
 * `test/sync/empty.test.ts` and `test/conversations/title.test.ts`.
 *
 * @param uuid - The message's own identifier.
 * @param parentUuid - The parent message's identifier; "" for a root message.
 * @param index - Ordinal position within the conversation.
 * @param sender - Who authored the message.
 * @param text - Rendered message text (pre-sanitization, as the API would send it).
 * @returns A fully populated {@link ChatMessage} fixture.
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
 * Builder for {@link Conversation} fixtures. Mirrors the shape used by
 * `test/conversations/title.test.ts`.
 *
 * @param uuid - The conversation's own identifier.
 * @param messages - The flat message array (all branches).
 * @param currentLeafMessageUuid - The active branch's tip; defaults to the
 *   last fixture message's uuid, or `null` when `messages` is empty.
 * @returns A fully populated {@link Conversation} fixture.
 */
function conversation(
  uuid: string,
  messages: ChatMessage[],
  currentLeafMessageUuid?: string | null,
): Conversation {
  return {
    uuid,
    name: "",
    model: "claude-x",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
    current_leaf_message_uuid:
      currentLeafMessageUuid !== undefined
        ? currentLeafMessageUuid
        : messages.length > 0
          ? messages[messages.length - 1]!.uuid
          : null,
    chat_messages: messages,
  };
}

describe("selectUnnamedConversations", () => {
  it("selects only summaries with an empty name", () => {
    const summaries = [summary("a", ""), summary("b", "Named Conversation"), summary("c", "")];
    const result = selectUnnamedConversations(summaries);
    expect(result.map((s) => s.uuid)).toEqual(["a", "c"]);
  });

  it("treats a whitespace-only name as unnamed", () => {
    const summaries = [summary("a", "   "), summary("b", "\t\n  "), summary("c", "Real Name")];
    const result = selectUnnamedConversations(summaries);
    expect(result.map((s) => s.uuid)).toEqual(["a", "b"]);
  });

  it("treats a null name as unnamed", () => {
    const summaries = [
      { ...summary("a", ""), name: null } as unknown as ConversationSummary,
      summary("b", "Named"),
    ];
    const result = selectUnnamedConversations(summaries);
    expect(result.map((s) => s.uuid)).toEqual(["a"]);
  });

  it("treats an undefined name as unnamed", () => {
    const summaries = [
      { ...summary("a", ""), name: undefined } as unknown as ConversationSummary,
      summary("b", "Named"),
    ];
    const result = selectUnnamedConversations(summaries);
    expect(result.map((s) => s.uuid)).toEqual(["a"]);
  });

  it("returns an empty array when no summaries are unnamed", () => {
    const summaries = [summary("a", "One"), summary("b", "Two")];
    expect(selectUnnamedConversations(summaries)).toEqual([]);
  });

  it("restricts to the ids in opts.ids, preserving summaries' order (not ids' order)", () => {
    const summaries = [summary("a", ""), summary("b", ""), summary("c", "")];
    const result = selectUnnamedConversations(summaries, { ids: ["c", "a"] });
    expect(result.map((s) => s.uuid)).toEqual(["a", "c"]);
  });

  it("drops unknown ids from opts.ids silently, with no error", () => {
    const summaries = [summary("a", ""), summary("b", "")];
    const result = selectUnnamedConversations(summaries, { ids: ["a", "does-not-exist"] });
    expect(result.map((s) => s.uuid)).toEqual(["a"]);
  });

  it("does not resurrect a named conversation just because its id is listed", () => {
    const summaries = [summary("a", ""), summary("b", "Named")];
    const result = selectUnnamedConversations(summaries, { ids: ["a", "b"] });
    expect(result.map((s) => s.uuid)).toEqual(["a"]);
  });

  it("applies opts.limit to the unfiltered unnamed set", () => {
    const summaries = [summary("a", ""), summary("b", ""), summary("c", "")];
    const result = selectUnnamedConversations(summaries, { limit: 2 });
    expect(result.map((s) => s.uuid)).toEqual(["a", "b"]);
  });

  it("applies opts.limit AFTER the opts.ids filter, not before", () => {
    const summaries = [summary("a", ""), summary("b", ""), summary("c", "")];
    // Without the ids filter, limit:1 would keep only "a". With ids narrowing
    // first to ["b", "c"], limit:1 must keep "b" (first of the narrowed set).
    const result = selectUnnamedConversations(summaries, { ids: ["b", "c"], limit: 1 });
    expect(result.map((s) => s.uuid)).toEqual(["b"]);
  });

  it("returns all matches when limit exceeds the match count", () => {
    const summaries = [summary("a", ""), summary("b", "")];
    const result = selectUnnamedConversations(summaries, { limit: 10 });
    expect(result.map((s) => s.uuid)).toEqual(["a", "b"]);
  });

  it("returns an empty array for an empty summaries input", () => {
    expect(selectUnnamedConversations([])).toEqual([]);
  });
});

describe("planRename", () => {
  it("returns a resolvable candidate with the derived title", () => {
    const messages = [message("m1", "", 0, "human", "Help me plan a trip to Kyoto")];
    const conv = conversation("conv-1", messages);
    expect(planRename(conv)).toEqual({
      uuid: "conv-1",
      title: "Help me plan a trip to Kyoto",
      status: "resolvable",
    });
  });

  it('returns "no-human-message" when chat_messages has no human sender', () => {
    const messages = [
      message("m1", "", 0, "assistant", "Hello, how can I help?"),
      message("m2", "m1", 1, "assistant", "Still here."),
    ];
    const conv = conversation("conv-2", messages);
    expect(planRename(conv)).toEqual({
      uuid: "conv-2",
      title: null,
      status: "unresolved",
      reason: "no-human-message",
    });
  });

  it('returns "no-human-message" for a conversation with zero messages', () => {
    const conv = conversation("conv-3", []);
    expect(planRename(conv)).toEqual({
      uuid: "conv-3",
      title: null,
      status: "unresolved",
      reason: "no-human-message",
    });
  });

  it('returns "empty-after-sanitize" when the human opener sanitizes to nothing', () => {
    const messages = [message("m1", "", 0, "human", "   \n  \t  ")];
    const conv = conversation("conv-4", messages);
    expect(planRename(conv)).toEqual({
      uuid: "conv-4",
      title: null,
      status: "unresolved",
      reason: "empty-after-sanitize",
    });
  });

  it('returns "empty-after-sanitize" for a markdown-only opener that sanitizes to nothing', () => {
    const messages = [message("m1", "", 0, "human", "###### **** ____")];
    const conv = conversation("conv-5", messages);
    expect(planRename(conv)).toEqual({
      uuid: "conv-5",
      title: null,
      status: "unresolved",
      reason: "empty-after-sanitize",
    });
  });
});

describe("classifyAmbiguousRename", () => {
  it('returns "applied" when the current name exactly matches desired', () => {
    expect(classifyAmbiguousRename("Trip to Kyoto", "Trip to Kyoto")).toBe("applied");
  });

  it('returns "failed" when current is null', () => {
    expect(classifyAmbiguousRename(null, "Trip to Kyoto")).toBe("failed");
  });

  it('returns "failed" when current is undefined', () => {
    expect(classifyAmbiguousRename(undefined, "Trip to Kyoto")).toBe("failed");
  });

  it('returns "failed" when current is an empty string', () => {
    expect(classifyAmbiguousRename("", "Trip to Kyoto")).toBe("failed");
  });

  it('returns "failed" when current is whitespace-only', () => {
    expect(classifyAmbiguousRename("   \t\n", "Trip to Kyoto")).toBe("failed");
  });

  it('returns "concurrent-edit" for any other non-empty current name', () => {
    expect(classifyAmbiguousRename("Someone Else's Title", "Trip to Kyoto")).toBe("concurrent-edit");
  });

  it('prefers "applied" over "failed" when desired itself is whitespace-only and current matches exactly', () => {
    expect(classifyAmbiguousRename("   ", "   ")).toBe("applied");
  });
});
