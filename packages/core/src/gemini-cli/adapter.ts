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

export function defaultGeminiHome(): string {
  return path.join(os.homedir(), ".gemini", "tmp");
}

interface GLine {
  type?: string;
  id?: string;
  timestamp?: string;
  sessionId?: string;
  startTime?: string;
  lastUpdated?: string;
  content?: unknown;
  $set?: { lastUpdated?: string; summary?: string };
}

interface GPart {
  text?: string;
  functionCall?: { name?: string; args?: unknown; id?: string };
  functionResponse?: { name?: string; response?: unknown; id?: string };
}

type ToolBlock = Extract<NormalizedBlock, { kind: "tool" }>;

export class GeminiCliAdapter implements DatastoreAdapter {
  readonly scheme = "gemini-cli";
  private cache?: Map<string, NormalizedSession>;

  constructor(private readonly home: string = defaultGeminiHome()) {}

  list(): AdapterListItem[] {
    return [...this.all().values()].map((s) => ({
      id: s.id,
      title: s.title,
      project: s.project,
      updatedAt: s.updatedAt,
      leafUuid: s.leafUuid,
    }));
  }

  read(id: string): NormalizedSession {
    const s = this.all().get(id);
    if (!s) throw new Error(`gemini-cli session not found: ${id}`);
    return s;
  }

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

function readProjectRoot(p: string): string | null {
  try {
    const s = fs.readFileSync(p, "utf-8").trim();
    return s || null;
  } catch {
    return null;
  }
}

function parseGeminiFile(file: string, project: string): NormalizedSession | null {
  const raw = fs.readFileSync(file, "utf-8");
  let sessionId = path.basename(file, ".jsonl");
  let createdAt = "";
  let updatedAt = "";
  let title: string | null = null;
  let leafUuid: string | null = null;
  const turns: NormalizedTurn[] = [];
  // Open tool calls awaiting a functionResponse, by tool name (LIFO).
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

function getParts(content: unknown): GPart[] {
  if (typeof content === "string") return [{ text: content }];
  if (Array.isArray(content)) return content as GPart[];
  return [];
}

/** A user message may carry human text and/or functionResponse tool echoes. */
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

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
