/**
 * Discover and parse local Claude Code session caches.
 *
 * Claude Code stores each session as a JSONL file under
 * `$CC_HOME/projects/<dash-encoded-cwd>/<sessionId>.jsonl` -- one JSON object
 * per line, chronological, linked into a tree by `parentUuid`. We read these
 * defensively (skip corrupt lines) rather than via Zod: they are arbitrary
 * local files, not a versioned API surface.
 */

import fs from "node:fs";
import path from "node:path";

/** A single content block inside a message (text/thinking/tool_use/tool_result/...). */
export interface CcContentBlock {
  type: string;
  // text
  text?: string;
  // thinking
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  [k: string]: unknown;
}

/** One parsed JSONL line. Only the fields we use are typed; the rest passes through. */
export interface CcLine {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string | null;
  isSidechain?: boolean;
  message?: {
    role?: string;
    model?: string | null;
    content?: string | CcContentBlock[];
    usage?: Record<string, unknown>;
    [k: string]: unknown;
  };
  // ai-title line
  aiTitle?: string | null;
  // last-prompt line
  leafUuid?: string | null;
  [k: string]: unknown;
}

export interface DiscoveredSession {
  sessionId: string;
  /** Absolute path to the `<sessionId>.jsonl` file. */
  jsonlPath: string;
  /** Absolute path to the `<sessionId>/` sidecar dir, or null if absent. */
  sidecarDir: string | null;
  /** The dash-encoded project directory name (e.g. `-home-deathnerd-...`). */
  projectDir: string;
}

export interface ParsedSession {
  sessionId: string;
  /** Every parsed line, in file order. */
  lines: CcLine[];
  /** Only `user`/`assistant` lines, in file order (the transcript). */
  transcript: CcLine[];
  /** Human-readable title from the latest `ai-title` line, if any. */
  title: string | null;
  /** Canonical leaf uuid from the latest `last-prompt` line (fallback: last transcript line). */
  leafUuid: string | null;
  /** Model of the latest assistant turn, if any. */
  model: string | null;
  /** ISO timestamp of the first line. */
  createdAt: string;
  /** ISO timestamp of the last line. */
  updatedAt: string;
  /** Working directory the session ran in. */
  cwd: string;
  gitBranch: string | null;
}

/**
 * Find every session JSONL under `$ccHome/projects/`. Returns [] if the
 * projects dir is missing. A session UUID may have a sibling `<uuid>/` dir
 * holding subagent transcripts and cached tool results.
 */
export function discoverSessions(ccHome: string): DiscoveredSession[] {
  const projectsRoot = path.join(ccHome, "projects");
  if (!isDir(projectsRoot)) {
    return [];
  }
  const out: DiscoveredSession[] = [];
  for (const projectDir of fs.readdirSync(projectsRoot)) {
    const projectPath = path.join(projectsRoot, projectDir);
    if (!isDir(projectPath)) continue;
    for (const entry of fs.readdirSync(projectPath)) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.slice(0, -".jsonl".length);
      const sidecar = path.join(projectPath, sessionId);
      out.push({
        sessionId,
        jsonlPath: path.join(projectPath, entry),
        sidecarDir: isDir(sidecar) ? sidecar : null,
        projectDir,
      });
    }
  }
  return out;
}

/** Parse one session JSONL file. Corrupt/blank lines are skipped, not fatal. */
export function parseSession(jsonlPath: string): ParsedSession {
  const sessionId = path.basename(jsonlPath, ".jsonl");
  const lines = parseLines(fs.readFileSync(jsonlPath, "utf-8"));
  return summarize(sessionId, lines);
}

/** Parse a raw JSONL string into lines (skipping unparseable ones). Exported for tests/subagents. */
export function parseLines(raw: string): CcLine[] {
  const lines: CcLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as CcLine;
      if (obj && typeof obj === "object" && typeof obj.type === "string") {
        lines.push(obj);
      }
    } catch {
      // Skip a corrupt line rather than discard the whole session.
    }
  }
  return lines;
}

/** Derive session metadata from parsed lines. Exported so subagent JSONLs reuse it. */
export function summarize(sessionId: string, lines: CcLine[]): ParsedSession {
  const transcript = lines.filter(
    (l) => l.type === "user" || l.type === "assistant"
  );

  const title = lastOf(lines, (l) => l.type === "ai-title" && !!l.aiTitle)?.aiTitle ?? null;

  const lastPromptLeaf = lastOf(lines, (l) => l.type === "last-prompt" && !!l.leafUuid)?.leafUuid;
  const leafUuid =
    lastPromptLeaf ?? transcript[transcript.length - 1]?.uuid ?? null;

  const model =
    lastOf(transcript, (l) => l.type === "assistant" && !!l.message?.model)?.message?.model ?? null;

  const withTime = lines.filter((l) => typeof l.timestamp === "string");
  const createdAt = withTime[0]?.timestamp ?? new Date(0).toISOString();
  const updatedAt = withTime[withTime.length - 1]?.timestamp ?? createdAt;

  const firstTranscript = transcript[0];
  const cwd = firstTranscript?.cwd ?? "";
  const gitBranch = firstTranscript?.gitBranch ?? null;

  return {
    sessionId: transcript[0]?.sessionId ?? sessionId,
    lines,
    transcript,
    title,
    leafUuid,
    model,
    createdAt,
    updatedAt,
    cwd,
    gitBranch,
  };
}

function lastOf(arr: CcLine[], pred: (l: CcLine) => boolean): CcLine | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return arr[i];
  }
  return undefined;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
