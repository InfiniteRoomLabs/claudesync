import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planProjectMemoryPush } from "@core/memory/push.js";
import { pullProjectMemory, computePrincipalFingerprint } from "@core/memory/pull.js";
import { writeMemoryState, readMemoryState } from "@core/memory/state.js";

let dir: string;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
function mkdir() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-plan-"));
  return dir;
}

const base = { accountId: "acct-1", projectId: "proj-1", now: "2026-07-15T00:00:00.000Z" };
const remote = (memory: string, controls: string[] | null, updated_at: string | null = "2026-07-14T00:00:00Z") =>
  ({ memory, controls, updated_at });

/** Bootstrap a directory with a valid sidecar + edits.md via a real pull, so planner tests start from realistic on-disk state. */
function bootstrapPulled(memory: string, controls: string[]) {
  const d = mkdir();
  pullProjectMemory({ ...base, dir: d, remote: remote(memory, controls) });
  return d;
}

describe("planProjectMemoryPush", () => {
  it("throws when no sidecar exists in dir", () => {
    const d = mkdir();
    expect(() =>
      planProjectMemoryPush({
        remote: remote("m\n", ["a"]),
        accountId: "acct-1",
        projectId: "proj-1",
        dir: d,
      }),
    ).toThrow(/projects memory pull/);
  });

  it("throws when edits.md is missing (never an implicit clear)", () => {
    const d = bootstrapPulled("m\n", ["a"]);
    fs.rmSync(path.join(d, "edits.md"));
    expect(() =>
      planProjectMemoryPush({
        remote: remote("m\n", ["a"]),
        accountId: "acct-1",
        projectId: "proj-1",
        dir: d,
      }),
    ).toThrow(/edits\.md/);
  });

  it("does not require edits.md when localControlsOverride is supplied", () => {
    const d = bootstrapPulled("m\n", ["a"]);
    fs.rmSync(path.join(d, "edits.md"));
    const plan = planProjectMemoryPush({
      remote: remote("m\n", ["a"]),
      accountId: "acct-1",
      projectId: "proj-1",
      dir: d,
      localControlsOverride: ["a"],
    });
    expect(plan.action).toBe("no-op");
  });

  it("throws when the sidecar's project_uuid does not match the target project", () => {
    const d = bootstrapPulled("m\n", ["a"]);
    expect(() =>
      planProjectMemoryPush({
        remote: remote("m\n", ["a"]),
        accountId: "acct-1",
        projectId: "some-other-project",
        dir: d,
      }),
    ).toThrow(/project/i);
  });

  it("throws a principal-mismatch error naming --adopt-legacy-principal", () => {
    const d = bootstrapPulled("m\n", ["a"]);
    expect(() =>
      planProjectMemoryPush({
        remote: remote("m\n", ["a"]),
        accountId: "a-different-account",
        projectId: "proj-1",
        dir: d,
      }),
    ).toThrow(/--adopt-legacy-principal/);
  });

  it("remote.controls === null -> action is no-memory", () => {
    const d = bootstrapPulled("m\n", ["a"]);
    const plan = planProjectMemoryPush({
      remote: remote("", null, null),
      accountId: "acct-1",
      projectId: "proj-1",
      dir: d,
    });
    expect(plan.action).toBe("no-memory");
    expect(plan.mergedControls).toEqual([]);
    expect(plan.remoteControls).toEqual([]);
    expect(plan.localAdds).toBe(0);
    expect(plan.localDeletes).toBe(0);
    expect(plan.remoteAdds).toBe(0);
    expect(plan.remoteDeletes).toBe(0);
  });

  it("merged equals remote -> action is no-op", () => {
    const d = bootstrapPulled("m\n", ["a", "b"]);
    const plan = planProjectMemoryPush({
      remote: remote("m\n", ["a", "b"]),
      accountId: "acct-1",
      projectId: "proj-1",
      dir: d,
    });
    expect(plan.action).toBe("no-op");
    expect(plan.mergedControls).toEqual(["a", "b"]);
  });

  it("local adds + a concurrent remote add -> put, remote add preserved, correct counts", () => {
    const d = bootstrapPulled("m\n", ["a"]);
    // Simulate a local edit: append a new local control entry to edits.md.
    fs.writeFileSync(path.join(d, "edits.md"), "a\n---\nb\n", "utf-8");
    const plan = planProjectMemoryPush({
      // Concurrent remote add: someone added "c" on claude.ai since the last pull.
      remote: remote("m\n", ["a", "c"]),
      accountId: "acct-1",
      projectId: "proj-1",
      dir: d,
    });
    expect(plan.action).toBe("put");
    expect(plan.mergedControls).toEqual(["a", "c", "b"]);
    expect(plan.localAdds).toBe(1);
    expect(plan.localDeletes).toBe(0);
    expect(plan.remoteAdds).toBe(1);
    expect(plan.remoteDeletes).toBe(0);
  });

  it("a local entry containing a --- line throws", () => {
    const d = bootstrapPulled("m\n", ["a"]);
    expect(() =>
      planProjectMemoryPush({
        remote: remote("m\n", ["a"]),
        accountId: "acct-1",
        projectId: "proj-1",
        dir: d,
        localControlsOverride: ["a line\n---\nanother line"],
      }),
    ).toThrow(/---/);
  });

  it("plan never mutates the filesystem (pure)", () => {
    const d = bootstrapPulled("m\n", ["a"]);
    const before = fs.readFileSync(path.join(d, "edits.md"), "utf-8");
    const stateBefore = readMemoryState(d);
    planProjectMemoryPush({
      remote: remote("m2\n", ["a", "c"]),
      accountId: "acct-1",
      projectId: "proj-1",
      dir: d,
    });
    expect(fs.readFileSync(path.join(d, "edits.md"), "utf-8")).toBe(before);
    expect(readMemoryState(d)).toEqual(stateBefore);
    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf-8")).toBe("m\n");
  });

  it("echoes projectId and remoteUpdatedAt from the inputs", () => {
    const d = bootstrapPulled("m\n", ["a"]);
    const plan = planProjectMemoryPush({
      remote: remote("m\n", ["a"], "2026-07-15T09:00:00Z"),
      accountId: "acct-1",
      projectId: "proj-1",
      dir: d,
    });
    expect(plan.projectId).toBe("proj-1");
    expect(plan.remoteUpdatedAt).toBe("2026-07-15T09:00:00Z");
  });

  it("sanity: computePrincipalFingerprint is exported and used for the mismatch check", () => {
    const d = bootstrapPulled("m\n", ["a"]);
    const state = readMemoryState(d)!;
    expect(state.principal_fingerprint).toBe(computePrincipalFingerprint("acct-1"));
    // Rewrite the sidecar's fingerprint directly to simulate a legacy (differently-keyed) sidecar.
    writeMemoryState(d, { ...state, principal_fingerprint: "some-other-fingerprint" });
    expect(() =>
      planProjectMemoryPush({
        remote: remote("m\n", ["a"]),
        accountId: "acct-1",
        projectId: "proj-1",
        dir: d,
      }),
    ).toThrow(/--adopt-legacy-principal/);
  });
});
