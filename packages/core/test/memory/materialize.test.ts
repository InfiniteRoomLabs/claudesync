import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeProjectMemorySnapshot } from "@core/memory/materialize.js";
import { readMemoryState, MEMORY_STATE_FILENAME } from "@core/memory/state.js";
import { parseEdits } from "@core/memory/edits.js";

let dir: string;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
function mkdir() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "materialize-"));
  return dir;
}

const base = { accountId: "acct-1", projectId: "proj-1" };
const remote = (memory: string, controls: string[], updated_at: string | null = "2026-07-14T00:00:00Z") => ({
  memory,
  controls,
  updated_at,
});

describe("materializeProjectMemorySnapshot", () => {
  it("writes MEMORY.md, edits.md, and the sidecar", () => {
    const d = mkdir();
    const out = materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior: undefined,
      now: "2026-07-15T00:00:00.000Z",
      source: "pull",
      remote: remote("**Memory**\n", ["Prefer rye.", "Open 6am."]),
    });
    expect(out.controlsCount).toBe(2);
    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf-8")).toBe("**Memory**\n");
    expect(fs.existsSync(path.join(d, "edits.md"))).toBe(true);
    expect(readMemoryState(d)).toBeDefined();
  });

  // POSIX mode bits are not representable on Windows (fs reports 0o666/0o777).
  it.skipIf(process.platform === "win32")("creates dir 0700 and writes files 0600", () => {
    const d = mkdir();
    materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior: undefined,
      now: "2026-07-15T00:00:00.000Z",
      source: "pull",
      remote: remote("m\n", ["a"]),
    });
    expect(fs.statSync(d).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(d, "MEMORY.md")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(d, "edits.md")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(d, MEMORY_STATE_FILENAME)).mode & 0o777).toBe(0o600);
  });

  it("edits.md round-trips through parseEdits, trimming and dropping blanks", () => {
    const d = mkdir();
    materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior: undefined,
      now: "2026-07-15T00:00:00.000Z",
      source: "pull",
      remote: remote("m\n", ["  Prefer rye.  ", "", "   ", "Open 6am."]),
    });
    const text = fs.readFileSync(path.join(d, "edits.md"), "utf-8");
    expect(parseEdits(text)).toEqual(["Prefer rye.", "Open 6am."]);
  });

  it("sidecar holds only hashes -- memory and edit text never land in it", () => {
    const d = mkdir();
    materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior: undefined,
      now: "2026-07-15T00:00:00.000Z",
      source: "pull",
      remote: remote("very secret memory text\n", ["very secret control text"]),
    });
    const raw = fs.readFileSync(path.join(d, MEMORY_STATE_FILENAME), "utf-8");
    expect(raw).not.toContain("very secret memory text");
    expect(raw).not.toContain("very secret control text");
    const st = readMemoryState(d);
    expect(st?.memory_content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(st?.controls_base).toHaveLength(1);
    expect(st?.controls_base[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(st?.remote_snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("source push stamps last_push_at and preserves prior last_pull_at", () => {
    const d = mkdir();
    materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior: undefined,
      now: "2026-07-14T00:00:00.000Z",
      source: "pull",
      remote: remote("m1\n", ["a"]),
    });
    const priorState = readMemoryState(d)!;
    expect(priorState.last_pull_at).toBe("2026-07-14T00:00:00.000Z");
    expect(priorState.last_push_at).toBeUndefined();

    materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior: priorState,
      now: "2026-07-15T00:00:00.000Z",
      source: "push",
      remote: remote("m2\n", ["a", "b"]),
    });
    const afterPush = readMemoryState(d)!;
    expect(afterPush.last_push_at).toBe("2026-07-15T00:00:00.000Z");
    expect(afterPush.last_pull_at).toBe("2026-07-14T00:00:00.000Z");
  });

  it("source pull stamps last_pull_at and preserves prior last_push_at", () => {
    const d = mkdir();
    materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior: undefined,
      now: "2026-07-14T00:00:00.000Z",
      source: "push",
      remote: remote("m1\n", ["a"]),
    });
    const priorState = readMemoryState(d)!;
    expect(priorState.last_push_at).toBe("2026-07-14T00:00:00.000Z");
    expect(priorState.last_pull_at).toBeUndefined();

    materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior: priorState,
      now: "2026-07-15T00:00:00.000Z",
      source: "pull",
      remote: remote("m2\n", ["a"]),
    });
    const after = readMemoryState(d)!;
    expect(after.last_pull_at).toBe("2026-07-15T00:00:00.000Z");
    expect(after.last_push_at).toBe("2026-07-14T00:00:00.000Z");
  });

  it("leaves no .tmp files behind after a successful write", () => {
    const d = mkdir();
    materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior: undefined,
      now: "2026-07-15T00:00:00.000Z",
      source: "pull",
      remote: remote("m\n", ["a"]),
    });
    const entries = fs.readdirSync(d);
    expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("memoryChanged is false with no prior state (initial materialize)", () => {
    const d = mkdir();
    const out = materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior: undefined,
      now: "2026-07-15T00:00:00.000Z",
      source: "pull",
      remote: remote("m\n", ["a"]),
    });
    expect(out.memoryChanged).toBe(false);
  });

  it("memoryChanged is true when memory content differs from prior", () => {
    const d = mkdir();
    materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior: undefined,
      now: "2026-07-14T00:00:00.000Z",
      source: "pull",
      remote: remote("m1\n", ["a"]),
    });
    const prior = readMemoryState(d)!;
    const out = materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior,
      now: "2026-07-15T00:00:00.000Z",
      source: "pull",
      remote: remote("m2\n", ["a"]),
    });
    expect(out.memoryChanged).toBe(true);
  });

  it("memoryChanged is false when memory content is unchanged from prior", () => {
    const d = mkdir();
    materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior: undefined,
      now: "2026-07-14T00:00:00.000Z",
      source: "pull",
      remote: remote("m1\n", ["a"]),
    });
    const prior = readMemoryState(d)!;
    const out = materializeProjectMemorySnapshot({
      ...base,
      dir: d,
      prior,
      now: "2026-07-15T00:00:00.000Z",
      source: "pull",
      remote: remote("m1\n", ["a", "b"]),
    });
    expect(out.memoryChanged).toBe(false);
  });
});
