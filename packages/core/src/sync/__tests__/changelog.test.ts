import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendChangelog,
  renderChangelogSection,
  CHANGELOG_FILENAME,
} from "../changelog.js";
import type { ConversationDiff } from "../diff.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "csync-changelog-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const initialDiff: ConversationDiff = {
  isInitial: true,
  isUnchanged: false,
  branches: [
    {
      leafUuid: "leaf-1",
      shortLabel: "leaf-1",
      isMain: true,
      isNew: true,
      hasNewMessages: false,
      newMessageIndices: [0, 1],
      messages: [
        { uuid: "a", parent_message_uuid: "00000000", index: 0, sender: "human", text: "", created_at: "", updated_at: "", attachments: [], files_v2: [], sync_sources: [] } as any,
        { uuid: "b", parent_message_uuid: "a", index: 1, sender: "assistant", text: "", created_at: "", updated_at: "", attachments: [], files_v2: [], sync_sources: [] } as any,
      ],
    },
  ],
  artifacts: { added: [{ path: "/mnt/user-data/outputs/x.md", size: 10, created_at: "" }], changed: [], removed: [] },
  metadata: {},
};

const incrementalDiff: ConversationDiff = {
  isInitial: false,
  isUnchanged: false,
  branches: [
    {
      leafUuid: "leaf-1",
      shortLabel: "leaf-1",
      isMain: true,
      isNew: false,
      hasNewMessages: true,
      newMessageIndices: [2, 3],
      messages: [],
    },
    {
      leafUuid: "leaf-2",
      shortLabel: "leaf-2",
      isMain: false,
      isNew: true,
      hasNewMessages: false,
      newMessageIndices: [4],
      messages: [
        { uuid: "z", parent_message_uuid: "a", index: 4, sender: "assistant", text: "", created_at: "", updated_at: "", attachments: [], files_v2: [], sync_sources: [] } as any,
      ],
    },
  ],
  artifacts: {
    added: [],
    changed: [{ path: "/mnt/user-data/outputs/x.md", size: 20, created_at: "", prev_size: 10, prev_created_at: "" }],
    removed: [],
  },
  metadata: { renamed: { from: "old", to: "new" } },
};

describe("renderChangelogSection", () => {
  it("returns initial export section for first sync", () => {
    const out = renderChangelogSection(initialDiff, new Date("2026-04-30T00:00:00Z"));
    expect(out).toContain("## 2026-04-30");
    expect(out).toContain("### Initial export");
    expect(out).toContain("1 branch(es)");
  });

  it("returns added/changed sections for incremental", () => {
    const out = renderChangelogSection(incrementalDiff, new Date("2026-04-30T00:00:00Z"));
    expect(out).toContain("### Added");
    expect(out).toContain("Branch `alt-leaf-2`");
    expect(out).toContain("### Changed");
    expect(out).toContain("2 new message(s) on current branch (indices 2-3)");
    expect(out).toContain("Conversation renamed: `old` -> `new`");
    expect(out).toContain("Artifact `x.md` updated (10 -> 20 bytes)");
  });
});

describe("appendChangelog", () => {
  it("creates a new CHANGELOG.md with header on first call", () => {
    const section = renderChangelogSection(initialDiff, new Date("2026-04-30T00:00:00Z"));
    expect(appendChangelog(dir, section)).toBe(true);
    const content = fs.readFileSync(path.join(dir, CHANGELOG_FILENAME), "utf-8");
    expect(content.startsWith("# Changelog")).toBe(true);
    expect(content).toContain("## 2026-04-30");
    expect(content).toContain("### Initial export");
  });

  it("prepends new dates above older entries", () => {
    appendChangelog(dir, renderChangelogSection(initialDiff, new Date("2026-04-29T00:00:00Z")));
    appendChangelog(dir, renderChangelogSection(incrementalDiff, new Date("2026-04-30T00:00:00Z")));
    const content = fs.readFileSync(path.join(dir, CHANGELOG_FILENAME), "utf-8");
    const i30 = content.indexOf("## 2026-04-30");
    const i29 = content.indexOf("## 2026-04-29");
    expect(i30).toBeGreaterThan(-1);
    expect(i29).toBeGreaterThan(i30);
  });

  it("merges same-day calls into a single date heading", () => {
    appendChangelog(dir, renderChangelogSection(initialDiff, new Date("2026-04-30T00:00:00Z")));
    appendChangelog(dir, renderChangelogSection(incrementalDiff, new Date("2026-04-30T01:00:00Z")));
    const content = fs.readFileSync(path.join(dir, CHANGELOG_FILENAME), "utf-8");
    const occurrences = content.match(/^## 2026-04-30$/gm) ?? [];
    expect(occurrences.length).toBe(1);
    expect(content).toContain("### Initial export");
    expect(content).toContain("### Added");
  });

  it("returns false and writes nothing for empty sections", () => {
    expect(appendChangelog(dir, "")).toBe(false);
    expect(fs.existsSync(path.join(dir, CHANGELOG_FILENAME))).toBe(false);
  });
});
