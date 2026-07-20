import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeSource } from "@core/surface/claude-source.js";
import { FileSink } from "@core/surface/file-sink.js";
import { sync } from "@core/surface/orchestrator.js";
import type {
  CanonicalItem,
  ItemRef,
  ParsedUri,
  Selector,
  SourceSurface,
  SurfaceCaps,
} from "@core/surface/types.js";
import type { ClaudeSyncClient } from "@core/client/client.js";
import type {
  ArtifactListResponse,
  Conversation,
  ConversationSummary,
} from "@core/models/types.js";

const MSG_BASE = {
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  attachments: [],
  files_v2: [],
  sync_sources: [],
};

const emptyArtifacts: ArtifactListResponse = {
  success: true,
  files: [],
  files_metadata: [],
};

/** A nonempty conversation: one human turn, one assistant reply. */
function nonEmptyConversation(uuid: string): Conversation {
  return {
    uuid,
    name: "Test Conversation",
    model: "claude-opus-4-7",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    current_leaf_message_uuid: "m2",
    chat_messages: [
      { uuid: "m1", parent_message_uuid: "", sender: "human", text: "Hello", index: 0, ...MSG_BASE },
      { uuid: "m2", parent_message_uuid: "m1", sender: "assistant", text: "Hi there", index: 1, ...MSG_BASE },
    ],
  } as Conversation;
}

/** An empty conversation: zero human messages across the whole tree. */
function emptyConversation(uuid: string): Conversation {
  return {
    uuid,
    name: "Test Conversation",
    model: "claude-opus-4-7",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-03T00:00:00Z",
    current_leaf_message_uuid: null,
    chat_messages: [],
  } as Conversation;
}

const nonEmptySummary: ConversationSummary = {
  uuid: "conv-1",
  name: "Test Conversation",
  model: "claude-opus-4-7",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  current_leaf_message_uuid: "m2",
} as ConversationSummary;

const emptySummary: ConversationSummary = {
  uuid: "conv-1",
  name: "Test Conversation",
  model: "claude-opus-4-7",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-03T00:00:00Z",
  current_leaf_message_uuid: null,
} as ConversationSummary;

/** A fake claude.ai client whose `getConversation`/`listConversationsAll` are
 *  pinned to one summary/conversation pair. */
function mockClient(conversation: Conversation, summary: ConversationSummary): ClaudeSyncClient {
  return {
    listConversationsAll: async () => [summary],
    getConversation: async () => conversation,
    listArtifacts: async () => emptyArtifacts,
    downloadArtifact: async () => {
      throw new Error("no artifacts in fixture");
    },
  } as unknown as ClaudeSyncClient;
}

const authOpts = { authorName: "Claude", authorEmail: "claude@anthropic.com" };

/**
 * A minimal {@link SourceSurface} standing in for a non-claude source (e.g.
 * `cc://`): it has no concept of emptiness at all and therefore never sets
 * {@link CanonicalItem.isEmpty}. Emits one pre-rendered `tree` item, matching
 * the shape `cc://` and other Class D sources use.
 */
class StubTreeSource implements SourceSurface {
  readonly uri: ParsedUri = { scheme: "stub", path: "/stub", query: {} };
  readonly caps: SurfaceCaps = { read: true, write: false, delete: false, list: true };

  async *list(_selector?: Selector): AsyncIterable<ItemRef> {
    yield { id: "stub-1", kind: "session", name: "Stub Session" };
  }

  async read(ref: ItemRef): Promise<CanonicalItem> {
    return {
      ref,
      tree: {
        files: new Map([["conversation.md", "# Stub Session\n\nHello from a non-claude source.\n"]]),
        state: {
          schema_version: 1,
          conversation_uuid: ref.id,
          conversation_name: ref.name,
          model: null,
          updated_at: "2026-01-01T00:00:00Z",
          current_leaf_message_uuid: null,
          leaves: [],
          artifacts: [],
          last_sync_at: "2026-01-01T00:00:00Z",
          last_sync_action: "full",
        },
      },
    };
  }
}

