import { describe, expect, it } from "vitest";
import { formatConversation } from "../conversation-formatter.js";
import type { ChatMessage } from "../../models/types.js";

/**
 * Helper to create a minimal ChatMessage for testing.
 */
function makeMessage(
  uuid: string,
  sender: "human" | "assistant",
  text: string,
  createdAt = "2026-01-15T10:30:00Z"
): ChatMessage {
  return {
    uuid,
    parent_message_uuid: "sentinel",
    index: 0,
    sender,
    text,
    created_at: createdAt,
    updated_at: createdAt,
    attachments: [],
    files_v2: [],
    sync_sources: [],
  };
}

describe("formatConversation", () => {
  it("formats a simple human-assistant exchange", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "human", "Hello, Claude!"),
      makeMessage("a1", "assistant", "Hello! How can I help you?"),
    ];

    const result = formatConversation(messages);

    expect(result).toContain("## Human");
    expect(result).toContain("## Assistant");
    expect(result).toContain("Hello, Claude!");
    expect(result).toContain("Hello! How can I help you?");
  });

  it("includes timestamps for each message", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "human", "Hello", "2026-01-15T10:30:00Z"),
      makeMessage("a1", "assistant", "Hi", "2026-01-15T10:30:05Z"),
    ];

    const result = formatConversation(messages);

    expect(result).toContain("_2026-01-15T10:30:00Z_");
    expect(result).toContain("_2026-01-15T10:30:05Z_");
  });

  it("returns empty string for empty messages array", () => {
    const result = formatConversation([]);
    expect(result).toBe("");
  });

  it("handles empty message text gracefully", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "human", ""),
      makeMessage("a1", "assistant", "  "),
    ];

    const result = formatConversation(messages);

    // Both empty messages should render the placeholder
    expect(result).toContain("_[empty message]_");
    // Should appear twice (one for each empty/whitespace-only message)
    const matches = result.match(/_\[empty message\]_/g);
    expect(matches).toHaveLength(2);
  });

  it("preserves message ordering", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "human", "First message"),
      makeMessage("a1", "assistant", "Second message"),
      makeMessage("h2", "human", "Third message"),
    ];

    const result = formatConversation(messages);

    const firstIdx = result.indexOf("First message");
    const secondIdx = result.indexOf("Second message");
    const thirdIdx = result.indexOf("Third message");

    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it("formats a single message", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "human", "Just one message"),
    ];

    const result = formatConversation(messages);

    expect(result).toContain("## Human");
    expect(result).toContain("Just one message");
    expect(result).not.toContain("## Assistant");
  });

  it("trims whitespace from message text", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "human", "  padded text  \n\n"),
    ];

    const result = formatConversation(messages);

    expect(result).toContain("padded text");
    // The trimmed text should not have leading/trailing whitespace
    const lines = result.split("\n");
    const textLine = lines.find((l) => l.includes("padded text"));
    expect(textLine).toBe("padded text");
  });

  it("handles multi-line message text", () => {
    const messages: ChatMessage[] = [
      makeMessage(
        "a1",
        "assistant",
        "Here is some code:\n```typescript\nconst x = 1;\n```\nDone!"
      ),
    ];

    const result = formatConversation(messages);

    expect(result).toContain("```typescript");
    expect(result).toContain("const x = 1;");
  });
});
