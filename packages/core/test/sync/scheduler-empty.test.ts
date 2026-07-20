import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOrgSync, type ProgressEvent } from "@core/sync/scheduler.js";
import { AdaptiveController } from "@core/concurrency/controller.js";
import { safeSlug } from "@core/util/naming.js";
import type { ClaudeSyncClient } from "@core/client/client.js";
import type {
  ChatMessage,
  Conversation,
  ConversationSummary,
  Project,
  ProjectDoc,
} from "@core/models/types.js";

/** Builds a {@link ConversationSummary} fixture, mirroring scheduler.test.ts. */
function summary(
  uuid: string,
  name: string,
  projectUuid?: string
): ConversationSummary {
  return {
    uuid,
    name,
    model: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
    current_leaf_message_uuid: "leaf-" + uuid,
    project_uuid: projectUuid ?? null,
  };
}

/** Builds a {@link ChatMessage} fixture. */
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

/**
 * Builds a hydrated {@link Conversation} fixture. `empty: true` produces a
 * conversation with zero messages of any kind (matching the spike finding
 * that null-leaf conversations hydrate to `chat_messages: []`), so
 * {@link isEmptyConversation} reports it as empty. Otherwise produces the
 * standard one-human, one-assistant pair used across the scheduler suite.
 */
function conversation(
  uuid: string,
  name: string,
  opts: { empty?: boolean } = {}
): Conversation {
  return {
    uuid,
    name,
    model: "claude-x",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
    current_leaf_message_uuid: opts.empty ? null : `${uuid}-msg-2`,
    chat_messages: opts.empty
      ? []
      : [
          message(`${uuid}-msg-1`, "sentinel", 0, "human", "Hello"),
          message(`${uuid}-msg-2`, `${uuid}-msg-1`, 1, "assistant", "Hi"),
        ],
  };
}

/** Builds a {@link Project} fixture. */
function project(uuid: string, name: string): Project {
  return {
    uuid,
    name,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
  };
}

function makeController() {
  return new AdaptiveController({
    min: 1,
    max: 8,
    start: 4,
    increaseAfter: 3,
    decreaseFactor: 0.5,
    minGapMs: 0,
  });
}

/**
 * Minimal mock client builder for this file. Unlike scheduler.test.ts's
 * `buildMockClient`, `getConversation` resolves emptiness per-uuid via a
 * caller-supplied set, so a single client fixture can produce a mix of
 * empty and nonempty conversations.
 */
function mockClient(opts: {
  projects?: Project[];
  projectConvs?: Record<string, ConversationSummary[]>;
  allConversations: ConversationSummary[];
  emptyUuids?: Set<string>;
}) {
  const { projects = [], projectConvs = {}, allConversations, emptyUuids = new Set() } = opts;
  const client = {
    listProjects: async () => projects,
    listConversationsAll: async () => allConversations,
    getProjectDocs: async (): Promise<ProjectDoc[]> => [],
    getProjectConversations: async (_org: string, pid: string) => projectConvs[pid] ?? [],
    getConversation: async (_org: string, uuid: string) =>
      conversation(uuid, uuid, { empty: emptyUuids.has(uuid) }),
  } as unknown as ClaudeSyncClient;
  return client;
}

/**
 * Seeds a project conversation's subtree with stand-in materialized content,
 * as if a prior `files`-format run had exported it. Used to construct the
 * became-empty directory-existence proxy scenarios for project
 * conversations (see {@link handleEmptyProjectConv} in scheduler.ts).
 *
 * @param projectPath - Project root directory (`<outputRoot>/projects/<slug>`).
 * @param slug - The conversation's collision-safe slug.
 * @param content - Stand-in file content, asserted byte-identical after a
 *   `retain` run.
 */
function seedProjectConvSubtree(projectPath: string, slug: string, content: string): void {
  const dir = join(projectPath, "conversations", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "conversation.md"), content, "utf-8");
}

