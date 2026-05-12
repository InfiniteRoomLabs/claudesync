import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceWithPreserve, walkRelative } from "../files-mode.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "claudesync-files-mode-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function writeFile(p: string, content: string): void {
  mkdirSync(join(workdir, p, ".."), { recursive: true });
  writeFileSync(join(workdir, p), content, "utf-8");
}

describe("replaceWithPreserve", () => {
  it("creates outputPath on first run (no stash to merge from)", async () => {
    const outputPath = join(workdir, "convo");
    await replaceWithPreserve({
      outputPath,
      writeFresh: async () => {
        mkdirSync(outputPath, { recursive: true });
        writeFileSync(join(outputPath, "conversation.md"), "fresh body", "utf-8");
      },
      alwaysPreserve: ["CHANGELOG.md"],
      preserveGlobs: ["INDEX.md"],
    });
    expect(readFileSync(join(outputPath, "conversation.md"), "utf-8")).toBe("fresh body");
  });

  it("preserves alwaysPreserve files across re-sync", async () => {
    const outputPath = join(workdir, "convo");
    // Initial state.
    mkdirSync(outputPath, { recursive: true });
    writeFileSync(join(outputPath, "conversation.md"), "v1 body", "utf-8");
    writeFileSync(join(outputPath, "CHANGELOG.md"), "## changelog v1\n", "utf-8");
    // Re-sync rewrites the dir.
    await replaceWithPreserve({
      outputPath,
      writeFresh: async () => {
        mkdirSync(outputPath, { recursive: true });
        writeFileSync(join(outputPath, "conversation.md"), "v2 body", "utf-8");
      },
      alwaysPreserve: ["CHANGELOG.md"],
    });
    expect(readFileSync(join(outputPath, "conversation.md"), "utf-8")).toBe("v2 body");
    expect(readFileSync(join(outputPath, "CHANGELOG.md"), "utf-8")).toBe("## changelog v1\n");
  });

  it("preserves files matching preserveGlobs", async () => {
    const outputPath = join(workdir, "convo");
    mkdirSync(outputPath, { recursive: true });
    writeFileSync(join(outputPath, "INDEX.md"), "indexer output\n", "utf-8");
    writeFileSync(join(outputPath, "conversation.md"), "v1", "utf-8");

    await replaceWithPreserve({
      outputPath,
      writeFresh: async () => {
        mkdirSync(outputPath, { recursive: true });
        writeFileSync(join(outputPath, "conversation.md"), "v2", "utf-8");
      },
      preserveGlobs: ["INDEX.md"],
    });

    expect(readFileSync(join(outputPath, "INDEX.md"), "utf-8")).toBe("indexer output\n");
    expect(readFileSync(join(outputPath, "conversation.md"), "utf-8")).toBe("v2");
  });

  it("drops files matching alwaysDrop even if they match preserveGlobs", async () => {
    const outputPath = join(workdir, "convo");
    mkdirSync(outputPath, { recursive: true });
    writeFileSync(join(outputPath, ".claudesync-state.json"), "{\"old\":true}", "utf-8");
    writeFileSync(join(outputPath, "conversation.md"), "v1", "utf-8");

    await replaceWithPreserve({
      outputPath,
      writeFresh: async () => {
        mkdirSync(outputPath, { recursive: true });
        writeFileSync(join(outputPath, "conversation.md"), "v2", "utf-8");
      },
      alwaysDrop: [".claudesync-state.json"],
      preserveGlobs: ["**"], // even with greedy preserve, alwaysDrop wins
    });

    expect(existsSync(join(outputPath, ".claudesync-state.json"))).toBe(false);
  });

  it("preserves nested files matching ** globs", async () => {
    const outputPath = join(workdir, "project");
    mkdirSync(join(outputPath, "conversations/foo"), { recursive: true });
    writeFileSync(join(outputPath, "conversations/foo/INDEX.md"), "nested index\n", "utf-8");
    writeFileSync(join(outputPath, "README.md"), "v1", "utf-8");

    await replaceWithPreserve({
      outputPath,
      writeFresh: async () => {
        mkdirSync(join(outputPath, "conversations/foo"), { recursive: true });
        writeFileSync(join(outputPath, "README.md"), "v2", "utf-8");
        writeFileSync(join(outputPath, "conversations/foo/conversation.md"), "v2", "utf-8");
      },
      preserveGlobs: ["**/INDEX.md"],
    });

    expect(readFileSync(join(outputPath, "conversations/foo/INDEX.md"), "utf-8")).toBe(
      "nested index\n"
    );
    expect(readFileSync(join(outputPath, "README.md"), "utf-8")).toBe("v2");
  });

  it("does not clobber when the bundle wrote the same relative path", async () => {
    const outputPath = join(workdir, "convo");
    mkdirSync(outputPath, { recursive: true });
    writeFileSync(join(outputPath, "conversation.md"), "stash version", "utf-8");

    await replaceWithPreserve({
      outputPath,
      writeFresh: async () => {
        mkdirSync(outputPath, { recursive: true });
        writeFileSync(join(outputPath, "conversation.md"), "bundle version", "utf-8");
      },
      preserveGlobs: ["conversation.md"], // user mis-glob; bundle should win
    });

    expect(readFileSync(join(outputPath, "conversation.md"), "utf-8")).toBe("bundle version");
  });

  it("restores the stash on writeFresh failure", async () => {
    const outputPath = join(workdir, "convo");
    mkdirSync(outputPath, { recursive: true });
    writeFileSync(join(outputPath, "conversation.md"), "original", "utf-8");

    await expect(
      replaceWithPreserve({
        outputPath,
        writeFresh: async () => {
          throw new Error("boom");
        },
      })
    ).rejects.toThrow("boom");

    expect(readFileSync(join(outputPath, "conversation.md"), "utf-8")).toBe("original");
    expect(existsSync(outputPath + ".prev")).toBe(false);
  });

  it("removes stale stash directory before renaming", async () => {
    const outputPath = join(workdir, "convo");
    mkdirSync(outputPath, { recursive: true });
    writeFileSync(join(outputPath, "conversation.md"), "v1", "utf-8");
    // Pre-existing stash from a previously-crashed run.
    const staleStash = outputPath + ".prev";
    mkdirSync(staleStash, { recursive: true });
    writeFileSync(join(staleStash, "junk.md"), "leftover", "utf-8");

    await replaceWithPreserve({
      outputPath,
      writeFresh: async () => {
        mkdirSync(outputPath, { recursive: true });
        writeFileSync(join(outputPath, "conversation.md"), "v2", "utf-8");
      },
    });

    expect(readFileSync(join(outputPath, "conversation.md"), "utf-8")).toBe("v2");
    expect(existsSync(staleStash)).toBe(false);
  });
});

describe("walkRelative", () => {
  it("yields all file paths with POSIX separators", () => {
    writeFile("a.md", "1");
    writeFile("nested/b.md", "2");
    writeFile("nested/deep/c.md", "3");
    const paths = [...walkRelative(workdir)].sort();
    expect(paths).toEqual(["a.md", "nested/b.md", "nested/deep/c.md"]);
  });

  it("returns empty for nonexistent root", () => {
    expect([...walkRelative(join(workdir, "missing"))]).toEqual([]);
  });
});
