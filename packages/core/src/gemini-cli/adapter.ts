/**
 * Gemini CLI datastore adapter (PRD 001 Phase 1.5).
 *
 * Gemini CLI stores sessions at `~/.gemini/tmp/<id>/chats/session-<ts>-<id>.jsonl`
 * (JSONL, one event per line); `<id>/.project_root` holds the project path.
 * Event shapes (verified against real data for session_init / $set / user / info;
 * the assistant + tool shapes follow Google's content-parts model and are
 * defensive -- the only real local sessions were tool-less login flows):
 *   - session_init: { sessionId, projectHash, startTime, lastUpdated, kind }  (no `type`)
 *   - { "$set": { lastUpdated?, summary? } }                                   (mutation; summary = title)
 *   - { id, timestamp, type:"user", content:[{text}] | "..." }
 *   - { id, timestamp, type:"model"|"assistant", content:[ {text} | {functionCall} ] }
 *   - { ... functionResponse ... }  (tool output, paired back to its functionCall by name)
 *   - { type:"info", content:"..." }  (system/auth noise -- skipped)
 *
 * Gemini auto-cleans these after ~30 days, which is itself a reason to archive.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AdapterListItem,
  DatastoreAdapter,
  NormalizedBlock,
  NormalizedSession,
  NormalizedTurn,
} from "../surface/datastore.js";

/** Default Gemini CLI session root: `~/.gemini/tmp` (one subdir per session id). */
export function defaultGeminiHome(): string {
  return path.join(os.homedir(), ".gemini", "tmp");
}

/** One decoded JSONL event line. Fields are all optional since shapes vary by `type`. */
interface GLine {
  /** Event discriminator: `user`, `model`/`assistant`/`gemini`, `info`, ... Absent on session_init. */
  type?: string;
  /** Per-event id; the last seen one becomes the session's leaf uuid. */
  id?: string;
  /** ISO event timestamp; the latest seen advances `updatedAt`. */
  timestamp?: string;
  /** Session id, present only on the session_init line. */
  sessionId?: string;
  /** Session start time, present only on session_init. */
  startTime?: string;
  /** Last-updated time, present on session_init and inside `$set`. */
  lastUpdated?: string;
  /** Message content: a string, or an array of {@link GPart}s. */
  content?: unknown;
  /** Mutation event carrying metadata updates (notably `summary`, the title). */
  $set?: { lastUpdated?: string; summary?: string };
}

/** One element of a message's content array (Google's content-parts model). */
interface GPart {
  /** Plain text fragment. */
  text?: string;
  /** A tool invocation: tool name, arguments, and optional call id. */
  functionCall?: { name?: string; args?: unknown; id?: string };
  /** A tool result, paired back to its {@link GPart.functionCall} by tool name. */
  functionResponse?: { name?: string; response?: unknown; id?: string };
}

/** The tool variant of {@link NormalizedBlock}, kept open until its response arrives. */
type ToolBlock = Extract<NormalizedBlock, { kind: "tool" }>;

/**
 * {@link DatastoreAdapter} for Gemini CLI's `~/.gemini/tmp/<id>/chats/*.jsonl` stores.
 * Each session is one JSONL file; `<id>/.project_root` supplies the project path.
 * See {@link AdapterListItem}, {@link NormalizedSession}.
 */
export class GeminiCliAdapter implements DatastoreAdapter {
  /** URI scheme this adapter answers for. */
  readonly scheme = "gemini-cli";
  /** Memoized map of session id -> parsed session; populated on first {@link all}. */
  private cache?: Map<string, NormalizedSession>;

  /**
   * @param home - Session root to scan. Defaults to {@link defaultGeminiHome}.
   */
  constructor(private readonly home: string = defaultGeminiHome()) {}

  /** Enumerate parsed sessions as cheap list items. */
  list(): AdapterListItem[] {
    return [...this.all().values()].map((s) => ({
      id: s.id,
      title: s.title,
      project: s.project,
      updatedAt: s.updatedAt,
      leafUuid: s.leafUuid,
    }));
  }

