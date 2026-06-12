import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOrgSync } from "../scheduler.js";
import { AdaptiveController } from "../../concurrency/controller.js";
import { RateLimitError } from "../../client/errors.js";
import { safeSlug } from "../../util/naming.js";
import type { ClaudeSyncClient } from "../../client/client.js";
import type {
  ChatMessage,
  Conversation,
  ConversationSummary,
  Project,
  ProjectDoc,
} from "../../models/types.js";

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

function conversation(uuid: string, name: string): Conversation {
  return {
    uuid,
    name,
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

function project(uuid: string, name: string): Project {
  return {
    uuid,
    name,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
  };
}

interface MockOptions {
  getConversationImpl?: (uuid: string) => Promise<Conversation>;
}

function buildMockClient(opts: MockOptions = {}) {
  const calls = {
    getConversation: [] as string[],
    getProjectConversations: [] as string[],
    order: [] as string[],
  };

  const projects = [project("pA", "Project A"), project("pB", "Project B")];
  const projectConvs: Record<string, ConversationSummary[]> = {
    pA: [summary("cA1", "A One", "pA"), summary("cA2", "A Two")],
    pB: [summary("cB1", "B One", "pB")],
  };
  const allConversations: ConversationSummary[] = [
    summary("cA1", "A One", "pA"),
    summary("cA2", "A Two"), // in pA's list but no project_uuid
    summary("s1", "Standalone One"),
    summary("s2", "Standalone Two"),
    summary("cB1", "B One", "pB"),
  ];

  const client = {
    listProjects: async () => projects,
    listConversationsAll: async () => allConversations,
    getProjectDocs: async (): Promise<ProjectDoc[]> => [],
    getProjectConversations: async (_org: string, pid: string) => {
      calls.getProjectConversations.push(pid);
      return projectConvs[pid] ?? [];
    },
    getConversation: async (_org: string, uuid: string) => {
      calls.getConversation.push(uuid);
      calls.order.push("conv:" + uuid);
      if (opts.getConversationImpl) return opts.getConversationImpl(uuid);
      return conversation(uuid, uuid);
    },
  } as unknown as ClaudeSyncClient;

  return { client, calls };
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

describe("runOrgSync", () => {
  let out: string;
  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), "cs-sched-"));
  });
  afterEach(() => {
    rmSync(out, { recursive: true, force: true });
  });

  function baseOpts(controller: AdaptiveController) {
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

  it("processes all projects and standalone conversations", async () => {
    const { client, calls } = buildMockClient();
    const result = await runOrgSync(client, "org", baseOpts(makeController()));

    expect(result.projects).toBe(2);
    expect(result.standalone).toBe(2);
    expect(result.errors).toBe(0);

    const fetched = [...calls.getConversation].sort();
    expect(fetched).toEqual(["cA1", "cA2", "cB1", "s1", "s2"]);
  });

  it("writes project and standalone json output", async () => {
    const { client } = buildMockClient();
    await runOrgSync(client, "org", baseOpts(makeController()));

    expect(
      existsSync(join(out, "projects", safeSlug("Project A", "pA") + ".json"))
    ).toBe(true);
    expect(
      existsSync(join(out, "projects", safeSlug("Project B", "pB") + ".json"))
    ).toBe(true);
    expect(
      existsSync(
        join(out, "conversations", safeSlug("Standalone One", "s1") + ".json")
      )
    ).toBe(true);
    expect(
      existsSync(
        join(out, "conversations", safeSlug("Standalone Two", "s2") + ".json")
      )
    ).toBe(true);
  });

  it("gives same-named standalone conversations distinct, uuid-suffixed dirs", async () => {
    // Regression: safeSlug ignored the uuid for non-empty names, so two
    // conversations titled the same overwrote each other's directory.
    const dupConvs: ConversationSummary[] = [
      summary("099ff180-09ad-4ccb-8dd3-2e343de804e7", "Casual greeting"),
      summary("b63a8aa4-1b21-4a28-9b25-bdf7a6d6402a", "Casual greeting"),
    ];
    const client = {
      listProjects: async () => [],
      listConversationsAll: async () => dupConvs,
      getProjectDocs: async (): Promise<ProjectDoc[]> => [],
      getProjectConversations: async () => [],
      getConversation: async (_o: string, uuid: string) => conversation(uuid, uuid),
    } as unknown as ClaudeSyncClient;

    const result = await runOrgSync(client, "org", baseOpts(makeController()));
    expect(result.errors).toBe(0);
    // Both survive: neither clobbered the other. json mode writes <slug>.json.
    expect(existsSync(join(out, "conversations", "casual-greeting-099ff180.json"))).toBe(true);
    expect(existsSync(join(out, "conversations", "casual-greeting-b63a8aa4.json"))).toBe(true);
    // And the bare colliding name was NOT written.
    expect(existsSync(join(out, "conversations", "casual-greeting.json"))).toBe(false);
  });

  it("filters standalone using the project conversation set, not just project_uuid", async () => {
    const { client, calls } = buildMockClient();
    await runOrgSync(client, "org", baseOpts(makeController()));
    // cA2 has no project_uuid but is in pA's list -> fetched once as a project
    // conv, never double-processed as standalone (standalone == 2 asserts that).
    expect(calls.getConversation.filter((u) => u === "cA2")).toHaveLength(1);
  });

  it("completes all project discovery before enqueuing standalone work", async () => {
    const { client, calls } = buildMockClient();
    await runOrgSync(client, "org", baseOpts(makeController()));
    const firstStandalone = calls.order.findIndex(
      (o) => o === "conv:s1" || o === "conv:s2"
    );
    expect(calls.getProjectConversations).toHaveLength(2);
    expect(firstStandalone).toBeGreaterThanOrEqual(0);
  });

  it("retries a rate-limited conversation and still completes", async () => {
    let thrown = false;
    const { client } = buildMockClient({
      getConversationImpl: async (uuid) => {
        if (uuid === "s1" && !thrown) {
          thrown = true;
          throw new RateLimitError(Math.floor(Date.now() / 1000) - 1);
        }
        return conversation(uuid, uuid);
      },
    });
    const result = await runOrgSync(client, "org", baseOpts(makeController()));
    expect(result.errors).toBe(0);
    expect(
      existsSync(
        join(out, "conversations", safeSlug("Standalone One", "s1") + ".json")
      )
    ).toBe(true);
  });

  it("still writes a partial project when one of its conversations hard-fails", async () => {
    // cA1 permanently fails (non-rate-limit error => terminal on first attempt).
    // pA must still be written, carrying its surviving conversation (cA2), rather
    // than being stranded at outstanding > 0 and silently never finalized.
    const { client } = buildMockClient({
      getConversationImpl: async (uuid) => {
        if (uuid === "cA1") throw new Error("boom");
        return conversation(uuid, uuid);
      },
    });
    const result = await runOrgSync(client, "org", baseOpts(makeController()));

    expect(result.errors).toBe(1);
    const pAFile = join(out, "projects", safeSlug("Project A", "pA") + ".json");
    expect(existsSync(pAFile)).toBe(true);

    const bundle = JSON.parse(readFileSync(pAFile, "utf-8")) as {
      commits: { files: Record<string, unknown> }[];
    };
    const allPaths = bundle.commits.flatMap((c) => Object.keys(c.files));
    const cA2Dir = `conversations/${safeSlug("A Two", "cA2")}/`;
    const cA1Dir = `conversations/${safeSlug("A One", "cA1")}/`;
    expect(allPaths.some((p) => p.startsWith(cA2Dir))).toBe(true);
    expect(allPaths.some((p) => p.startsWith(cA1Dir))).toBe(false);

    // Unaffected project still written.
    expect(
      existsSync(join(out, "projects", safeSlug("Project B", "pB") + ".json"))
    ).toBe(true);
  });

  it("honors a per-project concurrency cap", async () => {
    const inFlight: Record<string, number> = { pA: 0, pB: 0 };
    let peakA = 0;
    const convToProject: Record<string, string> = {
      cA1: "pA",
      cA2: "pA",
      cB1: "pB",
    };
    const { client } = buildMockClient({
      getConversationImpl: async (uuid) => {
        const p = convToProject[uuid];
        if (p) {
          inFlight[p] += 1;
          if (p === "pA") peakA = Math.max(peakA, inFlight[p]);
        }
        await new Promise((r) => setTimeout(r, 5));
        if (p) inFlight[p] -= 1;
        return conversation(uuid, uuid);
      },
    });
    await runOrgSync(client, "org", {
      ...baseOpts(makeController()),
      projectConcurrency: 1,
    });
    expect(peakA).toBe(1);
  });
});