describe("surface seam: neutral isEmpty handling", () => {
  const tmpDirs: string[] = [];
  const mkTmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "empty-seam-"));
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
    vi.restoreAllMocks();
  });

  it("empty item + sink lacks it -> skipped-empty, write never called, nothing written", async () => {
    const seamDir = path.join(mkTmp(), "conv");
    const source = new ClaudeSource(mockClient(emptyConversation("conv-1"), emptySummary), "org", authOpts);
    const sink = new FileSink(seamDir, "files");
    const writeSpy = vi.spyOn(sink, "write");

    const results = await sync(source, [sink], {
      selector: { conversationId: "conv-1" },
      format: "files",
      ...authOpts,
    });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("skipped-empty");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(seamDir)).toBe(false);
  });

  it("empty item + sink has prior output + sync policy (default) -> write called, empty snapshot materialized", async () => {
    const seamDir = path.join(mkTmp(), "conv");

    // Seed prior output: a normal full sync of the nonempty version.
    const seedSource = new ClaudeSource(mockClient(nonEmptyConversation("conv-1"), nonEmptySummary), "org", authOpts);
    const seedSink = new FileSink(seamDir, "files");
    const seedResults = await sync(seedSource, [seedSink], {
      selector: { conversationId: "conv-1" },
      format: "files",
      ...authOpts,
    });
    expect(seedResults[0].action).toBe("full");
    expect(fs.existsSync(path.join(seamDir, "conversation.md"))).toBe(true);

    // The conversation has since become empty; default onBecameEmpty="sync".
    const source = new ClaudeSource(mockClient(emptyConversation("conv-1"), emptySummary), "org", authOpts);
    const sink = new FileSink(seamDir, "files");
    const writeSpy = vi.spyOn(sink, "write");

    const results = await sync(source, [sink], {
      selector: { conversationId: "conv-1" },
      format: "files",
      ...authOpts,
    });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("full");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    // Empty snapshot was materialized (conversation.md rebuilt from zero messages).
    expect(fs.existsSync(path.join(seamDir, "conversation.md"))).toBe(true);
    const state = JSON.parse(
      fs.readFileSync(path.join(seamDir, ".claudesync-state.json"), "utf-8")
    );
    expect(state.last_sync_action).toBe("full");
    expect(state.current_leaf_message_uuid).toBeNull();
  });

  it("empty item + sink has prior output + retain -> retained-stale, write not called, output untouched", async () => {
    const seamDir = path.join(mkTmp(), "conv");

    const seedSource = new ClaudeSource(mockClient(nonEmptyConversation("conv-1"), nonEmptySummary), "org", authOpts);
    const seedSink = new FileSink(seamDir, "files");
    await sync(seedSource, [seedSink], {
      selector: { conversationId: "conv-1" },
      format: "files",
      ...authOpts,
    });
    const before = fs.readFileSync(path.join(seamDir, "conversation.md"), "utf-8");
    const stateBefore = fs.readFileSync(path.join(seamDir, ".claudesync-state.json"), "utf-8");

    const source = new ClaudeSource(mockClient(emptyConversation("conv-1"), emptySummary), "org", authOpts);
    const sink = new FileSink(seamDir, "files");
    const writeSpy = vi.spyOn(sink, "write");

    const results = await sync(source, [sink], {
      selector: { conversationId: "conv-1" },
      format: "files",
      onBecameEmpty: "retain",
      ...authOpts,
    });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("retained-stale");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(seamDir, "conversation.md"), "utf-8")).toBe(before);
    expect(fs.readFileSync(path.join(seamDir, ".claudesync-state.json"), "utf-8")).toBe(stateBefore);
  });

  it("empty item + sink has prior output + clean -> write called with clean directive, generated files removed, state marker written", async () => {
    const seamDir = path.join(mkTmp(), "conv");

    const seedSource = new ClaudeSource(mockClient(nonEmptyConversation("conv-1"), nonEmptySummary), "org", authOpts);
    const seedSink = new FileSink(seamDir, "files");
    await sync(seedSource, [seedSink], {
      selector: { conversationId: "conv-1" },
      format: "files",
      ...authOpts,
    });
    expect(fs.existsSync(path.join(seamDir, "conversation.md"))).toBe(true);
    expect(fs.existsSync(path.join(seamDir, "CHANGELOG.md"))).toBe(true);

    const source = new ClaudeSource(mockClient(emptyConversation("conv-1"), emptySummary), "org", authOpts);
    const sink = new FileSink(seamDir, "files");
    const writeSpy = vi.spyOn(sink, "write");

    const results = await sync(source, [sink], {
      selector: { conversationId: "conv-1" },
      format: "files",
      onBecameEmpty: "clean",
      ...authOpts,
    });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("cleaned-empty");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cleanEmpty: true }),
      expect.anything()
    );
    // Generated content is gone, CHANGELOG.md (always-preserve) survives.
    expect(fs.existsSync(path.join(seamDir, "conversation.md"))).toBe(false);
    expect(fs.existsSync(path.join(seamDir, "CHANGELOG.md"))).toBe(true);
    const state = JSON.parse(
      fs.readFileSync(path.join(seamDir, ".claudesync-state.json"), "utf-8")
    );
    expect(state.last_sync_action).toBe("cleaned-empty");
  });

  it("nonempty item: skipEmpty on has no effect on behavior", async () => {
    const seamDir = path.join(mkTmp(), "conv");
    const source = new ClaudeSource(mockClient(nonEmptyConversation("conv-1"), nonEmptySummary), "org", authOpts);
    const sink = new FileSink(seamDir, "files");

    const results = await sync(source, [sink], {
      selector: { conversationId: "conv-1" },
      format: "files",
      skipEmpty: true,
      ...authOpts,
    });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("full");
    expect(fs.existsSync(path.join(seamDir, "conversation.md"))).toBe(true);
  });

  it("non-claude stub source that never sets isEmpty is byte-identical with skipEmpty on vs off", async () => {
    const dirOn = path.join(mkTmp(), "conv");
    const dirOff = path.join(mkTmp(), "conv");

    const resultsOn = await sync(new StubTreeSource(), [new FileSink(dirOn, "files")], {
      format: "files",
      skipEmpty: true,
      ...authOpts,
    });
    const resultsOff = await sync(new StubTreeSource(), [new FileSink(dirOff, "files")], {
      format: "files",
      skipEmpty: false,
      ...authOpts,
    });

    expect(resultsOn.map((r) => r.action)).toEqual(resultsOff.map((r) => r.action));
    expect(resultsOn[0].action).toBe("full");

    const readTree = (root: string): Map<string, string> => {
      const out = new Map<string, string>();
      const walk = (dir: string, rel: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) {
            walk(abs, childRel);
          } else {
            let content = fs.readFileSync(abs, "utf-8");
            if (e.name === ".claudesync-state.json") {
              const parsed = JSON.parse(content);
              delete parsed.last_sync_at;
              content = JSON.stringify(parsed, null, 2);
            }
            out.set(childRel, content);
          }
        }
      };
      walk(root, "");
      return out;
    };

    expect(readTree(dirOn)).toEqual(readTree(dirOff));
  });
});