  /**
   * Fetch one fully parsed session.
   *
   * @param id - Session id from {@link list}.
   * @returns The parsed session.
   * @throws If no session with `id` is found.
   */
  read(id: string): NormalizedSession {
    const s = this.all().get(id);
    if (!s) throw new Error(`gemini-cli session not found: ${id}`);
    return s;
  }

  /**
   * Parse every discovered session file once, caching the result. A single
   * unparseable file is skipped so the rest of the store still loads.
   */
  private all(): Map<string, NormalizedSession> {
    if (this.cache) return this.cache;
    const map = new Map<string, NormalizedSession>();
    for (const { file, project } of this.discover()) {
      try {
        const s = parseGeminiFile(file, project);
        if (s) map.set(s.id, s);
      } catch {
        // One bad session file should not sink the rest.
      }
    }
    this.cache = map;
    return map;
  }

  /**
   * Walk `<home>/<id>/chats/*.jsonl`, resolving each session's project from the
   * sibling `.project_root` file (falling back to the session-dir id). Missing or
   * unreadable directories are silently skipped.
   *
   * @returns One entry per session file with its resolved project path.
   */
  private discover(): Array<{ file: string; project: string }> {
    const out: Array<{ file: string; project: string }> = [];
    let ids: string[];
    try {
      ids = fs.readdirSync(this.home);
    } catch {
      return out;
    }
    for (const id of ids) {
      const chatsDir = path.join(this.home, id, "chats");
      let files: string[];
      try {
        files = fs.readdirSync(chatsDir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      const project = readProjectRoot(path.join(this.home, id, ".project_root")) ?? id;
      for (const f of files) out.push({ file: path.join(chatsDir, f), project });
    }
    return out;
  }
}

/** Read the trimmed `.project_root` path, or null if absent/empty/unreadable. */
function readProjectRoot(p: string): string | null {
  try {
    const s = fs.readFileSync(p, "utf-8").trim();
    return s || null;
  } catch {
    return null;
  }
}

/**
 * Parse one session JSONL file into a {@link NormalizedSession}. Walks events in
 * order: session_init seeds identity/timestamps, `$set` updates the title, `user`
 * and model/assistant events become turns, and `functionResponse` parts are paired
 * back to their open `functionCall` by tool name. Corrupt lines are skipped.
 *
 * @param file - Absolute path to the `.jsonl` session file.
 * @param project - Project path resolved by {@link GeminiCliAdapter.discover}.
 * @returns The parsed session, or null if it has no renderable turns (e.g. a
 *   login-only session).
 */
function parseGeminiFile(file: string, project: string): NormalizedSession | null {
  const raw = fs.readFileSync(file, "utf-8");
  let sessionId = path.basename(file, ".jsonl");
  let createdAt = "";
  let updatedAt = "";
  let title: string | null = null;
  let leafUuid: string | null = null;
  const turns: NormalizedTurn[] = [];
  // Open tool calls awaiting a functionResponse, by tool name (paired FIFO).
  const openTools = new Map<string, ToolBlock[]>();

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let obj: GLine;
    try {
      obj = JSON.parse(t) as GLine;
    } catch {
      continue; // skip a corrupt line, keep the session
    }

    // session_init: has identity fields but no `type`.
    if (!obj.type && (obj.sessionId || obj.startTime)) {
      if (obj.sessionId) sessionId = obj.sessionId;
      if (obj.startTime) createdAt = obj.startTime;
      if (obj.lastUpdated) updatedAt = obj.lastUpdated;
      continue;
    }
    if (obj.$set) {
      if (obj.$set.lastUpdated) updatedAt = obj.$set.lastUpdated;
      if (typeof obj.$set.summary === "string") title = obj.$set.summary;
      continue;
    }
    if (obj.timestamp) updatedAt = obj.timestamp;

    if (obj.type === "user") {
      const { text, hadResponse } = consumeUserContent(obj.content, openTools);
      if (text.trim()) {
        turns.push({ role: "human", timestamp: obj.timestamp, blocks: [{ kind: "text", text: text.trim() }] });
        if (obj.id) leafUuid = obj.id;
      } else if (hadResponse && obj.id) {
        leafUuid = obj.id; // pure tool-echo turn
      }
    } else if (obj.type === "model" || obj.type === "assistant" || obj.type === "gemini") {
      const blocks = assistantBlocks(obj.content, openTools);
      if (blocks.length) {
        turns.push({ role: "assistant", timestamp: obj.timestamp, blocks });
        if (obj.id) leafUuid = obj.id;
      }
    }
    // type "info" and unknowns: skip (system/auth noise).
  }

  if (turns.length === 0) return null; // empty/login-only session

  if (!createdAt) createdAt = updatedAt || new Date(0).toISOString();
  if (!updatedAt) updatedAt = createdAt;
  return {
    id: sessionId,
    title,
    model: null,
    createdAt,
    updatedAt,
    project,
    leafUuid: leafUuid ?? sessionId,
    turns,
  };
}

/** Normalize a content field to a {@link GPart} list: wrap a bare string, pass arrays through. */
function getParts(content: unknown): GPart[] {
  if (typeof content === "string") return [{ text: content }];
  if (Array.isArray(content)) return content as GPart[];
  return [];
}

/**
 * Split a `user` event's content into human text and tool echoes. Any
 * `functionResponse` parts are attached to their open tool block (a side effect on
 * `openTools`) rather than producing text.
 *
 * @param content - The `user` event's content field.
 * @param openTools - Tool blocks awaiting a response, keyed by tool name; mutated.
 * @returns The joined human text and whether any tool response was consumed.
 */
function consumeUserContent(
  content: unknown,
  openTools: Map<string, ToolBlock[]>
): { text: string; hadResponse: boolean } {
  const texts: string[] = [];
  let hadResponse = false;
  for (const part of getParts(content)) {
    if (part.functionResponse) {
      hadResponse = true;
      attachResponse(part.functionResponse, openTools);
    } else if (typeof part.text === "string" && part.text) {
      texts.push(part.text);
    }
  }
  return { text: texts.join("\n\n"), hadResponse };
}

/**
 * Convert a model/assistant event's content into normalized blocks: text parts
 * become `text` blocks; `functionCall` parts become `tool` blocks that are also
 * pushed onto `openTools` to await their response; inline `functionResponse` parts
 * are paired immediately.
 *
 * @param content - The model event's content field.
 * @param openTools - Tool blocks awaiting a response, keyed by tool name; mutated.
 * @returns The assistant turn's blocks, in order.
 */
function assistantBlocks(content: unknown, openTools: Map<string, ToolBlock[]>): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = [];
  for (const part of getParts(content)) {
    if (typeof part.text === "string" && part.text.trim()) {
      blocks.push({ kind: "text", text: part.text.trim() });
    } else if (part.functionCall) {
      const name = part.functionCall.name ?? "tool";
      const block: ToolBlock = { kind: "tool", name, id: part.functionCall.id, input: part.functionCall.args };
      blocks.push(block);
      const open = openTools.get(name) ?? [];
      open.push(block);
      openTools.set(name, open);
    } else if (part.functionResponse) {
      // A response inline on a model message: still pair it.
      attachResponse(part.functionResponse, openTools);
    }
  }
  return blocks;
}

/**
 * Attach a tool result to the oldest open tool block of the same name (FIFO via
 * `shift`), stringifying non-string responses. A response with no matching open
 * call is dropped.
 *
 * @param fr - The `functionResponse` payload (tool name and result).
 * @param openTools - Tool blocks awaiting a response, keyed by tool name; mutated.
 */
function attachResponse(
  fr: { name?: string; response?: unknown },
  openTools: Map<string, ToolBlock[]>
): void {
  const name = fr.name ?? "tool";
  const open = openTools.get(name);
  const target = open && open.length ? open.shift() : undefined;
  const out =
    typeof fr.response === "string" ? fr.response : safeStringify(fr.response);
  if (target) target.output = out;
}

/** Pretty-print a value as 2-space JSON, falling back to `String()` if it cannot serialize. */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
