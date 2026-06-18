import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncConversation } from "../../sync/incremental.js";
import { ClaudeSource } from "../claude-source.js";
import { FileSink } from "../file-sink.js";
import { sync } from "../orchestrator.js";
import type { ClaudeSyncClient } from "../../client/client.js";
import type {
  ArtifactListResponse,
  Conversation,
  ConversationSummary,
} from "../../models/types.js";

const MSG_BASE = {
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  attachments: [],
  files_v2: [],
  sync_sources: [],
};

function fixtureConversation(): Conversation {
  return {
    uuid: "conv-1",
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

const summary: ConversationSummary = {
  uuid: "conv-1",
  name: "Test Conversation",
  model: "claude-opus-4-7",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  current_leaf_message_uuid: "m2",
} as ConversationSummary;

const emptyArtifacts: ArtifactListResponse = {
  success: true,
  files: [],
  files_metadata: [],
};

function mockClient(): ClaudeSyncClient {
  return {
    listConversationsAll: async () => [summary],
    getConversation: async () => fixtureConversation(),
    listArtifacts: async () => emptyArtifacts,
    downloadArtifact: async () => {
      throw new Error("no artifacts in fixture");
    },
  } as unknown as ClaudeSyncClient;
}

/** Read a directory into a relpath -> content map, normalizing the one
 *  nondeterministic field (`.claudesync-state.json` `last_sync_at`). */
function readTree(root: string): Map<string, string> {
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
}

describe("surface seam parity with syncConversation", () => {
  const tmpDirs: string[] = [];
  const mkTmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "seam-"));
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("files mode: seam output is byte-identical to legacy syncConversation", async () => {
    const opts = {
      format: "files" as const,
      authorName: "Claude",
      authorEmail: "claude@anthropic.com",
    };

    // Legacy path.
    const legacyDir = path.join(mkTmp(), "conv");
    await syncConversation(mockClient(), "org", summary, legacyDir, opts);

    // Seam path: claude:// source -> file:// sink via sync().
    const seamDir = path.join(mkTmp(), "conv");
    const source = new ClaudeSource(mockClient(), "org", opts);
    const sink = new FileSink(seamDir, "files");
    const results = await sync(source, [sink], {
      selector: { conversationId: "conv-1" },
      format: "files",
      authorName: "Claude",
      authorEmail: "claude@anthropic.com",
    });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("full");
    expect(readTree(seamDir)).toEqual(readTree(legacyDir));
  });

  it("orchestrator honors skip-existing and skip-same", async () => {
    const seamDir = path.join(mkTmp(), "conv");
    const base = {
      format: "files" as const,
      authorName: "Claude",
      authorEmail: "claude@anthropic.com",
    };

    // First write.
    const r1 = await sync(new ClaudeSource(mockClient(), "org", base), [new FileSink(seamDir, "files")], {
      selector: { conversationId: "conv-1" },
      ...base,
    });
    expect(r1[0].action).toBe("full");

    // skip-existing -> skipped-existing.
    const r2 = await sync(new ClaudeSource(mockClient(), "org", base), [new FileSink(seamDir, "files")], {
      selector: { conversationId: "conv-1" },
      ...base,
      skipExisting: true,
    });
    expect(r2[0].action).toBe("skipped-existing");

    // skip-same (summary metadata unchanged) -> skipped.
    const r3 = await sync(new ClaudeSource(mockClient(), "org", base), [new FileSink(seamDir, "files")], {
      selector: { conversationId: "conv-1" },
      ...base,
      skipSame: true,
    });
    expect(r3[0].action).toBe("skipped");
  });
});
