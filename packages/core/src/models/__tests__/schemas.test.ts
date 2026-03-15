import { describe, expect, it } from "vitest";
import {
  OrganizationSchema,
  ConversationSummarySchema,
  ConversationSettingsSchema,
  ChatMessageSchema,
  ConversationSchema,
  SearchResponseSchema,
  ArtifactFileMetadataSchema,
  ArtifactListResponseSchema,
} from "../schemas.js";

describe("OrganizationSchema", () => {
  it("parses a valid organization", () => {
    const data = {
      uuid: "abc-123",
      name: "My Org",
      capabilities: ["chat"],
      active_flags: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const result = OrganizationSchema.parse(data);
    expect(result.uuid).toBe("abc-123");
    expect(result.name).toBe("My Org");
  });

  it("preserves unknown fields via passthrough", () => {
    const data = {
      uuid: "abc-123",
      name: "My Org",
      capabilities: ["chat"],
      active_flags: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      rate_limit_tier: "default_claude_max_20x",
      billing_type: "stripe_subscription",
    };
    const result = OrganizationSchema.parse(data);
    expect((result as Record<string, unknown>).rate_limit_tier).toBe(
      "default_claude_max_20x"
    );
  });

  it("rejects missing uuid", () => {
    expect(() =>
      OrganizationSchema.parse({ name: "My Org" })
    ).toThrow();
  });
});

describe("ConversationSettingsSchema", () => {
  it("preserves unknown codename fields via passthrough", () => {
    const data = {
      enabled_web_search: true,
      enabled_bananagrams: true,
      enabled_sourdough: false,
      enabled_foccacia: true,
      enabled_compass: null,
      some_future_codename: "unknown_value",
    };
    const result = ConversationSettingsSchema.parse(data);
    expect(result.enabled_web_search).toBe(true);
    expect(
      (result as Record<string, unknown>).some_future_codename
    ).toBe("unknown_value");
  });
});

describe("ChatMessageSchema", () => {
  it("parses a valid message with parent_message_uuid", () => {
    const data = {
      uuid: "msg-1",
      text: "Hello",
      sender: "human",
      index: 0,
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      parent_message_uuid: "root",
      attachments: [],
      files_v2: [],
      sync_sources: [],
    };
    const result = ChatMessageSchema.parse(data);
    expect(result.sender).toBe("human");
    expect(result.parent_message_uuid).toBe("root");
  });

  it("accepts assistant sender with stop_reason", () => {
    const data = {
      uuid: "msg-2",
      text: "Hi there",
      sender: "assistant",
      index: 1,
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      parent_message_uuid: "msg-1",
      stop_reason: "end_turn",
      attachments: [],
      files_v2: [],
      sync_sources: [],
    };
    const result = ChatMessageSchema.parse(data);
    expect(result.sender).toBe("assistant");
    expect(result.stop_reason).toBe("end_turn");
  });

  it("rejects invalid sender", () => {
    const data = {
      uuid: "msg-3",
      text: "Bad",
      sender: "system",
      index: 0,
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      parent_message_uuid: "root",
      attachments: [],
      files_v2: [],
      sync_sources: [],
    };
    expect(() => ChatMessageSchema.parse(data)).toThrow();
  });
});

describe("ConversationSummarySchema", () => {
  it("parses with null model and current_leaf_message_uuid", () => {
    const data = {
      uuid: "conv-1",
      name: "Test Chat",
      model: null,
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      current_leaf_message_uuid: "leaf-1",
    };
    const result = ConversationSummarySchema.parse(data);
    expect(result.model).toBeNull();
    expect(result.current_leaf_message_uuid).toBe("leaf-1");
  });
});

describe("ConversationSchema", () => {
  it("parses a full conversation with messages", () => {
    const data = {
      uuid: "conv-1",
      name: "Test Chat",
      model: "claude-opus-4-6",
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      current_leaf_message_uuid: "msg-1",
      chat_messages: [
        {
          uuid: "msg-1",
          text: "Hello",
          sender: "human",
          index: 0,
          created_at: "2026-03-10T00:00:00Z",
          updated_at: "2026-03-10T00:00:00Z",
          parent_message_uuid: "root",
          attachments: [],
          files_v2: [],
          sync_sources: [],
        },
      ],
    };
    const result = ConversationSchema.parse(data);
    expect(result.chat_messages).toHaveLength(1);
  });
});

describe("SearchResponseSchema", () => {
  it("parses search results with extras", () => {
    const data = {
      chunks: [
        {
          doc_uuid: "doc-1",
          start: 0,
          end: 50,
          name: "Test Conv",
          text: "matching text",
          extras: {
            conversation_uuid: "conv-1",
            conversation_title: "Test Conv",
            doc_type: "conversation",
          },
        },
      ],
    };
    const result = SearchResponseSchema.parse(data);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].extras.conversation_uuid).toBe("conv-1");
  });
});

describe("ArtifactListResponseSchema", () => {
  it("parses wiggle list-files response", () => {
    const data = {
      success: true,
      files: ["/mnt/user-data/outputs/architecture.md"],
      files_metadata: [
        {
          path: "/mnt/user-data/outputs/architecture.md",
          size: 29446,
          content_type: "text/plain",
          created_at: "2026-03-12T23:08:39.328229Z",
          custom_metadata: { filename: "architecture.md" },
        },
      ],
    };
    const result = ArtifactListResponseSchema.parse(data);
    expect(result.success).toBe(true);
    expect(result.files_metadata).toHaveLength(1);
    expect(result.files_metadata[0].custom_metadata.filename).toBe(
      "architecture.md"
    );
  });
});
