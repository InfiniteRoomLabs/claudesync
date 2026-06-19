/**
 * aider datastore adapter (PRD 001 Phase 1.5).
 *
 * aider records each repo's chat in `<repo>/.aider.chat.history.md` (no global
 * store -- the file lives inside the git repo aider ran in). Format: sessions
 * are delimited by `# aider chat started at <ts>` headers; within a session,
 * user turns are lines prefixed `#### `, and assistant text is the markdown
 * between user turns. There are no tool-call records (edits are inline markdown).
 *
 * NOTE: built against the DOCUMENTED format -- there is no aider data on this
 * machine to validate against, so this is unverified. Treat as best-effort.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  AdapterListItem,
  DatastoreAdapter,
  NormalizedSession,
  NormalizedTurn,
} from "../surface/datastore.js";

const HISTORY_FILE = ".aider.chat.history.md";
const SESSION_HEADER = /^# aider chat started at (.+)$/;
const USER_PREFIX = /^#### ?/;

interface AiderSession {
  id: string;
  title: string | null;
  started: string;
  turns: NormalizedTurn[];
}

export class AiderAdapter implements DatastoreAdapter {
  readonly scheme = "aider";
  private readonly repoDir: string;
  private readonly historyPath: string;
  private cache?: AiderSession[];

  /** `target` may be a repo directory or the history file itself. */
  constructor(target: string) {
    if (path.basename(target) === HISTORY_FILE) {
      this.historyPath = target;
      this.repoDir = path.dirname(target);
    } else {
      this.repoDir = target;
      this.historyPath = path.join(target, HISTORY_FILE);
    }
  }

  list(): AdapterListItem[] {
    return this.sessions().map((s) => ({
      id: s.id,
      title: s.title,
      project: this.repoDir,
      updatedAt: s.started,
      leafUuid: `${s.id}-${s.turns.length}`,
    }));
  }

  read(id: string): NormalizedSession {
    const s = this.sessions().find((x) => x.id === id);
    if (!s) throw new Error(`aider session not found: ${id}`);
    return {
      id: s.id,
      title: s.title,
      model: null,
      createdAt: s.started,
      updatedAt: s.started,
      project: this.repoDir,
      leafUuid: `${s.id}-${s.turns.length}`,
      turns: s.turns,
    };
  }

  private sessions(): AiderSession[] {
    if (this.cache) return this.cache;
    let raw = "";
    try {
      raw = fs.readFileSync(this.historyPath, "utf-8");
    } catch {
      this.cache = [];
      return this.cache;
    }
    this.cache = parseAiderHistory(raw);
    return this.cache;
  }
}

function parseAiderHistory(raw: string): AiderSession[] {
  const lines = raw.split(/\r?\n/);
  const sessions: AiderSession[] = [];
  let started: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (started === null) return;
    const turns = parseTurns(body);
    const idx = sessions.length;
    sessions.push({
      id: `${idx}-${slugTimestamp(started)}`,
      title: firstHumanText(turns) ?? started,
      started,
      turns,
    });
    body = [];
  };

  for (const line of lines) {
    const m = SESSION_HEADER.exec(line);
    if (m) {
      flush();
      started = m[1].trim();
    } else if (started !== null) {
      body.push(line);
    }
  }
  flush();
  return sessions;
}

/** Group consecutive `#### ` lines into human turns; everything else is assistant. */
function parseTurns(lines: string[]): NormalizedTurn[] {
  const turns: NormalizedTurn[] = [];
  let mode: "human" | "assistant" | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (mode) {
      const text = buf.join("\n").trim();
      if (text) turns.push({ role: mode, blocks: [{ kind: "text", text }] });
    }
    buf = [];
  };

  for (const line of lines) {
    const isUser = USER_PREFIX.test(line);
    const role: "human" | "assistant" = isUser ? "human" : "assistant";
    if (role !== mode) {
      flush();
      mode = role;
    }
    buf.push(isUser ? line.replace(USER_PREFIX, "") : line);
  }
  flush();
  return turns;
}

function firstHumanText(turns: NormalizedTurn[]): string | null {
  for (const t of turns) {
    if (t.role !== "human") continue;
    const text = t.blocks.find((b) => b.kind === "text");
    if (text && text.kind === "text") {
      const oneLine = text.text.replace(/\s+/g, " ").trim();
      return oneLine.length > 80 ? oneLine.slice(0, 77) + "..." : oneLine;
    }
  }
  return null;
}

function slugTimestamp(ts: string): string {
  return ts.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}
