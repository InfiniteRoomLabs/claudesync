import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pullProjectMemory, computePrincipalFingerprint } from "@core/memory/pull.js";
import { readMemoryState } from "@core/memory/state.js";
import { parseEdits } from "@core/memory/edits.js";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
function mkdir() { dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-")); return dir; }

const base = { accountId: "acct-1", projectId: "proj-1", now: "2026-07-13T00:00:00.000Z" };
const remote = (memory: string, controls: string[] | null, updated_at: string | null = "2026-07-12T00:00:00Z") =>
  ({ memory, controls, updated_at });

describe("pullProjectMemory", () => {
  it("no-memory: ungenerated project writes nothing", () => {
    const d = mkdir();
    const out = pullProjectMemory({ ...base, dir: d, remote: remote("", null, null) });
    expect(out.action).toBe("no-memory");
    expect(fs.existsSync(path.join(d, "MEMORY.md"))).toBe(false);
  });

  it("initial pull writes MEMORY.md, edits.md, and sidecar", () => {
    const d = mkdir();
    const out = pullProjectMemory({ ...base, dir: d, remote: remote("**Memory**\n", ["Prefer rye.", "Open 6am."]) });
    expect(out.action).toBe("written");
    expect(out.controlsCount).toBe(2);
    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf-8")).toBe("**Memory**\n");
    expect(parseEdits(fs.readFileSync(path.join(d, "edits.md"), "utf-8"))).toEqual(["Prefer rye.", "Open 6am."]);
    const st = readMemoryState(d);
    expect(st?.project_uuid).toBe("proj-1");
    expect(st?.principal_fingerprint).toBe(computePrincipalFingerprint("acct-1"));
  });

  it("is idempotent: second identical pull is unchanged", () => {
    const d = mkdir();
    const r = remote("**Memory**\n", ["Prefer rye."]);
    pullProjectMemory({ ...base, dir: d, remote: r });
    const mtime1 = fs.statSync(path.join(d, "MEMORY.md")).mtimeMs;
    const out = pullProjectMemory({ ...base, dir: d, remote: r });
    expect(out.action).toBe("unchanged");
    expect(fs.statSync(path.join(d, "MEMORY.md")).mtimeMs).toBe(mtime1);
  });

  it("nightly regen: changed remote memory rewrites the doc", () => {
    const d = mkdir();
    pullProjectMemory({ ...base, dir: d, remote: remote("v1\n", ["a"]) });
    const out = pullProjectMemory({ ...base, dir: d, remote: remote("v2 regenerated\n", ["a"], "2026-07-13T07:00:00Z") });
    expect(out.action).toBe("written");
    expect(out.memoryChanged).toBe(true);
    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf-8")).toBe("v2 regenerated\n");
  });

  it("principal mismatch fails closed", () => {
    const d = mkdir();
    pullProjectMemory({ ...base, dir: d, remote: remote("m\n", ["a"]) });
    expect(() =>
      pullProjectMemory({ ...base, accountId: "different-acct", dir: d, remote: remote("m2\n", ["a"]) })
    ).toThrow(/principal/i);
  });

  it("local edit to MEMORY.md + changed remote = conflict, no overwrite (without force)", () => {
    const d = mkdir();
    pullProjectMemory({ ...base, dir: d, remote: remote("v1\n", ["a"]) });
    fs.writeFileSync(path.join(d, "MEMORY.md"), "locally hand-edited\n", "utf-8");
    const out = pullProjectMemory({ ...base, dir: d, remote: remote("v2\n", ["a"], "2026-07-13T07:00:00Z") });
    expect(out.action).toBe("conflict");
    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf-8")).toBe("locally hand-edited\n");
  });

  it("force overrides conflict and re-pulls", () => {
    const d = mkdir();
    pullProjectMemory({ ...base, dir: d, remote: remote("v1\n", ["a"]) });
    fs.writeFileSync(path.join(d, "MEMORY.md"), "locally hand-edited\n", "utf-8");
    const out = pullProjectMemory({ ...base, dir: d, force: true, remote: remote("v2\n", ["a"], "2026-07-13T07:00:00Z") });
    expect(out.action).toBe("written");
    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf-8")).toBe("v2\n");
  });
});
