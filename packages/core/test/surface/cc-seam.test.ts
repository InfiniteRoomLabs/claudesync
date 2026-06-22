import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runClaudeCodeSync } from "@core/claude-code/sync.js";
import { CcSource } from "@core/surface/cc-source.js";
import { FileSink } from "@core/surface/file-sink.js";
import { sync } from "@core/surface/orchestrator.js";
import type { ClaudeCodeFidelity } from "@core/claude-code/render.js";

/** Serialize objects as one-per-line JSONL. */
function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/**
 * Build a synthetic Claude Code home with two sessions in one project (to
 * exercise slug disambiguation) and a subagent sidecar on the first. No PII.
 */
function writeCcHome(ccHome: string): void {
  const proj = path.join(ccHome, "projects", "-home-x-proj");
  fs.mkdirSync(proj, { recursive: true });

  const session = (id: string, title: string) =>
    jsonl([
      { type: "user", uuid: `${id}-u1`, parentUuid: null, sessionId: id, timestamp: "2026-01-01T00:00:00Z", cwd: "/home/x/proj", gitBranch: "main", message: { role: "user", content: "Hello, list the files" } },
      { type: "assistant", uuid: `${id}-a1`, parentUuid: `${id}-u1`, sessionId: id, timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", model: "claude-opus-4-7", content: [{ type: "text", text: "Running it." }, { type: "thinking", thinking: "secret reasoning" }, { type: "tool_use", id: "toolu_abcd1234", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", uuid: `${id}-u2`, parentUuid: `${id}-a1`, sessionId: id, timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_abcd1234", content: "a.txt\nb.txt" }] } },
      { type: "assistant", uuid: `${id}-a2`, parentUuid: `${id}-u2`, sessionId: id, timestamp: "2026-01-01T00:00:03Z", message: { role: "assistant", model: "claude-opus-4-7", content: [{ type: "text", text: "Two files." }] } },
      { type: "ai-title", aiTitle: title },
      { type: "last-prompt", leafUuid: `${id}-a2` },
    ]);

  // Same title, distinct ids -> disambiguateSlugs splits on the first dash
  // segment, so the leading segments must differ (mirrors real session UUIDs).
  fs.writeFileSync(path.join(proj, "aaaa-sess.jsonl"), session("aaaa-sess", "List Files"));
  fs.writeFileSync(path.join(proj, "bbbb-sess.jsonl"), session("bbbb-sess", "List Files"));

  // Subagent sidecar on the first session.
  const sub = path.join(proj, "aaaa-sess", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-99.meta.json"), JSON.stringify({ agentType: "explore" }));
  fs.writeFileSync(
    path.join(sub, "agent-99.jsonl"),
    jsonl([
      { type: "user", uuid: "s-u1", parentUuid: null, sessionId: "sub-99", timestamp: "2026-01-01T00:00:00Z", cwd: "/home/x/proj", message: { role: "user", content: "Search please" } },
      { type: "assistant", uuid: "s-a1", parentUuid: "s-u1", sessionId: "sub-99", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", model: "claude-opus-4-7", content: [{ type: "text", text: "Found it." }] } },
      { type: "last-prompt", leafUuid: "s-a1" },
    ])
  );
}

/** Read a dir into relpath -> content, normalizing the state file's timestamp. */
function readTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs, childRel);
      } else {
        let content = fs.readFileSync(abs, "utf-8");
        if (e.name === ".claudesync-state.json") {
          const parsed = JSON.parse(content);
          delete parsed.last_sync_at;
          content = JSON.stringify(parsed, null, 2);
        }
        out.set(childRel, content);
      }
    }
  };
  walk(root, "");
  return out;
}

describe("cc:// surface seam parity with the claude-code subcommand", () => {
  const tmpDirs: string[] = [];
  const mkTmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "cc-seam-"));
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  for (const fidelity of ["compact", "full"] as ClaudeCodeFidelity[]) {
    it(`fidelity=${fidelity}: cc:// -> FileSink is byte-identical to runClaudeCodeSync`, async () => {
      const ccHome = mkTmp();
      writeCcHome(ccHome);

      // Legacy subcommand path.
      const legacyRoot = mkTmp();
      await runClaudeCodeSync(ccHome, {
        outputRoot: legacyRoot,
        fidelity,
        includeSubagents: true,
      });

      // Seam path: cc:// source -> nested file:// sink via sync().
      const seamRoot = mkTmp();
      const source = new CcSource({ ccHome, fidelity, includeSubagents: true });
      const sink = new FileSink(seamRoot, "files", "nested");
      const results = await sync(source, [sink], {
        format: "files",
        authorName: "Claude",
        authorEmail: "claude@anthropic.com",
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.action === "full")).toBe(true);
      // Sanity: the subagent + a tool-outputs externalization landed (compact).
      const tree = readTree(seamRoot);
      expect([...tree.keys()].some((k) => k.includes("/subagents/"))).toBe(true);

      expect(readTree(seamRoot)).toEqual(readTree(legacyRoot));
    });
  }

  it("orchestrator skip-same matches the reader's freshness check", async () => {
    const ccHome = mkTmp();
    writeCcHome(ccHome);
    const seamRoot = mkTmp();

    const run = (skipSame: boolean) =>
      sync(new CcSource({ ccHome }), [new FileSink(seamRoot, "files", "nested")], {
        format: "files",
        skipSame,
      });

    expect((await run(false)).every((r) => r.action === "full")).toBe(true);
    expect((await run(true)).every((r) => r.action === "skipped")).toBe(true);
  });
});
