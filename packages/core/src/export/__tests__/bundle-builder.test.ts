import { describe, expect, it } from "vitest";
import { buildGitBundle } from "../bundle-builder.js";
import type {
  Conversation,
  ArtifactListResponse,
  ChatMessage,
} from "../../models/types.js";

/**
 * Helper to create a minimal ChatMessage for testing.
 */
function makeMessage(
  uuid: string,
  parentUuid: string,
  index: number,
  sender: "human" | "assistant",
  text = `Message ${uuid}`
): ChatMessage {
  return {
    uuid,
    parent_message_uuid: parentUuid,
    index,
    sender,
    text,
    created_at: "2026-01-15T10:30:00Z",
    updated_at: "2026-01-15T10:30:00Z",
    attachments: [],
    files_v2: [],
    sync_sources: [],
  };
}

/**
 * Helper to create a minimal Conversation for testing.
 */
function makeConversation(
  messages: ChatMessage[],
  leafUuid: string | null = null,
  name = "Test Conversation"
): Conversation {
  return {
    uuid: "conv-123",
    name,
    model: "claude-opus-4-6",
    created_at: "2026-01-15T10:00:00Z",
    updated_at: "2026-01-15T11:00:00Z",
    current_leaf_message_uuid: leafUuid,
    chat_messages: messages,
  };
}

/**
 * Helper to create an ArtifactListResponse.
 */
function makeArtifacts(
  files: Array<{ path: string; filename: string; size?: number }>
): ArtifactListResponse {
  return {
    success: true,
    files: files.map((f) => f.path),
    files_metadata: files.map((f) => ({
      path: f.path,
      size: f.size ?? 100,
      content_type: "text/plain",
      created_at: "2026-01-15T10:35:00Z",
      custom_metadata: { filename: f.filename },
    })),
  };
}

const emptyArtifacts: ArtifactListResponse = {
  success: true,
  files: [],
  files_metadata: [],
};

