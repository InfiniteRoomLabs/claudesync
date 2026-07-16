import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type CreateServerOptions } from "../src/server.js";
import type { AuthProvider, ClaudeSyncClient, ProjectMemory } from "@infinite-room-labs/claudesync-core";

const orgId = "org-1";
const projectId = "proj-1";
const ENV_KEY = "CLAUDESYNC_MCP_WRITE_SCOPE";

/**
 * Build a synthetic {@link ProjectMemory} response. Cast rather than object-literal
 * typed directly since `ProjectMemorySchema` is `.passthrough()`.
 */
const remote = (memory: string, controls: string[] | null, updated_at: string | null): ProjectMemory =>
  ({ memory, controls, updated_at }) as ProjectMemory;

/** Minimal {@link AuthProvider} fake; `getOrganizationId` is only exercised when a test omits `orgId`. */
function makeFakeAuth(): AuthProvider {
  return {
    async getHeaders() {
      return {};
    },
    async getOrganizationId() {
      return orgId;
    },
  };
}

/** A single recorded call to the fake client, in call order. */
type RecordedCall = { type: "get" } | { type: "put"; controls: string[]; timeoutMs?: number };

/**
 * Fake `ClaudeSyncClient` recording every `getProjectMemory`/`putProjectMemoryControls`
 * call in order. `getResponses` is consumed one entry per GET (the last entry repeats
 * for any GET beyond the list's length) -- mirrors the fake client in
 * `packages/core/test/memory/push-apply.test.ts`.
 */
function makeFakeClient(getResponses: ProjectMemory[]) {
  const calls: RecordedCall[] = [];
  let getCallCount = 0;
  const fake = {
    async getProjectMemory(_orgId: string, _projectId: string): Promise<ProjectMemory> {
      calls.push({ type: "get" });
      const idx = Math.min(getCallCount, getResponses.length - 1);
      getCallCount += 1;
      const value = getResponses[idx];
      if (value === undefined) throw new Error("test bug: no fake GET response configured");
      return value;
    },
    async putProjectMemoryControls(
      _orgId: string,
      _projectId: string,
      controls: string[],
      options?: { timeoutMs?: number },
    ): Promise<void> {
      calls.push({ type: "put", controls, timeoutMs: options?.timeoutMs });
    },
  };
  return { client: fake as unknown as ClaudeSyncClient, calls };
}

let openClients: Client[] = [];

afterEach(async () => {
  await Promise.all(openClients.map((c) => c.close()));
  openClients = [];
  delete process.env[ENV_KEY];
});

/** Spin up a `createServer` instance and connect an in-process MCP client to it. */
async function connect(options: CreateServerOptions): Promise<Client> {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  openClients.push(client);
  return client;
}

/** Call `put_project_memory_controls` and return the raw MCP tool result. */
async function callPut(client: Client, args: Record<string, unknown>) {
  return client.callTool({ name: "put_project_memory_controls", arguments: args });
}

/** Extract the JSON payload from a successful tool result's first text block. */
function jsonOf(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("put_project_memory_controls gating", () => {
  it("is absent from tools/list when memoryWriteEnabled is false", async () => {
    const { client: fakeClient } = makeFakeClient([remote("m\n", ["a"], "T1")]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: false });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("put_project_memory_controls");
  });

  it("is present in tools/list when memoryWriteEnabled is true", async () => {
    const { client: fakeClient } = makeFakeClient([remote("m\n", ["a"], "T1")]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: true });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("put_project_memory_controls");
  });

  it("leaves read tools registered regardless of memoryWriteEnabled", async () => {
    const { client: fakeClient } = makeFakeClient([remote("m\n", ["a"], "T1")]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: false });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("get_project_memory");
  });

  it("derives memoryWriteEnabled from CLAUDESYNC_MCP_WRITE_SCOPE by exact match only", async () => {
    const cases: Array<[string | undefined, boolean]> = [
      ["project-memory", true],
      ["true", false],
      ["1", false],
      ["all", false],
      ["PROJECT-MEMORY", false],
      [undefined, false],
    ];
    for (const [envValue, expectPresent] of cases) {
      if (envValue === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = envValue;
      }

      const { client: fakeClient } = makeFakeClient([remote("m\n", ["a"], "T1")]);
      // memoryWriteEnabled deliberately omitted so createServer derives it from process.env.
      const client = await connect({ auth: makeFakeAuth(), client: fakeClient });
      const { tools } = await client.listTools();
      const present = tools.map((t) => t.name).includes("put_project_memory_controls");
      expect(present, `env ${ENV_KEY}=${String(envValue)}`).toBe(expectPresent);
    }
  });
});

