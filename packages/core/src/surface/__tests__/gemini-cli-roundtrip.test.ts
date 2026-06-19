import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GeminiCliSource } from "../gemini-cli-source.js";
import { FileSink } from "../file-sink.js";
import { sync } from "../orchestrator.js";

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** Synthetic ~/.gemini/tmp with one session that uses a tool. */
function writeGeminiHome(home: string): void {
  const idDir = path.join(home, "user1");
  fs.mkdirSync(path.join(idDir, "chats"), { recursive: true });
  fs.writeFileSync(path.join(idDir, ".project_root"), "/home/x/myproject");
  fs.writeFileSync(
    path.join(idDir, "chats", "session-2026-01-01T00-00-abc11111.jsonl"),
    jsonl([
      { sessionId: "abc-11111111", projectHash: "hhh", startTime: "2026-01-01T00:00:00Z", lastUpdated: "2026-01-01T00:00:00Z", kind: "main" },
      { id: "m1", timestamp: "2026-01-01T00:00:01Z", type: "user", content: [{ text: "List the files please" }] },
      { id: "m2", timestamp: "2026-01-01T00:00:02Z", type: "model", content: [{ text: "Sure, listing." }, { functionCall: { name: "list_files", args: { path: "." } } }] },
      { id: "m3", timestamp: "2026-01-01T00:00:03Z", type: "user", content: [{ functionResponse: { name: "list_files", response: { files: ["a.txt", "b.txt"] } } }] },
      { id: "m4", timestamp: "2026-01-01T00:00:04Z", type: "model", content: [{ text: "Found a.txt and b.txt." }] },
      { type: "info", content: "Request cancelled." },
      { $set: { summary: "List files session", lastUpdated: "2026-01-01T00:00:05Z" } },
    ])
  );
}

function readTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, childRel);
      else out.set(childRel, fs.readFileSync(abs, "utf-8"));
    }
  };
  walk(root, "");
  return out;
}

describe("gemini-cli:// source round-trip", () => {
  const tmpDirs: string[] = [];
  const mkTmp = (l: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `gem-${l}-`));
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("renders a tool-using session with externalized tool I/O (compact)", async () => {
    const home = mkTmp("home");
    writeGeminiHome(home);
    const outRoot = mkTmp("out");

    const results = await sync(new GeminiCliSource({ home }), [new FileSink(outRoot, "files", "nested")], {
      format: "files",
    });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("full");

    const tree = readTree(outRoot);
    const convo = [...tree.entries()].find(([k]) => k.endsWith("/conversation.md"))![1];
    expect(convo).toContain("## Human");
    expect(convo).toContain("List the files please");
    expect(convo).toContain("## Assistant");
    expect(convo).toContain("Found a.txt and b.txt");
    expect(convo).toContain("**tool:** `list_files`");
    expect(convo).not.toContain("Request cancelled."); // info noise skipped

    // The tool I/O was externalized and carries both input + output.
    const toolFile = [...tree.entries()].find(([k]) => k.includes("/tool-outputs/"));
    expect(toolFile, "an externalized tool-outputs file").toBeTruthy();
    expect(toolFile![1]).toContain("path");
    expect(toolFile![1]).toContain("a.txt");

    const readme = [...tree.entries()].find(([k]) => k.endsWith("/README.md"))![1];
    expect(readme).toContain("List files session");
    expect(readme).toContain("abc-11111111");
    // project slug came from .project_root basename
    expect([...tree.keys()].some((k) => k.startsWith("gemini-cli/myproject/"))).toBe(true);
  });

  it("skip-same skips an unchanged second run", async () => {
    const home = mkTmp("home");
    writeGeminiHome(home);
    const outRoot = mkTmp("out");
    const run = (skipSame: boolean) =>
      sync(new GeminiCliSource({ home }), [new FileSink(outRoot, "files", "nested")], { format: "files", skipSame });

    expect((await run(false))[0].action).toBe("full");
    expect((await run(true))[0].action).toBe("skipped");
  });
});
