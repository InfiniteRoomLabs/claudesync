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

/** Name of aider's per-repo history file, found at the repo root. */
const HISTORY_FILE = ".aider.chat.history.md";
/** Matches a session-delimiter header and captures the start timestamp. */
const SESSION_HEADER = /^# aider chat started at (.+)$/;
/** Matches the `#### ` prefix that marks a user (human) line within a session. */
const USER_PREFIX = /^#### ?/;

/** One parsed aider session, before projection into the normalized model. */
interface AiderSession {
  /** Synthetic id: `<index>-<slugified-timestamp>` (aider records no session id). */
  id: string;
  /** Derived from the first human line, or the start timestamp when there is none. */
  title: string | null;
  /** Raw start timestamp string from the session header. */
  started: string;
  /** Parsed conversation turns. */
  turns: NormalizedTurn[];
}

/**
 * {@link DatastoreAdapter} for aider's `.aider.chat.history.md`. Each repo aider
 * touched holds its own history file at the repo root; one adapter instance reads
 * one repo's file. See {@link AdapterListItem}, {@link NormalizedSession}.
 */
export class AiderAdapter implements DatastoreAdapter {
  /** URI scheme this adapter answers for. */
  readonly scheme = "aider";
  /** Repo directory used as the {@link NormalizedSession.project}. */
  private readonly repoDir: string;
  /** Resolved path to the `.aider.chat.history.md` file. */
  private readonly historyPath: string;
  /** Memoized parse of the history file; populated on first {@link sessions}. */
  private cache?: AiderSession[];

  /**
   * @param target - A repo directory, or the `.aider.chat.history.md` file itself.
   *   When a file is given, its parent directory becomes the project.
   */
  constructor(target: string) {
    if (path.basename(target) === HISTORY_FILE) {
      this.historyPath = target;
      this.repoDir = path.dirname(target);
    } else {
      this.repoDir = target;
      this.historyPath = path.join(target, HISTORY_FILE);
    }
  }

  /** Enumerate sessions as cheap list items (aider has no timestamps beyond the start). */
  list(): AdapterListItem[] {
    return this.sessions().map((s) => ({
      id: s.id,
      title: s.title,
      project: this.repoDir,
      updatedAt: s.started,
      // Turn count folded into the leaf id so --skip-same notices appended turns.
      leafUuid: `${s.id}-${s.turns.length}`,
    }));
  }

  /**
   * Project one parsed session into the normalized model.
   *
   * @param id - Session id from {@link list}.
   * @returns The fully parsed session.
   * @throws If no session with `id` exists in the history file.
   */
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

  /** Read and parse the history file once, caching the result. Missing file -> no sessions. */
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

/**
 * Split the history file into sessions on `# aider chat started at ...` headers
 * and parse each session body into turns. Lines before the first header are ignored.
 *
 * @param raw - Full contents of `.aider.chat.history.md`.
 * @returns Parsed sessions in file order.
 */
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

/**
 * Group consecutive `#### `-prefixed lines into a human turn and every other run of
 * lines into an assistant turn, alternating as the role flips. aider has no tool
 * records, so every turn is a single {@link NormalizedBlock} of kind `text`. Empty
 * (whitespace-only) runs are dropped.
 *
 * @param lines - The body lines of one session (between two headers).
 * @returns Ordered turns.
 */
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

/**
 * Derive a session title from the first human turn's text: whitespace collapsed to
 * single spaces and truncated to 80 chars (with a trailing ellipsis).
 *
 * @param turns - The session's turns.
 * @returns A one-line title, or null if there is no human text.
 */
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

/** Turn a start timestamp into a filesystem-safe slug for the synthetic session id. */
function slugTimestamp(ts: string): string {
  return ts.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}
