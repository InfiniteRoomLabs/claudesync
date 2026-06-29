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

/**
 * A single content block inside a message (text/thinking/tool_use/tool_result/...).
 *
 * Only the fields the renderer consumes are typed; the index signature lets the
 * rest of an arbitrary block pass through untouched. Which optional fields are
 * present depends on {@link CcContentBlock.type}.
 */
export interface CcContentBlock {
  /** Block discriminator, e.g. `text`, `thinking`, `tool_use`, `tool_result`. */
  type: string;
  /** Body of a `text` block. */
  text?: string;
  /** Body of a `thinking` block. */
  thinking?: string;
  /** Tool-call id on a `tool_use` block; matched against {@link CcContentBlock.tool_use_id}. */
  id?: string;
  /** Tool name on a `tool_use` block. */
  name?: string;
  /** Tool arguments on a `tool_use` block (shape varies per tool). */
  input?: unknown;
  /** On a `tool_result` block, the {@link CcContentBlock.id} of the `tool_use` it answers. */
  tool_use_id?: string;
  /** Result payload on a `tool_result` block; string or an array of nested blocks. */
  content?: unknown;
  /** True when a `tool_result` block reports a tool failure. */
  is_error?: boolean;
  /** Forward-compat passthrough for fields we do not model. */
  [k: string]: unknown;
}

/** One parsed JSONL line. Only the fields we use are typed; the rest passes through. */
export interface CcLine {
  /** Line discriminator, e.g. `user`, `assistant`, `ai-title`, `last-prompt`, `attachment`. */
  type: string;
  /** This line's node id; the key other lines reference via {@link CcLine.parentUuid}. */
  uuid?: string;
  /** Parent node id in the message DAG; null/absent at the root. */
  parentUuid?: string | null;
  /** Session this line belongs to (the file basename is the fallback). */
  sessionId?: string;
  /** ISO timestamp the line was written. */
  timestamp?: string;
  /** Working directory the turn ran in. */
  cwd?: string;
  /** Git branch active during the turn, if any. */
  gitBranch?: string | null;
  /** True for subagent sidechain lines (parsed separately, not the parent transcript). */
  isSidechain?: boolean;
  /** Payload for `user`/`assistant` lines. */
  message?: {
    /** `user` or `assistant`. */
    role?: string;
    /** Model that produced an assistant turn, if recorded. */
    model?: string | null;
    /** Plain string or an array of typed {@link CcContentBlock}s. */
    content?: string | CcContentBlock[];
    /** Token-usage accounting, passed through unmodeled. */
    usage?: Record<string, unknown>;
    /** Forward-compat passthrough. */
    [k: string]: unknown;
  };
  /** Title text on an `ai-title` line. */
  aiTitle?: string | null;
  /** Canonical leaf uuid on a `last-prompt` line; identifies the live branch. */
  leafUuid?: string | null;
  /** Forward-compat passthrough for line kinds/fields we do not model. */
  [k: string]: unknown;
}

/** One session JSONL file located on disk, with its optional sidecar dir. */
export interface DiscoveredSession {
  /** Session UUID (the JSONL file basename). */
  sessionId: string;
  /** Absolute path to the `<sessionId>.jsonl` file. */
  jsonlPath: string;
  /** Absolute path to the `<sessionId>/` sidecar dir, or null if absent. */
  sidecarDir: string | null;
  /** The dash-encoded project directory name (e.g. `-home-deathnerd-...`). */
  projectDir: string;
}

/** A parsed session: the raw lines plus the metadata derived from them by {@link summarize}. */
export interface ParsedSession {
  /** Session UUID, taken from the first transcript line (file basename fallback). */
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
  /** Git branch the session ran on, or null if none was recorded. */
  gitBranch: string | null;
}

/**
 * Find every session JSONL under `$ccHome/projects/`. A session UUID may have a
 * sibling `<uuid>/` dir holding subagent transcripts and cached tool results,
 * surfaced as {@link DiscoveredSession.sidecarDir}.
 *
 * @param ccHome - Claude Code home dir (the parent of `projects/`).
 * @returns One entry per discovered session, in `readdir` order, or `[]` if the `projects/` dir is missing.
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

/**
 * Parse one session JSONL file. Corrupt/blank lines are skipped, not fatal.
 *
 * @param jsonlPath - Absolute path to a `<sessionId>.jsonl` file.
 * @returns The parsed session, with metadata derived by {@link summarize}.
 * @throws If the file cannot be read (e.g. it does not exist).
 */
export function parseSession(jsonlPath: string): ParsedSession {
  const sessionId = path.basename(jsonlPath, ".jsonl");
  const lines = parseLines(fs.readFileSync(jsonlPath, "utf-8"));
  return summarize(sessionId, lines);
}

/**
 * Parse a raw JSONL string into lines, skipping unparseable ones. Exported so
 * subagent sidechain logs (read as raw strings) and tests reuse the same
 * defensive parsing as {@link parseSession}.
 *
 * @param raw - The full JSONL file contents.
 * @returns Lines that parsed to an object with a string `type`, in file order.
 */
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

/**
 * Derive session metadata (title, leaf, model, timestamps, cwd) from already
 * parsed lines. Exported so subagent JSONLs -- parsed via {@link parseLines}
 * rather than {@link parseSession} -- reuse the same derivation.
 *
 * @param sessionId - Fallback session id, used when no transcript line carries one.
 * @param lines - All parsed lines, in file order.
 * @returns The assembled {@link ParsedSession}.
 */
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

/** Last element satisfying `pred`, scanning from the end; undefined if none match. */
function lastOf(arr: CcLine[], pred: (l: CcLine) => boolean): CcLine | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return arr[i];
  }
  return undefined;
}

/** True if `p` exists and is a directory; false on any stat error. */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
