import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyProjectMemoryPush } from "@core/memory/push.js";
import { pullProjectMemory } from "@core/memory/pull.js";
import { readMemoryState, MEMORY_STATE_FILENAME } from "@core/memory/state.js";
import type { ProjectMemory } from "@core/models/types.js";

let dir: string;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
function mkdir() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-apply-"));
  return dir;
}

const orgId = "org-1";
const accountId = "acct-1";
const projectId = "proj-1";
const LOCK_FILENAME = ".claudesync-memory.lock";

const remote = (memory: string, controls: string[] | null, updated_at: string | null = "2026-07-14T00:00:00Z") =>
  ({ memory, controls, updated_at }) as ProjectMemory;

/** Bootstrap a directory with a valid sidecar + edits.md via a real pull. */
function bootstrapPulled(d: string, memory: string, controls: string[]) {
  pullProjectMemory({ accountId, projectId, dir: d, now: "2026-07-14T00:00:00.000Z", remote: remote(memory, controls) });
}

type RecordedCall = { type: "get" } | { type: "put"; controls: string[]; timeoutMs?: number };

/**
 * A minimal fake client recording every call in order. `getResponses` is
 * consumed one entry per GET (the last entry repeats for any GET beyond the
 * list's length). `putImpl` lets a test override PUT behavior (e.g. to
 * throw an ambiguous-write error) instead of the default no-op success.
 */
function makeFakeClient(
  getResponses: ProjectMemory[],
  putImpl?: (controls: string[]) => Promise<void>,
) {
  const calls: RecordedCall[] = [];
  let getCallCount = 0;
  const client = {
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
      if (putImpl) await putImpl(controls);
    },
  };
  return { client, calls };
}