describe("runOrgSync -- skip-empty integration", () => {
  function baseOpts(out: string, controller: ReturnType<typeof makeController>) {
    return {
      outputRoot: out,
      format: "json" as const,
      authorName: "Test",
      authorEmail: "test@example.com",
      skipArtifacts: true,
      controller,
      maxRetries: 5,
    };
  }

  it("counts skipped-empty standalone conversations and still exports the nonempty ones", async () => {
    const out = mkdtempSync(join(tmpdir(), "cs-sched-empty-"));
    try {
      const client = mockClient({
        allConversations: [
          summary("e1", "Empty One"),
          summary("c1", "Convo One"),
          summary("c2", "Convo Two"),
        ],
        emptyUuids: new Set(["e1"]),
      });

      const result = await runOrgSync(client, "org", baseOpts(out, makeController()));

      expect(result.skippedEmpty).toBe(1);
      expect(result.retainedStale).toBe(0);
      expect(result.cleanedEmpty).toBe(0);
      expect(result.errors).toBe(0);

      expect(
        existsSync(join(out, "conversations", safeSlug("Convo One", "c1") + ".json"))
      ).toBe(true);
      expect(
        existsSync(join(out, "conversations", safeSlug("Convo Two", "c2") + ".json"))
      ).toBe(true);
      expect(
        existsSync(join(out, "conversations", safeSlug("Empty One", "e1") + ".json"))
      ).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("excludes an empty project conversation from the project bundle", async () => {
    const out = mkdtempSync(join(tmpdir(), "cs-sched-empty-"));
    try {
      const client = mockClient({
        projects: [project("pA", "Project A")],
        projectConvs: {
          pA: [summary("c1", "C One", "pA"), summary("e1", "Empty One", "pA")],
        },
        allConversations: [
          summary("c1", "C One", "pA"),
          summary("e1", "Empty One", "pA"),
        ],
        emptyUuids: new Set(["e1"]),
      });

      const result = await runOrgSync(client, "org", baseOpts(out, makeController()));
      expect(result.errors).toBe(0);
      expect(result.skippedEmpty).toBe(1);

      const pAFile = join(out, "projects", safeSlug("Project A", "pA") + ".json");
      expect(existsSync(pAFile)).toBe(true);
      const bundle = JSON.parse(readFileSync(pAFile, "utf-8")) as {
        commits: { files: Record<string, unknown> }[];
      };
      const allPaths = bundle.commits.flatMap((c) => Object.keys(c.files));
      const c1Dir = `conversations/${safeSlug("C One", "c1")}/`;
      const e1Dir = `conversations/${safeSlug("Empty One", "e1")}/`;
      expect(allPaths.some((p) => p.startsWith(c1Dir))).toBe(true);
      expect(allPaths.some((p) => p.startsWith(e1Dir))).toBe(false);

      // README (leading commit) reports the reduced conversation count.
      const readme = bundle.commits[0]!.files["README.md"] as string;
      expect(readme).toContain("**Conversations:** 1");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("keeps a nonempty conversation's disambiguated slug stable whether its same-named empty sibling is skipped or not", async () => {
    const uuidNonempty = "099ff180-09ad-4ccb-8dd3-2e343de804e7";
    const uuidEmpty = "b63a8aa4-1b21-4a28-9b25-bdf7a6d6402a";
    const expectedNonemptySlug = `casual-greeting-${uuidNonempty.slice(0, 8)}`;

    // Run 1: skipEmpty on (default) -- the empty sibling is skipped entirely.
    const out1 = mkdtempSync(join(tmpdir(), "cs-sched-empty-"));
    try {
      const client1 = mockClient({
        allConversations: [
          summary(uuidNonempty, "Casual greeting"),
          summary(uuidEmpty, "Casual greeting"),
        ],
        emptyUuids: new Set([uuidEmpty]),
      });
      const result1 = await runOrgSync(client1, "org", baseOpts(out1, makeController()));
      expect(result1.skippedEmpty).toBe(1);
      expect(
        existsSync(join(out1, "conversations", expectedNonemptySlug + ".json"))
      ).toBe(true);
    } finally {
      rmSync(out1, { recursive: true, force: true });
    }

    // Run 2: skipEmpty off -- both conversations are exported, but the
    // nonempty one's slug (computed from the complete discovered set before
    // any filtering) must be byte-identical to run 1's.
    const out2 = mkdtempSync(join(tmpdir(), "cs-sched-empty-"));
    try {
      const client2 = mockClient({
        allConversations: [
          summary(uuidNonempty, "Casual greeting"),
          summary(uuidEmpty, "Casual greeting"),
        ],
        emptyUuids: new Set([uuidEmpty]),
      });
      const result2 = await runOrgSync(client2, "org", {
        ...baseOpts(out2, makeController()),
        skipEmpty: false,
      });
      expect(result2.skippedEmpty).toBe(0);
      expect(
        existsSync(join(out2, "conversations", expectedNonemptySlug + ".json"))
      ).toBe(true);
      // The bare colliding name was never written in either run.
      expect(existsSync(join(out2, "conversations", "casual-greeting.json"))).toBe(false);
    } finally {
      rmSync(out2, { recursive: true, force: true });
    }
  });

  it("emits a conv-done progress event with action skipped-empty", async () => {
    const out = mkdtempSync(join(tmpdir(), "cs-sched-empty-"));
    try {
      const client = mockClient({
        allConversations: [summary("e1", "Empty One"), summary("c1", "Convo One")],
        emptyUuids: new Set(["e1"]),
      });

      const events: ProgressEvent[] = [];
      await runOrgSync(client, "org", {
        ...baseOpts(out, makeController()),
        onProgress: (e) => events.push(e),
      });

      const skippedEvent = events.find(
        (e) => e.type === "conv-done" && e.action === "skipped-empty"
      );
      expect(skippedEvent).toBeDefined();
      expect(skippedEvent).toMatchObject({
        type: "conv-done",
        kind: "standalone",
        action: "skipped-empty",
        displayName: "Empty One",
      });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("runOrgSync -- became-empty project conversation subtree handling", () => {
  function baseFilesOpts(out: string, controller: ReturnType<typeof makeController>) {
    return {
      outputRoot: out,
      format: "files" as const,
      authorName: "Test",
      authorEmail: "test@example.com",
      skipArtifacts: true,
      controller,
      maxRetries: 5,
    };
  }

  /** Shared two-conversation project fixture: c1 stays nonempty, e1 becomes empty. */
  function pAClient() {
    return mockClient({
      projects: [project("pA", "Project A")],
      projectConvs: {
        pA: [summary("c1", "C One", "pA"), summary("e1", "Empty One", "pA")],
      },
      allConversations: [
        summary("c1", "C One", "pA"),
        summary("e1", "Empty One", "pA"),
      ],
      emptyUuids: new Set(["e1"]),
    });
  }

  it("retains a became-empty project conversation's prior subtree byte-identical under onBecameEmpty: retain", async () => {
    const out = mkdtempSync(join(tmpdir(), "cs-sched-empty-proj-"));
    try {
      const projectSlug = safeSlug("Project A", "pA");
      const emptySlug = safeSlug("Empty One", "e1");
      const nonemptySlug = safeSlug("C One", "c1");
      const projectPath = join(out, "projects", projectSlug);
      seedProjectConvSubtree(projectPath, emptySlug, "PRIOR CONTENT\n");

      const result = await runOrgSync(pAClient(), "org", {
        ...baseFilesOpts(out, makeController()),
        onBecameEmpty: "retain",
      });

      expect(result.errors).toBe(0);
      expect(result.retainedStale).toBe(1);
      expect(result.skippedEmpty).toBe(0);
      expect(result.cleanedEmpty).toBe(0);

      // The prior subtree survives the rebuild byte-identical.
      expect(
        readFileSync(join(projectPath, "conversations", emptySlug, "conversation.md"), "utf-8")
      ).toBe("PRIOR CONTENT\n");

      // The other (nonempty) conversation is exported normally, unaffected.
      expect(
        existsSync(join(projectPath, "conversations", nonemptySlug, "conversation.md"))
      ).toBe(true);

      // README/bundle excludes the retained-but-empty conversation from the count.
      const readme = readFileSync(join(projectPath, "README.md"), "utf-8");
      expect(readme).toContain("**Conversations:** 1");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("deletes a became-empty project conversation's prior subtree under onBecameEmpty: clean", async () => {
    const out = mkdtempSync(join(tmpdir(), "cs-sched-empty-proj-"));
    try {
      const projectSlug = safeSlug("Project A", "pA");
      const emptySlug = safeSlug("Empty One", "e1");
      const nonemptySlug = safeSlug("C One", "c1");
      const projectPath = join(out, "projects", projectSlug);
      seedProjectConvSubtree(projectPath, emptySlug, "PRIOR CONTENT\n");

      const result = await runOrgSync(pAClient(), "org", {
        ...baseFilesOpts(out, makeController()),
        onBecameEmpty: "clean",
      });

      expect(result.errors).toBe(0);
      expect(result.cleanedEmpty).toBe(1);
      expect(result.skippedEmpty).toBe(0);
      expect(result.retainedStale).toBe(0);

      // The prior subtree is gone -- the rebuild dropped it, no preserve glob.
      expect(existsSync(join(projectPath, "conversations", emptySlug))).toBe(false);
      // The other (nonempty) conversation is unaffected.
      expect(
        existsSync(join(projectPath, "conversations", nonemptySlug, "conversation.md"))
      ).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("deletes a became-empty project conversation's prior subtree via normal rebuild under the default sync policy, without incrementing any empty counter", async () => {
    const out = mkdtempSync(join(tmpdir(), "cs-sched-empty-proj-"));
    try {
      const projectSlug = safeSlug("Project A", "pA");
      const emptySlug = safeSlug("Empty One", "e1");
      const projectPath = join(out, "projects", projectSlug);
      seedProjectConvSubtree(projectPath, emptySlug, "PRIOR CONTENT\n");

      // No onBecameEmpty override -- exercises the "sync" default.
      const result = await runOrgSync(pAClient(), "org", baseFilesOpts(out, makeController()));

      expect(result.errors).toBe(0);
      expect(result.skippedEmpty).toBe(0);
      expect(result.retainedStale).toBe(0);
      expect(result.cleanedEmpty).toBe(0);

      // Normal rebuild: the subtree is gone (it's a genuine sync of the
      // remote deletion), but no became-empty counter moved for it.
      expect(existsSync(join(projectPath, "conversations", emptySlug))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
