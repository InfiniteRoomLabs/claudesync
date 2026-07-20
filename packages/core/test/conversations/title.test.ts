import { describe, it, expect } from "vitest";
import type { ChatMessage, Conversation } from "@core/models/types.js";
import { deriveConversationTitle, MAX_TITLE_GRAPHEMES } from "@core/conversations/title.js";

/**
 * Builder for {@link ChatMessage} fixtures. Mirrors the shape produced by
 * `buildMessageTree`'s consumers (see `test/sync/empty.test.ts`), with every
 * required field populated so schema-shaped fixtures stay realistic.
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
 * Builder for {@link Conversation} fixtures used by the title-derivation tests.
 *
 * @param messages - The flat message array (all branches).
 * @param currentLeafMessageUuid - The active branch's tip; defaults to the
 *   last fixture message's uuid, or `null` when `messages` is empty.
 * @returns A fully populated {@link Conversation} fixture.
 */
function conversation(
  messages: ChatMessage[],
  currentLeafMessageUuid?: string | null,
): Conversation {
  return {
    uuid: "conv-uuid",
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

// Every non-ASCII code point used by the corpus below is built via
// String.fromCharCode/fromCodePoint (never a literal byte in this source
// file), per the repo's ASCII-only-source convention.
/** ESC (U+001B), the control byte that opens every ANSI/OSC escape sequence. */
const ESC = String.fromCharCode(0x1b);
/** BEL (U+0007), one valid OSC terminator. */
const BEL = String.fromCharCode(0x07);
/** ZERO WIDTH JOINER (U+200D), used to fuse emoji into one grapheme cluster. */
const ZWJ = String.fromCharCode(0x200d);
/** LEFT-TO-RIGHT ISOLATE (U+2066), a bidi control character. */
const LRI = String.fromCharCode(0x2066);
/** RIGHT-TO-LEFT EMBEDDING (U+202B), a bidi control character. */
const RLE = String.fromCharCode(0x202b);
/** POP DIRECTIONAL FORMATTING (U+202C), closes an RLE/LRE embedding. */
const PDF = String.fromCharCode(0x202c);
/** POP DIRECTIONAL ISOLATE (U+2069), closes an LRI/RLI/FSI isolate. */
const PDI = String.fromCharCode(0x2069);
/** Hebrew "shalom" (U+05E9 U+05DC U+05D5 U+05DD), an RTL test string. */
const HEBREW_SHALOM = String.fromCharCode(0x05e9, 0x05dc, 0x05d5, 0x05dd);
/** CJK pair (U+4E2D U+6587, "Chinese text"), a hard-cut grapheme test string. */
const CJK_PAIR = String.fromCharCode(0x4e2d, 0x6587);
/** Family emoji (man-woman-girl-boy joined by ZWJ): one grapheme cluster built from four astral-plane code points. */
const FAMILY_EMOJI =
  String.fromCodePoint(0x1f468) +
  ZWJ +
  String.fromCodePoint(0x1f469) +
  ZWJ +
  String.fromCodePoint(0x1f467) +
  ZWJ +
  String.fromCodePoint(0x1f466);

describe("deriveConversationTitle", () => {
  it("passes a plain sentence through unchanged", () => {
    const messages = [message("m1", "", 0, "human", "What is the best way to learn TypeScript?")];
    const conv = conversation(messages);
    expect(deriveConversationTitle(conv)).toBe("What is the best way to learn TypeScript?");
  });

  it("returns null for a code-only opener (unterminated fence, no other text)", () => {
    const messages = [message("m1", "", 0, "human", "```python\nprint('hello')")];
    const conv = conversation(messages);
    expect(deriveConversationTitle(conv)).toBeNull();
  });

  it("keeps only the prose when a closed fence precedes it", () => {
    const messages = [
      message(
        "m1",
        "",
        0,
        "human",
        "```js\nconst x = 1;\n``` What should I name my new pet hamster?",
      ),
    ];
    const conv = conversation(messages);
    expect(deriveConversationTitle(conv)).toBe("What should I name my new pet hamster?");
  });

  it("sanitizes ANSI/OSC-laced text and truncates at a word boundary", () => {
    // OSC title-set (BEL-terminated) followed by CSI SGR color codes.
    const text =
      `${ESC}]0;terminal-title${BEL}${ESC}[1;31mERROR${ESC}[0m ` +
      "Failed to connect to the remote host, please check network connectivity and retry the operation after a short delay";
    const messages = [message("m1", "", 0, "human", text)];
    const conv = conversation(messages);
    const result = deriveConversationTitle(conv);
    expect(result).not.toBeNull();
    // No raw escape bytes survive sanitization.
    expect(result!.includes(ESC)).toBe(false);
    // Text content is preserved (only the escape codes were stripped).
    expect(result).toContain("Failed to connect");
    // Truncation respects the grapheme cap.
    const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
    expect(Array.from(segmenter.segment(result!)).length).toBeLessThanOrEqual(MAX_TITLE_GRAPHEMES);
    // Never trims to a dangling space.
    expect(result).not.toMatch(/\s$/);
  });

  it("truncates on the last word boundary past grapheme 20, dropping the trailing partial word", () => {
    const text = "word ".repeat(15); // 75 chars; first 60 chars are exactly 12 whole "word " tokens
    const messages = [message("m1", "", 0, "human", text)];
    const conv = conversation(messages);
    const expected = Array.from({ length: 12 }, () => "word").join(" ");
    expect(deriveConversationTitle(conv)).toBe(expected);
  });

  it("only considers the first 1024 characters before sanitization (unterminated fence within the window)", () => {
    // The opening fence sits well before char 1024, but its matching closer
    // sits well after. If truncation happened AFTER sanitization instead of
    // before, the fence would resolve as CLOSED and its content would be
    // stripped as a unit, leaving the trailing prose intact. Truncating to
    // 1024 chars FIRST means the closer is never seen, so the fence reads as
    // unterminated and everything from the opener onward (within the 1024
    // window) is dropped -- including the trailing prose.
    const prefix = "Some question: ";
    const opener = "```\n";
    const filler = "x".repeat(2000);
    const closer = "\n``` more prose after fence";
    const text = prefix + opener + filler + closer;
    const messages = [message("m1", "", 0, "human", text)];
    const conv = conversation(messages);
    expect(deriveConversationTitle(conv)).toBe("Some question:");
  });

  it("does not split an emoji grapheme cluster sitting on the 60-grapheme boundary", () => {
    const text = "x".repeat(59) + FAMILY_EMOJI + "y".repeat(10); // no spaces anywhere
    const messages = [message("m1", "", 0, "human", text)];
    const conv = conversation(messages);
    const result = deriveConversationTitle(conv);
    // Exact equality proves the full, intact cluster survived at the tail --
    // a split cluster (e.g. a lone leading surrogate) could never match this.
    expect(result).toBe("x".repeat(59) + FAMILY_EMOJI);
    const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
    expect(Array.from(segmenter.segment(result!)).length).toBe(MAX_TITLE_GRAPHEMES);
  });

  it("hard-cuts a CJK string with no word boundaries at exactly 60 graphemes", () => {
    const text = CJK_PAIR.repeat(40); // 80 CJK chars, no spaces
    const messages = [message("m1", "", 0, "human", text)];
    const conv = conversation(messages);
    const expected = text.slice(0, MAX_TITLE_GRAPHEMES);
    const result = deriveConversationTitle(conv);
    expect(result).toBe(expected);
    const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
    expect(Array.from(segmenter.segment(result!)).length).toBe(MAX_TITLE_GRAPHEMES);
  });

  it("strips bidi control characters but keeps RTL text", () => {
    // Nested bidi isolate/embedding controls around Hebrew "shalom".
    const text = `${LRI}${RLE}${HEBREW_SHALOM}${PDF}${PDI}`;
    const messages = [message("m1", "", 0, "human", text)];
    const conv = conversation(messages);
    expect(deriveConversationTitle(conv)).toBe(HEBREW_SHALOM);
  });

  it("returns null for whitespace-only text", () => {
    const messages = [message("m1", "", 0, "human", "   \n\t  ")];
    const conv = conversation(messages);
    expect(deriveConversationTitle(conv)).toBeNull();
  });

  it("returns null for markdown-only text that sanitizes to nothing", () => {
    const messages = [message("m1", "", 0, "human", "###### **** ____")];
    const conv = conversation(messages);
    expect(deriveConversationTitle(conv)).toBeNull();
  });

  it("returns null for an attachment-only human message (empty text)", () => {
    const messages = [message("m1", "", 0, "human", "")];
    const conv = conversation(messages);
    expect(deriveConversationTitle(conv)).toBeNull();
  });

  it("returns null for an assistant-only conversation", () => {
    const messages = [message("m1", "", 0, "assistant", "Hello, how can I help?")];
    const conv = conversation(messages);
    expect(deriveConversationTitle(conv)).toBeNull();
  });

  it("selects the active branch's first human message, not the abandoned branch's", () => {
    // Two independent roots (both parent_message_uuid === ""), as produced by
    // editing/regenerating the very first prompt in a conversation.
    const messages = [
      message("m1", "", 0, "human", "Abandoned branch: tell me about cats"),
      message("m2", "m1", 1, "assistant", "cats info"),
      message("m3", "", 0, "human", "Active branch: tell me about dogs"),
      message("m4", "m3", 1, "assistant", "dogs info"),
    ];
    const conv = conversation(messages, "m4");
    expect(deriveConversationTitle(conv)).toBe("Active branch: tell me about dogs");
  });

  it("falls back to array-order earliest human when the leaf uuid is not in the tree", () => {
    const messages = [
      message("m1", "", 0, "assistant", "assistant opening"),
      message("m2", "m1", 1, "human", "first human message via array order"),
      message("m3", "m2", 2, "assistant", "assistant reply"),
    ];
    const conv = conversation(messages, "does-not-exist-uuid");
    expect(deriveConversationTitle(conv)).toBe("first human message via array order");
  });

  it("falls back to array-order earliest human when the leaf uuid is null", () => {
    const messages = [
      message("m1", "", 0, "assistant", "assistant opening"),
      message("m2", "m1", 1, "human", "first human message via array order"),
    ];
    const conv = conversation(messages, null);
    expect(deriveConversationTitle(conv)).toBe("first human message via array order");
  });

  it("is deterministic for the same input", () => {
    const text = "word ".repeat(15);
    const messages = [message("m1", "", 0, "human", text)];
    const conv = conversation(messages);
    expect(deriveConversationTitle(conv)).toBe(deriveConversationTitle(conv));
  });
});