describe("applyProjectMemoryPush", () => {
  it("no-memory: GETs, skips PUT, returns no-memory", async () => {
    const d = mkdir();
    bootstrapPulled(d, "m\n", ["a"]);
    const { client, calls } = makeFakeClient([remote("", null, null)]);
    const out = await applyProjectMemoryPush({
      client,
      orgId,
      accountId,
      projectId,
      dir: d,
      now: "2026-07-15T00:00:00.000Z",
    });
    expect(out.action).toBe("no-memory");
    expect(calls).toEqual([{ type: "get" }]);
  });

  it("no-op: skips PUT but converges local files (materializes source push)", async () => {
    const d = mkdir();
    bootstrapPulled(d, "m1\n", ["a"]);
    const { client, calls } = makeFakeClient([remote("m1\n", ["a"], "2026-07-15T05:00:00Z")]);
    const out = await applyProjectMemoryPush({
      client,
      orgId,
      accountId,
      projectId,
      dir: d,
      now: "2026-07-15T00:00:00.000Z",
    });
    expect(out.action).toBe("unchanged");
    expect(calls.filter((c) => c.type === "put")).toHaveLength(0);
    const state = readMemoryState(d)!;
    expect(state.last_push_at).toBe("2026-07-15T00:00:00.000Z");
    expect(state.remote_updated_at).toBe("2026-07-15T05:00:00Z");
  });

  it("GET precedes every PUT, PUT called exactly once, PUT receives the normalized merged array including a remote add; success materializes and advances the sidecar", async () => {
    const d = mkdir();
    bootstrapPulled(d, "m1\n", ["a"]);
    // Local add: append "b" to edits.md.
    fs.writeFileSync(path.join(d, "edits.md"), "a\n---\nb\n", "utf-8");

    const openingRemote = remote("m1\n", ["a", "c"], "2026-07-15T05:00:00Z"); // concurrent remote add "c"
    const verifyRemote = remote("m2 regenerated\n", ["a", "c", "b"], "2026-07-15T06:00:00Z");
    const { client, calls } = makeFakeClient([openingRemote, verifyRemote]);

    const out = await applyProjectMemoryPush({
      client,
      orgId,
      accountId,
      projectId,
      dir: d,
      now: "2026-07-15T00:00:00.000Z",
    });

    expect(out.action).toBe("written");
    expect(out.remoteUpdatedAt).toBe("2026-07-15T06:00:00Z");

    // GET, PUT, GET -- PUT preceded by a GET, and exactly one PUT total.
    expect(calls.map((c) => c.type)).toEqual(["get", "put", "get"]);
    const putCall = calls.find((c) => c.type === "put");
    expect(putCall).toBeDefined();
    expect((putCall as { controls: string[] }).controls).toEqual(["a", "c", "b"]);

    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf-8")).toBe("m2 regenerated\n");
    const editsAfter = fs.readFileSync(path.join(d, "edits.md"), "utf-8");
    expect(editsAfter).toContain("a");
    expect(editsAfter).toContain("c");
    expect(editsAfter).toContain("b");

    const state = readMemoryState(d)!;
    expect(state.last_push_at).toBe("2026-07-15T00:00:00.000Z");
    expect(state.remote_updated_at).toBe("2026-07-15T06:00:00Z");
    expect(state.controls_base).toHaveLength(3);
  });

  it("forwards timeoutMs to putProjectMemoryControls", async () => {
    const d = mkdir();
    bootstrapPulled(d, "m1\n", ["a"]);
    fs.writeFileSync(path.join(d, "edits.md"), "a\n---\nb\n", "utf-8");
    const { client, calls } = makeFakeClient([
      remote("m1\n", ["a"], "2026-07-15T05:00:00Z"),
      remote("m2\n", ["a", "b"], "2026-07-15T06:00:00Z"),
    ]);
    await applyProjectMemoryPush({
      client,
      orgId,
      accountId,
      projectId,
      dir: d,
      now: "2026-07-15T00:00:00.000Z",
      timeoutMs: 12_345,
    });
    const putCall = calls.find((c) => c.type === "put") as { timeoutMs?: number };
    expect(putCall.timeoutMs).toBe(12_345);
  });

  it("a PUT timeout is never retried and its ambiguous-write error surfaces as-is", async () => {
    const d = mkdir();
    bootstrapPulled(d, "m1\n", ["a"]);
    fs.writeFileSync(path.join(d, "edits.md"), "a\n---\nb\n", "utf-8");
    const ambiguousMessage =
      "Project memory controls write timed out waiting for the server's response. " +
      "The write may have already been applied server-side -- do NOT automatically " +
      "retry this call. Re-run push to reconcile local and remote state.";
    const { client, calls } = makeFakeClient(
      [remote("m1\n", ["a"], "2026-07-15T05:00:00Z")],
      async () => {
        throw new Error(ambiguousMessage);
      },
    );
    await expect(
      applyProjectMemoryPush({
        client,
        orgId,
        accountId,
        projectId,
        dir: d,
        now: "2026-07-15T00:00:00.000Z",
      }),
    ).rejects.toThrow(/do NOT automatically.*retry/i);

    // Exactly one GET, exactly one PUT -- no retry loop, no second verification GET
    // (since the PUT itself threw before verification could run).
    expect(calls.map((c) => c.type)).toEqual(["get", "put"]);
  });

  it("verify-mismatch: post-PUT GET returns different controls -- writes MEMORY.md, leaves edits.md and controls_base unchanged", async () => {
    const d = mkdir();
    bootstrapPulled(d, "m1\n", ["a"]);
    fs.writeFileSync(path.join(d, "edits.md"), "a\n---\nb\n", "utf-8");
    const editsBefore = fs.readFileSync(path.join(d, "edits.md"), "utf-8");
    const stateBefore = readMemoryState(d)!;

    const openingRemote = remote("m1\n", ["a"], "2026-07-15T05:00:00Z");
    // A concurrent external write raced this push: the server's post-PUT
    // controls differ from what we intended to send (["a", "b"]).
    const verifyRemote = remote("m2 someone-elses-write\n", ["a", "x"], "2026-07-15T06:00:00Z");
    const { client, calls } = makeFakeClient([openingRemote, verifyRemote]);

    const out = await applyProjectMemoryPush({
      client,
      orgId,
      accountId,
      projectId,
      dir: d,
      now: "2026-07-15T00:00:00.000Z",
    });

    expect(out.action).toBe("verify-mismatch");
    expect(calls.map((c) => c.type)).toEqual(["get", "put", "get"]);

    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf-8")).toBe("m2 someone-elses-write\n");
    expect(fs.readFileSync(path.join(d, "edits.md"), "utf-8")).toBe(editsBefore);

    const stateAfter = readMemoryState(d)!;
    expect(stateAfter.controls_base).toEqual(stateBefore.controls_base);
    expect(stateAfter.memory_content_sha256).not.toBe(stateBefore.memory_content_sha256);
    expect(stateAfter.remote_updated_at).toBe("2026-07-15T06:00:00Z");
  });

  it("throws if the post-PUT verification GET reports controls === null", async () => {
    const d = mkdir();
    bootstrapPulled(d, "m1\n", ["a"]);
    fs.writeFileSync(path.join(d, "edits.md"), "a\n---\nb\n", "utf-8");
    const { client } = makeFakeClient([
      remote("m1\n", ["a"], "2026-07-15T05:00:00Z"),
      remote("", null, null),
    ]);
    await expect(
      applyProjectMemoryPush({
        client,
        orgId,
        accountId,
        projectId,
        dir: d,
        now: "2026-07-15T00:00:00.000Z",
      }),
    ).rejects.toThrow(/lost|null|controls/i);
  });

  it("simulated crash-after-PUT: re-running apply against a remote that already equals the intended merge becomes unchanged", async () => {
    const d = mkdir();
    bootstrapPulled(d, "m1\n", ["a"]);
    fs.writeFileSync(path.join(d, "edits.md"), "a\n---\nb\n", "utf-8");
    // The remote already reflects a prior (crashed-before-materializing) PUT of ["a", "b"].
    const { client, calls } = makeFakeClient([remote("m2\n", ["a", "b"], "2026-07-15T06:00:00Z")]);
    const out = await applyProjectMemoryPush({
      client,
      orgId,
      accountId,
      projectId,
      dir: d,
      now: "2026-07-15T00:00:00.000Z",
    });
    expect(out.action).toBe("unchanged");
    expect(calls.filter((c) => c.type === "put")).toHaveLength(0);
    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf-8")).toBe("m2\n");
  });

  it("holds the lock across the body and releases it after (lockfile gone)", async () => {
    const d = mkdir();
    bootstrapPulled(d, "m1\n", ["a"]);
    const lockPath = path.join(d, LOCK_FILENAME);
    let sawLockDuring = false;
    const client = {
      async getProjectMemory(): Promise<ProjectMemory> {
        sawLockDuring = sawLockDuring || fs.existsSync(lockPath);
        return remote("m1\n", ["a"], "2026-07-15T05:00:00Z");
      },
      async putProjectMemoryControls(): Promise<void> {
        // not reached in this no-op scenario
      },
    };
    expect(fs.existsSync(lockPath)).toBe(false);
    await applyProjectMemoryPush({
      client,
      orgId,
      accountId,
      projectId,
      dir: d,
      now: "2026-07-15T00:00:00.000Z",
    });
    expect(sawLockDuring).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releases the lock even when the plan throws (e.g. a bad projectId)", async () => {
    const d = mkdir();
    bootstrapPulled(d, "m1\n", ["a"]);
    const lockPath = path.join(d, LOCK_FILENAME);
    const { client } = makeFakeClient([remote("m1\n", ["a"], "2026-07-15T05:00:00Z")]);
    await expect(
      applyProjectMemoryPush({
        client,
        orgId,
        accountId,
        projectId: "wrong-project",
        dir: d,
        now: "2026-07-15T00:00:00.000Z",
      }),
    ).rejects.toThrow();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("sidecar never carries memory or control text, even after a written push", async () => {
    const d = mkdir();
    bootstrapPulled(d, "m1\n", ["a"]);
    fs.writeFileSync(path.join(d, "edits.md"), "a\n---\nvery secret local text\n", "utf-8");
    const { client } = makeFakeClient([
      remote("m1\n", ["a"], "2026-07-15T05:00:00Z"),
      remote("very secret regenerated memory\n", ["a", "very secret local text"], "2026-07-15T06:00:00Z"),
    ]);
    await applyProjectMemoryPush({
      client,
      orgId,
      accountId,
      projectId,
      dir: d,
      now: "2026-07-15T00:00:00.000Z",
    });
    const raw = fs.readFileSync(path.join(d, MEMORY_STATE_FILENAME), "utf-8");
    expect(raw).not.toContain("secret");
  });
});
