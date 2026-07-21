import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncConversation, cleanEmptyConversation } from "@core/sync/incremental.js";
import { writeSyncState, readSyncState, type SyncState } from "@core/sync/state.js";
import type { ClaudeSyncClient } from "@core/client/client.js";
import type {
  ArtifactListResponse,
  ChatMessage,
  Conversation,
  ConversationSummary,
} from "@core/models/types.js";

/** Builder for a ChatMessage fixture, mirroring scheduler.test.ts's pattern. */
function message(
  uuid: string,
  parentUuid: string,
  index: number,
  sender: "human" | "assistant",
  text: string
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

/** Builder for a nonempty Conversation fixture (one human + one assistant turn). */
function nonEmptyConversation(uuid: string): Conversation {
  return {
    uuid,
    name: "Test Conversation",
    model: "claude-x",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
    current_leaf_message_uuid: `${uuid}-msg-2`,
    chat_messages: [
      message(`${uuid}-msg-1`, "sentinel", 0, "human", "Hello"),
      message(`${uuid}-msg-2`, `${uuid}-msg-1`, 1, "assistant", "Hi"),
    ],
  };
}

/** Builder for an empty Conversation fixture (zero messages, zero human turns). */
function emptyConversation(uuid: string): Conversation {
  return {
    uuid,
    name: "Test Conversation",
    model: "claude-x",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
    current_leaf_message_uuid: null,
    chat_messages: [],
  };
}

/** Builder for a ConversationSummary fixture matching a given conversation's leaf/updated_at. */
function summaryFor(conv: Conversation): ConversationSummary {
  return {
    uuid: conv.uuid,
    name: conv.name,
    model: conv.model,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    current_leaf_message_uuid: conv.current_leaf_message_uuid,
  };
}

/** Builder for a prior-sync SyncState fixture, as if a nonempty conversation was synced before. */
function priorState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    schema_version: 1,
    conversation_uuid: "conv-1",
    conversation_name: "Test Conversation",
    model: "claude-x",
    updated_at: "2025-01-02T00:00:00Z",
    current_leaf_message_uuid: "conv-1-msg-2",
    leaves: [{ uuid: "conv-1-msg-2", last_message_index: 1 }],
    artifacts: [],
    last_sync_at: "2025-01-02T00:00:01Z",
    last_sync_action: "full",
    ...overrides,
  };
}

/** Call trackers + a mock ClaudeSyncClient serving a single fixed conversation by uuid. */
function buildMockClient(conv: Conversation) {
  const calls = {
    getConversation: [] as string[],
    listArtifacts: [] as string[],
    downloadArtifact: [] as string[],
  };
  const client = {
    getConversation: async (_org: string, uuid: string) => {
      calls.getConversation.push(uuid);
      return conv;
    },
    listArtifacts: async (_org: string, uuid: string): Promise<ArtifactListResponse> => {
      calls.listArtifacts.push(uuid);
      return { success: true, files: [], files_metadata: [] };
    },
    downloadArtifact: async (_org: string, uuid: string, path: string) => {
      calls.downloadArtifact.push(`${uuid}:${path}`);
      return "";
    },
  } as unknown as ClaudeSyncClient;
  return { client, calls };
}

let workdir: string;
let outputPath: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "claudesync-empty-sync-"));
  outputPath = join(workdir, "convo");
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/** Seeds outputPath with prior-sync state plus stand-in materialized files, as
 *  if a nonempty conversation had previously been synced in `files` format. */
function seedPriorSync(): void {
  mkdirSync(outputPath, { recursive: true });
  writeFileSync(join(outputPath, "conversation.md"), "## Human\n\nHello\n", "utf-8");
  writeFileSync(join(outputPath, "README.md"), "# Test Conversation\n", "utf-8");
  writeFileSync(join(outputPath, "CHANGELOG.md"), "# Changelog\n\n## 2025-01-02\n", "utf-8");
  writeSyncState(outputPath, priorState());
}

