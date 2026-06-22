import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AiderSource } from "@core/surface/aider-source.js";
import { FileSink } from "@core/surface/file-sink.js";
import { sync } from "@core/surface/orchestrator.js";

const HISTORY = `# aider chat started at 2026-01-02 15:04:05

#### Add a hello function

Sure, here is the function:

\`\`\`python
def hello():
    return "hi"
\`\`\`

#### Now add a test

Added a test below.

# aider chat started at 2026-01-03 09:00:00

#### Refactor the parser

Done refactoring.
`;

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

describe("aider:// source round-trip", () => {
  const tmpDirs: string[] = [];
  const mkTmp = (label: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `aider-${label}-`));
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("renders aider sessions into the corpus tree", async () => {
    const repo = mkTmp("repo");
    fs.writeFileSync(path.join(repo, ".aider.chat.history.md"), HISTORY);
    const outRoot = mkTmp("out");

    const results = await sync(new AiderSource({ path: repo }), [new FileSink(outRoot, "files", "nested")], {
      format: "files",
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.action === "full")).toBe(true);

    const tree = readTree(outRoot);
    const convo = [...tree.entries()].find(([k]) => k.endsWith("/conversation.md") && tree.get(k)!.includes("hello"));
    expect(convo, "a conversation.md mentioning the first prompt").toBeTruthy();
    const body = convo![1];
    expect(body).toContain("## Human");
    expect(body).toContain("Add a hello function");
    expect(body).toContain("## Assistant");
    expect(body).toContain("here is the function");
    // aider has no tool calls -> nothing externalized
    expect([...tree.keys()].some((k) => k.includes("/tool-outputs/"))).toBe(false);
    // README carries metadata
    const readme = [...tree.entries()].find(([k]) => k.endsWith("/README.md"))![1];
    expect(readme).toContain("Session ID:");
    expect(readme).toContain(path.basename(repo));
  });

  it("skip-same skips an unchanged second run", async () => {
    const repo = mkTmp("repo");
    fs.writeFileSync(path.join(repo, ".aider.chat.history.md"), HISTORY);
    const outRoot = mkTmp("out");
    const run = (skipSame: boolean) =>
      sync(new AiderSource({ path: repo }), [new FileSink(outRoot, "files", "nested")], { format: "files", skipSame });

    expect((await run(false)).every((r) => r.action === "full")).toBe(true);
    expect((await run(true)).every((r) => r.action === "skipped")).toBe(true);
  });
});
