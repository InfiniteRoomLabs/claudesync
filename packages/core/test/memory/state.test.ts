import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMemoryState, writeMemoryState, MEMORY_STATE_FILENAME } from "@core/memory/state.js";

let dir: string;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const sample = {
  schema_version: 1 as const,
  project_uuid: "proj-uuid",
  principal_fingerprint: "a".repeat(64),
  memory_content_sha256: "b".repeat(64),
  controls_base: ["c".repeat(64)],
  remote_snapshot_sha256: "d".repeat(64),
  last_pull_at: "2026-07-13T00:00:00.000Z",
  remote_updated_at: "2026-07-12T07:38:26.626000+00:00",
};

describe("memory state", () => {
  it("returns undefined when no file exists", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
    expect(readMemoryState(dir)).toBeUndefined();
  });
  it("round-trips through atomic write", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
    writeMemoryState(dir, sample);
    expect(fs.existsSync(path.join(dir, MEMORY_STATE_FILENAME))).toBe(true);
    expect(readMemoryState(dir)).toEqual(sample);
  });
  it("throws on corrupt JSON rather than silently resetting", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
    fs.writeFileSync(path.join(dir, MEMORY_STATE_FILENAME), "{not json", "utf-8");
    expect(() => readMemoryState(dir)).toThrow();
  });
});
