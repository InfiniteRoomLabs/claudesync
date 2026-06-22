import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readSyncState,
  writeSyncState,
  STATE_FILENAME,
  type SyncState,
} from "@core/sync/state.js";

let dir: string;

function sample(): SyncState {
  return {
    schema_version: 1,
    conversation_uuid: "conv-1",
    conversation_name: "test",
    model: "claude-opus-4-7",
    updated_at: "2026-04-30T13:55:03.195890Z",
    current_leaf_message_uuid: "leaf-1",
    leaves: [{ uuid: "leaf-1", last_message_index: 13 }],
    artifacts: [
      { path: "/mnt/user-data/outputs/x.md", size: 10, created_at: "2026-04-30T00:00:00Z" },
    ],
    last_sync_at: "2026-04-30T14:00:00Z",
    last_sync_action: "full",
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "csync-state-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("sync state", () => {
  it("returns undefined when state file does not exist", () => {
    expect(readSyncState(dir)).toBeUndefined();
  });

  it("round-trips a state object", () => {
    const s = sample();
    writeSyncState(dir, s);
    const loaded = readSyncState(dir);
    expect(loaded).toEqual(s);
  });

  it("writes atomically (no .tmp left behind on success)", () => {
    writeSyncState(dir, sample());
    const entries = fs.readdirSync(dir);
    expect(entries).toContain(STATE_FILENAME);
    expect(entries).not.toContain(STATE_FILENAME + ".tmp");
  });

  it("throws on corrupted JSON rather than silently bootstrapping", () => {
    fs.writeFileSync(path.join(dir, STATE_FILENAME), "{not json", "utf-8");
    expect(() => readSyncState(dir)).toThrow();
  });

  it("defaults model to null when reading a pre-model state file", () => {
    // Old state files (written before the model field existed) omit it.
    const { model: _omit, ...legacy } = sample();
    fs.writeFileSync(
      path.join(dir, STATE_FILENAME),
      JSON.stringify(legacy),
      "utf-8",
    );
    const loaded = readSyncState(dir);
    expect(loaded?.model).toBeNull();
  });

  it("round-trips a null model", () => {
    const s = { ...sample(), model: null };
    writeSyncState(dir, s);
    expect(readSyncState(dir)).toEqual(s);
  });

  it("rejects state with wrong schema version", () => {
    fs.writeFileSync(
      path.join(dir, STATE_FILENAME),
      JSON.stringify({ ...sample(), schema_version: 99 }),
      "utf-8",
    );
    expect(() => readSyncState(dir)).toThrow();
  });
});
