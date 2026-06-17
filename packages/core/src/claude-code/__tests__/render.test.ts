import { describe, expect, it } from "vitest";
import { parseLines, summarize } from "../parse.js";
import { renderSession } from "../render.js";

/**
 * Synthetic session (no PII): human -> attachment -> assistant(thinking + Bash
 * tool_use) -> tool_result -> assistant(text). The attachment hop mirrors real
 * CC data, where user and assistant lines are NOT directly parent-linked; the
 * branch walk must traverse it or the human root is orphaned. Plus one
 * rewound/off-leaf user line that must never appear. The Bash output is large to
 * exercise truncation/externalization.
 */
const BIG = "X".repeat(50_000) + " NEEDLE_OUTPUT";

const FIXTURE = [
  { type: "user", uuid: "u1", parentUuid: null, sessionId: "sess1", timestamp: "2026-06-01T00:00:00Z", cwd: "/home/me/proj", gitBranch: "main", message: { role: "user", content: "Please run the build" } },
  { type: "user", uuid: "uX", parentUuid: "u1", sessionId: "sess1", timestamp: "2026-06-01T00:00:01Z", message: { role: "user", content: "rewound branch DO NOT INCLUDE" } },
  { type: "attachment", uuid: "att1", parentUuid: "u1", sessionId: "sess1", timestamp: "2026-06-01T00:00:01Z" },
  { type: "assistant", uuid: "a1", parentUuid: "att1", sessionId: "sess1", timestamp: "2026-06-01T00:00:02Z", message: { role: "assistant", model: "claude-opus-4-7", content: [
    { type: "thinking", thinking: "let me think about the build" },
    { type: "tool_use", id: "toolu_aaa", name: "Bash", input: { command: "pnpm build" } },
  ] } },
  { type: "user", uuid: "t1", parentUuid: "a1", sessionId: "sess1", timestamp: "2026-06-01T00:00:03Z", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_aaa", content: BIG },
  ] } },
  { type: "assistant", uuid: "a2", parentUuid: "t1", sessionId: "sess1", timestamp: "2026-06-01T00:00:04Z", message: { role: "assistant", content: [
    { type: "text", text: "Build succeeded." },
  ] } },
  { type: "ai-title", aiTitle: "Run the build", sessionId: "sess1" },
  { type: "last-prompt", leafUuid: "a2", sessionId: "sess1" },
]
  .map((o) => JSON.stringify(o))
  .join("\n");

function load() {
  return summarize("sess1", parseLines(FIXTURE));
}

describe("renderSession", () => {
  it("all modes: includes human + final answer, excludes off-leaf turns", () => {
    for (const fidelity of ["compact", "truncated", "full"] as const) {
      const r = renderSession(load(), { fidelity, truncateCapBytes: 100 });
      expect(r.markdown).toContain("Please run the build");
      expect(r.markdown).toContain("Build succeeded.");
      expect(r.markdown).not.toContain("DO NOT INCLUDE");
      expect(r.messageCount).toBe(4); // u1, a1, t1, a2 -- not uX
    }
  });

  it("compact: tool reference + externalized I/O, no inline output, no thinking", () => {
    const r = renderSession(load(), { fidelity: "compact" });
    expect(r.markdown).toContain("**tool:** `Bash`");
    expect(r.markdown).toContain("tool-outputs/");
    expect(r.markdown).not.toContain("NEEDLE_OUTPUT"); // output is external, not inline
    expect(r.markdown).not.toContain("let me think"); // thinking omitted in compact
    expect(r.externalFiles.size).toBe(1);
    const body = [...r.externalFiles.values()][0];
    expect(body).toContain("NEEDLE_OUTPUT");
    expect(body).toContain("pnpm build");
  });

  it("truncated: thinking + input inline, output capped with link, full output external", () => {
    const r = renderSession(load(), { fidelity: "truncated", truncateCapBytes: 100 });
    expect(r.markdown).toContain("let me think about the build");
    expect(r.markdown).toContain("pnpm build"); // input inline
    expect(r.markdown).toContain("[truncated]");
    expect(r.markdown).toContain("tool-outputs/");
    expect(r.markdown).not.toContain("NEEDLE_OUTPUT"); // tail dropped from inline
    expect(r.externalFiles.size).toBe(1);
    expect([...r.externalFiles.values()][0]).toContain("NEEDLE_OUTPUT");
  });

  it("full: everything inline, no external files", () => {
    const r = renderSession(load(), { fidelity: "full" });
    expect(r.markdown).toContain("let me think about the build");
    expect(r.markdown).toContain("NEEDLE_OUTPUT"); // full output inline
    expect(r.externalFiles.size).toBe(0);
  });
});