describe("put_project_memory_controls handler", () => {
  it("refuses a confirmProjectId mismatch before any GET or PUT", async () => {
    const { client: fakeClient, calls } = makeFakeClient([remote("m\n", ["a"], "T1")]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: true });

    const result = await callPut(client, {
      projectId,
      confirmProjectId: "some-other-project",
      orgId,
      expectedUpdatedAt: "T1",
      baseControls: ["a"],
      desiredControls: ["a"],
    });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('refuses when the project has no memory generated (memory === "")', async () => {
    const { client: fakeClient, calls } = makeFakeClient([remote("", null, null)]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: true });

    const result = await callPut(client, {
      projectId,
      confirmProjectId: projectId,
      orgId,
      expectedUpdatedAt: "irrelevant-since-memory-is-empty",
      baseControls: [],
      desiredControls: ["a"],
    });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([{ type: "get" }]);
  });

  it("refuses a stale expectedUpdatedAt before any PUT", async () => {
    const { client: fakeClient, calls } = makeFakeClient([remote("m\n", ["a"], "T2")]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: true });

    const result = await callPut(client, {
      projectId,
      confirmProjectId: projectId,
      orgId,
      expectedUpdatedAt: "T1", // stale: live remote is already at T2
      baseControls: ["a"],
      desiredControls: ["a", "b"],
    });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([{ type: "get" }]);
  });

  it("merges a concurrent remote add into the PUT", async () => {
    const openingRemote = remote("m1\n", ["a", "c"], "T1"); // "c" added on claude.ai since base
    const verifyRemote = remote("m2\n", ["a", "c", "b"], "T2");
    const { client: fakeClient, calls } = makeFakeClient([openingRemote, verifyRemote]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: true });

    const result = await callPut(client, {
      projectId,
      confirmProjectId: projectId,
      orgId,
      expectedUpdatedAt: "T1",
      baseControls: ["a"],
      desiredControls: ["a", "b"], // local add "b"
    });

    expect(result.isError).toBeFalsy();
    const putCalls = calls.filter((c): c is Extract<RecordedCall, { type: "put" }> => c.type === "put");
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].controls).toEqual(["a", "c", "b"]);
  });

  it("issues no PUT when the merge result already matches the remote (no-op)", async () => {
    const { client: fakeClient, calls } = makeFakeClient([remote("m1\n", ["a"], "T1")]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: true });

    const result = await callPut(client, {
      projectId,
      confirmProjectId: projectId,
      orgId,
      expectedUpdatedAt: "T1",
      baseControls: ["a"],
      desiredControls: ["a"], // no local change
    });

    expect(result.isError).toBeFalsy();
    expect(calls.filter((c) => c.type === "put")).toHaveLength(0);
    expect(jsonOf(result).action).toBe("no-op");
  });

  it("calls PUT exactly once when there is a real change", async () => {
    const openingRemote = remote("m1\n", ["a"], "T1");
    const verifyRemote = remote("m2\n", ["a", "b"], "T2");
    const { client: fakeClient, calls } = makeFakeClient([openingRemote, verifyRemote]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: true });

    const result = await callPut(client, {
      projectId,
      confirmProjectId: projectId,
      orgId,
      expectedUpdatedAt: "T1",
      baseControls: ["a"],
      desiredControls: ["a", "b"],
    });

    expect(result.isError).toBeFalsy();
    expect(calls.filter((c) => c.type === "put")).toHaveLength(1);
    expect(jsonOf(result).action).toBe("written");
  });

  it("returns only hashes/counts -- never control text", async () => {
    const marker = "SUPER_SECRET_MEMORY_CONTROL_MARKER_7f3a";
    const openingRemote = remote("m1\n", ["a"], "T1");
    const verifyRemote = remote("m2\n", ["a", marker], "T2");
    const { client: fakeClient } = makeFakeClient([openingRemote, verifyRemote]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: true });

    const result = await callPut(client, {
      projectId,
      confirmProjectId: projectId,
      orgId,
      expectedUpdatedAt: "T1",
      baseControls: ["a"],
      desiredControls: ["a", marker],
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).not.toContain(marker);
    expect(text).not.toContain("m1");
    expect(text).not.toContain("m2");

    const parsed = jsonOf(result);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "action",
        "before_controls_sha256",
        "after_controls_sha256",
        "before_updated_at",
        "after_updated_at",
        "controls_count",
      ].sort(),
    );
    expect(parsed.action).toBe("written");
    expect(parsed.before_updated_at).toBe("T1");
    expect(parsed.after_updated_at).toBe("T2");
    expect(parsed.controls_count).toBe(2);
    expect(typeof parsed.before_controls_sha256).toBe("string");
    expect(typeof parsed.after_controls_sha256).toBe("string");
    expect((parsed.before_controls_sha256 as string)).toMatch(/^[0-9a-f]{64}$/);
    expect((parsed.after_controls_sha256 as string)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("errors when the post-write verification GET reports controls === null after a non-empty PUT", async () => {
    const openingRemote = remote("m1\n", ["a"], "T1");
    const verifyRemote = remote("m2\n", null, "T2"); // server did not persist / cannot initialize the edit list
    const { client: fakeClient, calls } = makeFakeClient([openingRemote, verifyRemote]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: true });

    const result = await callPut(client, {
      projectId,
      confirmProjectId: projectId,
      orgId,
      expectedUpdatedAt: "T1",
      baseControls: ["a"],
      desiredControls: ["a", "b"],
    });

    expect(result.isError).toBe(true);
    expect(calls.filter((c) => c.type === "put")).toHaveLength(1);
    expect(calls.filter((c) => c.type === "get")).toHaveLength(2);
  });

  it("first-edit from null controls: null -> entry-a", async () => {
    const openingRemote = remote("# synthetic doc\n", null, "T1");
    const verifyRemote = remote("# synthetic doc\n", ["entry-a"], "T2");
    const { client: fakeClient, calls } = makeFakeClient([openingRemote, verifyRemote]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: true });

    const result = await callPut(client, {
      projectId,
      confirmProjectId: projectId,
      orgId,
      expectedUpdatedAt: "T1",
      baseControls: [],
      desiredControls: ["entry-a"],
    });

    expect(result.isError).toBeFalsy();
    const putCalls = calls.filter((c): c is Extract<RecordedCall, { type: "put" }> => c.type === "put");
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].controls).toEqual(["entry-a"]);
    const parsed = jsonOf(result);
    expect(parsed.action).toBe("written");
    expect(parsed.controls_count).toBe(1);
  });

  it("clear-all with null verify is NOT an error", async () => {
    const openingRemote = remote("# synthetic doc\n", ["entry-a"], "T1");
    const verifyRemote = remote("# synthetic doc\n", null, "T2");
    const { client: fakeClient, calls } = makeFakeClient([openingRemote, verifyRemote]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: true });

    const result = await callPut(client, {
      projectId,
      confirmProjectId: projectId,
      orgId,
      expectedUpdatedAt: "T1",
      baseControls: ["entry-a"],
      desiredControls: [],
    });

    expect(result.isError).toBeFalsy();
    const putCalls = calls.filter((c): c is Extract<RecordedCall, { type: "put" }> => c.type === "put");
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].controls).toEqual([]);
    const parsed = jsonOf(result);
    expect(parsed.action).toBe("written");
    expect(parsed.controls_count).toBe(0);
  });

  it("error paths leak no control text", async () => {
    const marker = "SECRET-MARKER";
    const openingRemote = remote("# synthetic doc\n", [`${marker}-entry`], "T1");
    const { client: fakeClient } = makeFakeClient([openingRemote]);
    const client = await connect({ auth: makeFakeAuth(), client: fakeClient, memoryWriteEnabled: true });

    const result = await callPut(client, {
      projectId,
      confirmProjectId: projectId,
      orgId,
      expectedUpdatedAt: "T2", // stale: live remote is at T1
      baseControls: [`${marker}-entry`],
      desiredControls: [`${marker}-desired`],
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).not.toContain(marker);
    expect(text).not.toContain("entry");
    expect(text).not.toContain("desired");
  });
});
