import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import { exportToGit, appendToGit } from "../git-exporter.js";
import type { GitBundle } from "../types.js";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csync-git-"));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const author = { name: "Claude", email: "claude@anthropic.com" };

function bundle(commits: GitBundle["commits"]): GitBundle {
  return {
    metadata: {
      conversationId: "conv-1",
      conversationName: "test",
      model: "claude-haiku-4-5",
      createdAt: "2026-04-30T13:50:00Z",
      exportedAt: "2026-04-30T14:00:00Z",
    },
    commits,
  };
}

describe("exportToGit (multi-branch)", () => {
  it("creates main + alt branches when bundle commits target branches/", async () => {
    const out = path.join(tmpRoot, "repo");
    const b = bundle([
      {
        message: "Export conversation: test",
        timestamp: "2026-04-30T13:50:00Z",
        author,
        files: {
          "conversation.md": "# main branch",
          "README.md": "main",
        },
      },
      {
        message: "Export branch: alt-019ddea7",
        timestamp: "2026-04-30T13:51:00Z",
        author,
        files: {
          "branches/019ddea7/conversation.md": "# alt branch",
          "branches/019ddea7/README.md": "alt",
        },
      },
    ]);

    await exportToGit(b, out);

    const branches = await git.listBranches({ fs, dir: out });
    expect(branches).toEqual(expect.arrayContaining(["main", "alt-019ddea7"]));

    // Main working tree should contain main's files at the root.
    expect(fs.readFileSync(path.join(out, "conversation.md"), "utf-8")).toBe("# main branch");

    // Switch to alt branch and verify its file tree.
    await git.checkout({ fs, dir: out, ref: "alt-019ddea7", force: true });
    expect(fs.readFileSync(path.join(out, "conversation.md"), "utf-8")).toBe("# alt branch");
    expect(fs.existsSync(path.join(out, "branches"))).toBe(false);
  });
});

describe("appendToGit", () => {
  it("adds a new commit on main when content changes", async () => {
    const out = path.join(tmpRoot, "repo");
    await exportToGit(
      bundle([
        {
          message: "Export conversation: test",
          timestamp: "2026-04-30T13:50:00Z",
          author,
          files: { "conversation.md": "# v1", "README.md": "r1" },
        },
      ]),
      out,
    );

    const beforeLog = await git.log({ fs, dir: out, ref: "main" });
    expect(beforeLog).toHaveLength(1);

    await appendToGit(
      bundle([
        {
          message: "Update conversation: 2 new messages",
          timestamp: "2026-04-30T14:00:00Z",
          author,
          files: { "conversation.md": "# v2", "README.md": "r2" },
        },
      ]),
      out,
    );

    const afterLog = await git.log({ fs, dir: out, ref: "main" });
    expect(afterLog.length).toBe(2);
    expect(afterLog[0].commit.message).toContain("Update conversation");
    expect(fs.readFileSync(path.join(out, "conversation.md"), "utf-8")).toBe("# v2");
  });

  it("creates a brand-new alt branch on incremental sync", async () => {
    const out = path.join(tmpRoot, "repo");
    await exportToGit(
      bundle([
        {
          message: "Export conversation: test",
          timestamp: "2026-04-30T13:50:00Z",
          author,
          files: { "conversation.md": "# main", "README.md": "r" },
        },
      ]),
      out,
    );

    expect(await git.listBranches({ fs, dir: out })).not.toContain("alt-new");

    await appendToGit(
      bundle([
        {
          message: "Export branch: alt-new",
          timestamp: "2026-04-30T14:00:00Z",
          author,
          files: {
            "branches/new/conversation.md": "# new alt",
            "branches/new/README.md": "alt readme",
          },
        },
      ]),
      out,
    );

    const branches = await git.listBranches({ fs, dir: out });
    expect(branches).toContain("alt-new");

    await git.checkout({ fs, dir: out, ref: "alt-new", force: true });
    expect(fs.readFileSync(path.join(out, "conversation.md"), "utf-8")).toBe("# new alt");
  });
});