describe("buildGitBundle", () => {
  it("produces correct structure with 2 commits when conversation and artifacts exist", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "sentinel", 0, "human", "Hello"),
      makeMessage("a1", "h1", 1, "assistant", "Hi there!"),
    ];

    const conversation = makeConversation(messages, "a1");

    const artifacts = makeArtifacts([
      {
        path: "/mnt/user-data/outputs/app.tsx",
        filename: "app.tsx",
      },
      {
        path: "/mnt/user-data/outputs/styles.css",
        filename: "styles.css",
      },
    ]);

    const contents = new Map<string, string | Uint8Array>();
    contents.set("/mnt/user-data/outputs/app.tsx", "export default function App() {}");
    contents.set("/mnt/user-data/outputs/styles.css", "body { margin: 0; }");

    const bundle = buildGitBundle(conversation, artifacts, contents);

    // Metadata
    expect(bundle.metadata.conversationId).toBe("conv-123");
    expect(bundle.metadata.conversationName).toBe("Test Conversation");
    expect(bundle.metadata.model).toBe("claude-opus-4-6");
    expect(bundle.metadata.createdAt).toBe("2026-01-15T10:00:00Z");
    expect(bundle.metadata.exportedAt).toBeTruthy();

    // Should have exactly 2 commits
    expect(bundle.commits).toHaveLength(2);

    // Commit 1: conversation + README
    const commit1 = bundle.commits[0];
    expect(commit1.message).toBe("Export conversation: Test Conversation");
    expect(commit1.files).toHaveProperty("conversation.md");
    expect(commit1.files).toHaveProperty("README.md");
    expect(commit1.author.name).toBe("Claude");
    expect(commit1.author.email).toBe("claude@anthropic.com");

    // Commit 2: artifacts
    const commit2 = bundle.commits[1];
    expect(commit2.message).toBe("Add artifacts (2 files)");
    expect(commit2.files).toHaveProperty("artifacts/app.tsx");
    expect(commit2.files).toHaveProperty("artifacts/styles.css");
    expect(commit2.files["artifacts/app.tsx"]).toBe(
      "export default function App() {}"
    );
    expect(commit2.files["artifacts/styles.css"]).toBe(
      "body { margin: 0; }"
    );
  });

  it("conversation.md contains formatted messages from linear branch", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "sentinel", 0, "human", "Can you write a function?"),
      makeMessage("a1", "h1", 1, "assistant", "Sure, here you go!"),
    ];

    const conversation = makeConversation(messages, "a1");
    const bundle = buildGitBundle(conversation, emptyArtifacts, new Map());

    const conversationMd = bundle.commits[0].files["conversation.md"] as string;

    expect(conversationMd).toContain("## Human");
    expect(conversationMd).toContain("Can you write a function?");
    expect(conversationMd).toContain("## Assistant");
    expect(conversationMd).toContain("Sure, here you go!");
  });

  it("handles conversations with no artifacts (1 commit only)", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "sentinel", 0, "human", "Just chatting"),
      makeMessage("a1", "h1", 1, "assistant", "Me too!"),
    ];

    const conversation = makeConversation(messages, "a1");
    const bundle = buildGitBundle(conversation, emptyArtifacts, new Map());

    expect(bundle.commits).toHaveLength(1);
    expect(bundle.commits[0].message).toBe(
      "Export conversation: Test Conversation"
    );
    expect(bundle.commits[0].files).toHaveProperty("conversation.md");
    expect(bundle.commits[0].files).toHaveProperty("README.md");
  });

  it("uses path.basename for artifact filenames (security)", () => {
    const artifacts = makeArtifacts([
      {
        path: "/mnt/user-data/outputs/../../etc/passwd",
        filename: "passwd",
      },
    ]);

    const contents = new Map<string, string | Uint8Array>();
    contents.set("/mnt/user-data/outputs/../../etc/passwd", "not really");

    const messages: ChatMessage[] = [
      makeMessage("h1", "sentinel", 0, "human", "test"),
    ];
    const conversation = makeConversation(messages, "h1");
    const bundle = buildGitBundle(conversation, artifacts, contents);

    // Should use basename, not the full traversal path
    const artifactCommit = bundle.commits[1];
    expect(artifactCommit.files).toHaveProperty("artifacts/passwd");
    expect(artifactCommit.files).not.toHaveProperty(
      "artifacts/../../etc/passwd"
    );
  });

  it("respects custom author name and email", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "sentinel", 0, "human", "Hello"),
    ];
    const conversation = makeConversation(messages, "h1");
    const bundle = buildGitBundle(conversation, emptyArtifacts, new Map(), {
      authorName: "Wes",
      authorEmail: "wes@example.com",
    });

    expect(bundle.commits[0].author.name).toBe("Wes");
    expect(bundle.commits[0].author.email).toBe("wes@example.com");
  });

  it("skips conversation commit when includeConversation is false", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "sentinel", 0, "human", "Hello"),
    ];
    const conversation = makeConversation(messages, "h1");

    const artifacts = makeArtifacts([
      {
        path: "/mnt/user-data/outputs/code.py",
        filename: "code.py",
      },
    ]);

    const contents = new Map<string, string | Uint8Array>();
    contents.set("/mnt/user-data/outputs/code.py", "print('hi')");

    const bundle = buildGitBundle(conversation, artifacts, contents, {
      includeConversation: false,
    });

    // Only the artifacts commit
    expect(bundle.commits).toHaveLength(1);
    expect(bundle.commits[0].message).toBe("Add artifacts (1 files)");
  });

  it("skips artifacts whose content was not downloaded", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "sentinel", 0, "human", "Hello"),
    ];
    const conversation = makeConversation(messages, "h1");

    const artifacts = makeArtifacts([
      {
        path: "/mnt/user-data/outputs/downloaded.ts",
        filename: "downloaded.ts",
      },
      {
        path: "/mnt/user-data/outputs/missing.ts",
        filename: "missing.ts",
      },
    ]);

    // Only provide content for one of the two artifacts
    const contents = new Map<string, string | Uint8Array>();
    contents.set("/mnt/user-data/outputs/downloaded.ts", "const x = 1;");

    const bundle = buildGitBundle(conversation, artifacts, contents);

    const artifactCommit = bundle.commits[1];
    expect(artifactCommit.message).toBe("Add artifacts (1 files)");
    expect(artifactCommit.files).toHaveProperty("artifacts/downloaded.ts");
    expect(artifactCommit.files).not.toHaveProperty("artifacts/missing.ts");
  });

  it("handles Uint8Array content for binary artifacts", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "sentinel", 0, "human", "Hello"),
    ];
    const conversation = makeConversation(messages, "h1");

    const artifacts = makeArtifacts([
      {
        path: "/mnt/user-data/outputs/image.png",
        filename: "image.png",
      },
    ]);

    const binaryContent = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const contents = new Map<string, string | Uint8Array>();
    contents.set("/mnt/user-data/outputs/image.png", binaryContent);

    const bundle = buildGitBundle(conversation, artifacts, contents);

    const artifactCommit = bundle.commits[1];
    expect(artifactCommit.files["artifacts/image.png"]).toBeInstanceOf(
      Uint8Array
    );
    expect(artifactCommit.files["artifacts/image.png"]).toEqual(binaryContent);
  });

  it("follows current_leaf_message_uuid for branch selection", () => {
    // Create a branching conversation
    const messages: ChatMessage[] = [
      makeMessage("root", "sentinel", 0, "human", "Start"),
      makeMessage("a1", "root", 1, "assistant", "Response"),
      // Branch A
      makeMessage("h2-a", "a1", 2, "human", "Branch A question"),
      makeMessage("a3-a", "h2-a", 3, "assistant", "Branch A answer"),
      // Branch B (current leaf)
      makeMessage("h2-b", "a1", 4, "human", "Branch B question"),
      makeMessage("a3-b", "h2-b", 5, "assistant", "Branch B answer"),
    ];

    // current_leaf_message_uuid points to branch B
    const conversation = makeConversation(messages, "a3-b");
    const bundle = buildGitBundle(conversation, emptyArtifacts, new Map());

    const conversationMd = bundle.commits[0].files["conversation.md"] as string;

    // Should contain branch B messages
    expect(conversationMd).toContain("Branch B question");
    expect(conversationMd).toContain("Branch B answer");
    // Should NOT contain branch A messages
    expect(conversationMd).not.toContain("Branch A question");
    expect(conversationMd).not.toContain("Branch A answer");
  });

  it("README.md contains conversation metadata", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "sentinel", 0, "human", "Hello"),
    ];
    const conversation = makeConversation(messages, "h1", "My Cool Chat");
    const bundle = buildGitBundle(conversation, emptyArtifacts, new Map());

    const readme = bundle.commits[0].files["README.md"] as string;

    expect(readme).toContain("# My Cool Chat");
    expect(readme).toContain("conv-123");
    expect(readme).toContain("claude-opus-4-6");
    expect(readme).toContain("2026-01-15T10:00:00Z");
    expect(readme).toContain("ClaudeSync");
  });

  it("produces no artifact commit when all artifact contents are missing", () => {
    const messages: ChatMessage[] = [
      makeMessage("h1", "sentinel", 0, "human", "Hello"),
    ];
    const conversation = makeConversation(messages, "h1");

    const artifacts = makeArtifacts([
      {
        path: "/mnt/user-data/outputs/missing.ts",
        filename: "missing.ts",
      },
    ]);

    // Empty contents map -- nothing was downloaded
    const contents = new Map<string, string | Uint8Array>();

    const bundle = buildGitBundle(conversation, artifacts, contents);

    // Only the conversation commit, no artifact commit
    expect(bundle.commits).toHaveLength(1);
  });
});
