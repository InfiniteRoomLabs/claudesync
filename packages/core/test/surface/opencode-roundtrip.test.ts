import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpencodeSource } from "@core/surface/opencode-source.js";
import { FileSink } from "@core/surface/file-sink.js";
import { sync } from "@core/surface/orchestrator.js";

/** Build a synthetic opencode.db with the real session/message/part schema. */
function writeOpencodeDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, title TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
  `);
  db.prepare("INSERT INTO project VALUES (?,?)").run("proj1", "/home/x/raycaster");
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?)").run(
    "ses_1", "proj1", "glowing-garden", "Build raycaster",
    JSON.stringify({ id: "groq/gpt-oss-120b", providerID: "groq" }),
    1781633372262, 1781633372500
  );
  const msg = db.prepare("INSERT INTO message VALUES (?,?,?,?)");
  const part = db.prepare("INSERT INTO part VALUES (?,?,?,?,?)");
  msg.run("msg_1", "ses_1", JSON.stringify({ role: "user" }), 1781633372262);
  part.run("prt_1", "msg_1", "ses_1", JSON.stringify({ type: "text", text: "Implement the raycaster" }), 1781633372263);
  msg.run("msg_2", "ses_1", JSON.stringify({ role: "assistant" }), 1781633375490);
  part.run("prt_2", "msg_2", "ses_1", JSON.stringify({ type: "reasoning", text: "Let me think about it" }), 1781633375491);
  part.run("prt_3", "msg_2", "ses_1", JSON.stringify({ type: "tool", tool: "glob", callID: "call_abc", state: { status: "completed", input: { pattern: "**/*" }, output: "a.txt\nb.txt" } }), 1781633375492);
  part.run("prt_4", "msg_2", "ses_1", JSON.stringify({ type: "text", text: "Done, found 2 files." }), 1781633375493);
  part.run("prt_5", "msg_2", "ses_1", JSON.stringify({ type: "step-finish", reason: "tool-calls" }), 1781633375494);
  db.close();
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

describe("opencode:// source round-trip", () => {
  const tmpDirs: string[] = [];
  const mkTmp = (l: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `oc-${l}-`));
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("renders a SQLite session with tool parts (compact)", async () => {
    const dbDir = mkTmp("db");
    const dbPath = path.join(dbDir, "opencode.db");
    writeOpencodeDb(dbPath);
    const outRoot = mkTmp("out");

    const results = await sync(new OpencodeSource({ dbPath }), [new FileSink(outRoot, "files", "nested")], {
      format: "files",
    });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("full");

    const tree = readTree(outRoot);
    const convo = [...tree.entries()].find(([k]) => k.endsWith("/conversation.md"))![1];
    expect(convo).toContain("## Human");
    expect(convo).toContain("Implement the raycaster");
    expect(convo).toContain("## Assistant");
    expect(convo).toContain("Done, found 2 files.");
    expect(convo).toContain("**tool:** `glob`");
    expect(convo).not.toContain("Let me think about it"); // thinking omitted in compact

    const toolFile = [...tree.entries()].find(([k]) => k.includes("/tool-outputs/"));
    expect(toolFile, "an externalized tool-outputs file").toBeTruthy();
    expect(toolFile![1]).toContain("pattern");
    expect(toolFile![1]).toContain("a.txt");

    const readme = [...tree.entries()].find(([k]) => k.endsWith("/README.md"))![1];
    expect(readme).toContain("Build raycaster");
    expect(readme).toContain("groq/gpt-oss-120b");
    expect(readme).toContain("ses_1");
    expect([...tree.keys()].some((k) => k.startsWith("opencode/raycaster/"))).toBe(true);
  });

  it("full fidelity inlines thinking and tool I/O", async () => {
    const dbDir = mkTmp("db");
    const dbPath = path.join(dbDir, "opencode.db");
    writeOpencodeDb(dbPath);
    const outRoot = mkTmp("out");

    await sync(new OpencodeSource({ dbPath, fidelity: "full" }), [new FileSink(outRoot, "files", "nested")], {
      format: "files",
    });

    const convo = [...readTree(outRoot).entries()].find(([k]) => k.endsWith("/conversation.md"))![1];
    expect(convo).toContain("Let me think about it"); // thinking inline in full
    expect(convo).toContain("a.txt"); // tool output inline in full
  });

  it("skip-same skips an unchanged second run", async () => {
    const dbDir = mkTmp("db");
    const dbPath = path.join(dbDir, "opencode.db");
    writeOpencodeDb(dbPath);
    const outRoot = mkTmp("out");
    const run = (skipSame: boolean) =>
      sync(new OpencodeSource({ dbPath }), [new FileSink(outRoot, "files", "nested")], { format: "files", skipSame });

    expect((await run(false))[0].action).toBe("full");
    expect((await run(true))[0].action).toBe("skipped");
  });
});