const baseOptions = {
  format: "files" as const,
  authorName: "Test",
  authorEmail: "test@example.com",
};

describe("syncConversation: empty-conversation handling", () => {
  it("skips with no writes when empty and no prior state exists", async () => {
    const conv = emptyConversation("conv-1");
    const { client, calls } = buildMockClient(conv);

    const result = await syncConversation(client, "org", summaryFor(conv), outputPath, {
      ...baseOptions,
    });

    expect(result.action).toBe("skipped-empty");
    expect(calls.listArtifacts).toEqual([]);
    expect(calls.downloadArtifact).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("fully materializes and advances state when empty, prior state exists, policy sync", async () => {
    seedPriorSync();
    const conv = emptyConversation("conv-1");
    const { client, calls } = buildMockClient(conv);

    const result = await syncConversation(client, "org", summaryFor(conv), outputPath, {
      ...baseOptions,
      onBecameEmpty: "sync",
    });

    expect(result.action).toBe("full");
    expect(calls.listArtifacts).toEqual([]);
    expect(calls.downloadArtifact).toEqual([]);

    // conversation.md rewritten to reflect the now-empty branch.
    expect(readFileSync(join(outputPath, "conversation.md"), "utf-8")).toBe("");

    const state = readSyncState(outputPath);
    expect(state?.leaves).toEqual([]);
    expect(state?.current_leaf_message_uuid).toBeNull();
    expect(state?.last_sync_action).toBe("full");
  });

  it("leaves files and state byte-untouched when empty, prior state exists, policy retain", async () => {
    seedPriorSync();
    const conv = emptyConversation("conv-1");
    const { client, calls } = buildMockClient(conv);

    const beforeConvoMd = readFileSync(join(outputPath, "conversation.md"), "utf-8");
    const beforeStateRaw = readFileSync(
      join(outputPath, ".claudesync-state.json"),
      "utf-8"
    );
    const beforeStateMtime = statSync(join(outputPath, ".claudesync-state.json")).mtimeMs;

    const result = await syncConversation(client, "org", summaryFor(conv), outputPath, {
      ...baseOptions,
      onBecameEmpty: "retain",
    });

    expect(result.action).toBe("retained-stale");
    expect(calls.listArtifacts).toEqual([]);
    expect(calls.downloadArtifact).toEqual([]);

    expect(readFileSync(join(outputPath, "conversation.md"), "utf-8")).toBe(beforeConvoMd);
    expect(
      readFileSync(join(outputPath, ".claudesync-state.json"), "utf-8")
    ).toBe(beforeStateRaw);
    expect(statSync(join(outputPath, ".claudesync-state.json")).mtimeMs).toBe(
      beforeStateMtime
    );
  });

  it("removes generated files but keeps a rewritten state file when empty, policy clean", async () => {
    seedPriorSync();
    const conv = emptyConversation("conv-1");
    const { client, calls } = buildMockClient(conv);

    const result = await syncConversation(client, "org", summaryFor(conv), outputPath, {
      ...baseOptions,
      onBecameEmpty: "clean",
    });

    expect(result.action).toBe("cleaned-empty");
    expect(calls.listArtifacts).toEqual([]);
    expect(calls.downloadArtifact).toEqual([]);

    // Generated content is gone.
    expect(existsSync(join(outputPath, "conversation.md"))).toBe(false);
    expect(existsSync(join(outputPath, "README.md"))).toBe(false);
    // CHANGELOG.md, an always-preserved sidecar, survives.
    expect(existsSync(join(outputPath, "CHANGELOG.md"))).toBe(true);

    const state = readSyncState(outputPath);
    expect(state).toBeDefined();
    expect(state?.last_sync_action).toBe("cleaned-empty");
  });

  it("fetches artifacts and produces a normal result for a nonempty conversation with detectEmpty on", async () => {
    const conv = nonEmptyConversation("conv-1");
    const { client, calls } = buildMockClient(conv);

    const result = await syncConversation(client, "org", summaryFor(conv), outputPath, {
      ...baseOptions,
    });

    expect(result.action).toBe("full");
    expect(calls.listArtifacts).toEqual(["conv-1"]);
    expect(existsSync(join(outputPath, "conversation.md"))).toBe(true);
  });

  it("bypasses empty handling entirely when skipEmpty is false", async () => {
    const conv = emptyConversation("conv-1");
    const { client, calls } = buildMockClient(conv);

    const result = await syncConversation(client, "org", summaryFor(conv), outputPath, {
      ...baseOptions,
      skipEmpty: false,
    });

    // Pre-existing behavior: the empty conversation exports as any other
    // conversation would (first sync => "full"), artifacts still fetched.
    expect(result.action).toBe("full");
    expect(calls.listArtifacts).toEqual(["conv-1"]);
    expect(existsSync(join(outputPath, "conversation.md"))).toBe(true);
    expect(readFileSync(join(outputPath, "conversation.md"), "utf-8")).toBe("");
  });

  it("short-circuits via skip-same on the run after a clean, without re-hydrating", async () => {
    seedPriorSync();
    const conv = emptyConversation("conv-1");
    const { client, calls } = buildMockClient(conv);
    const summary = summaryFor(conv);

    const cleaned = await syncConversation(client, "org", summary, outputPath, {
      ...baseOptions,
      onBecameEmpty: "clean",
    });
    expect(cleaned.action).toBe("cleaned-empty");
    expect(calls.getConversation).toEqual(["conv-1"]);

    const second = await syncConversation(client, "org", summary, outputPath, {
      ...baseOptions,
      skipSame: true,
      onBecameEmpty: "clean",
    });

    expect(second.action).toBe("skipped");
    // No additional hydration: skip-same short-circuits before fetchAndBuild.
    expect(calls.getConversation).toEqual(["conv-1"]);
    expect(calls.listArtifacts).toEqual([]);
  });
});

describe("cleanEmptyConversation: refuses to operate on a directory with no state sidecar", () => {
  it("throws and leaves an arbitrary directory's contents byte-untouched (near-miss regression)", async () => {
    // Regression for the live near-miss: `cleanEmptyConversation` must never
    // treat "directory exists" as proof of "this is a claudesync-managed
    // conversation directory". Here outputPath stands in for what could be
    // an entire export archive root or any other directory that merely
    // happens to exist -- it holds arbitrary files but no
    // .claudesync-state.json sidecar.
    mkdirSync(outputPath, { recursive: true });
    writeFileSync(join(outputPath, "unrelated-user-file.txt"), "do not touch me\n", "utf-8");
    mkdirSync(join(outputPath, "some-other-conversation"), { recursive: true });
    writeFileSync(
      join(outputPath, "some-other-conversation", "conversation.md"),
      "## Human\n\nSomeone else's conversation\n",
      "utf-8"
    );

    await expect(cleanEmptyConversation(outputPath, "files", [])).rejects.toThrow(
      /claudesync state sidecar/i
    );

    // Directory contents must survive byte-for-byte -- no stash-and-rewrite
    // was allowed to touch anything.
    expect(readFileSync(join(outputPath, "unrelated-user-file.txt"), "utf-8")).toBe(
      "do not touch me\n"
    );
    expect(
      readFileSync(join(outputPath, "some-other-conversation", "conversation.md"), "utf-8")
    ).toBe("## Human\n\nSomeone else's conversation\n");
    expect(existsSync(join(outputPath, ".claudesync-state.json"))).toBe(false);
    expect(existsSync(outputPath + ".prev")).toBe(false);
  });

  it("proceeds normally when a valid state sidecar is present", async () => {
    seedPriorSync();

    await expect(cleanEmptyConversation(outputPath, "files", [])).resolves.toBeUndefined();

    expect(existsSync(join(outputPath, "conversation.md"))).toBe(false);
    expect(existsSync(join(outputPath, "CHANGELOG.md"))).toBe(true);
  });
});
