/**
 * Generic Class-D "local datastore" source surface (PRD 001 Phase 1.5).
 *
 * Many local agent tools (Claude Code, Gemini CLI, opencode, aider, Cursor, ...)
 * persist conversations in their own on-disk format. They all map onto one
 * normalized model -- a session is an ordered list of human/assistant turns,
 * each turn a list of text / thinking / tool blocks. A provider supplies a thin
 * {@link DatastoreAdapter} (its format -> the normalized model); this module
 * does the rest: render to the same greppable tree the `cc://` source emits
 * (conversation.md + README.md + tool-outputs/), plan collision-safe output
 * paths, and present it as a {@link SourceSurface} that rides the existing seam.
 *
 * cc:// keeps its own bespoke reader; this is the shared substrate for the
 * remaining Class-D providers so each is just a parser.
 */

import { disambiguateSlugs, slugify } from "../util/naming.js";
import type { SyncState } from "../sync/state.js";
import type { TreePayload } from "../sync/tree.js";
import type {
  CanonicalItem,
  ItemRef,
  ParsedUri,
  Selector,
  SourceSurface,
  SurfaceCaps,
} from "./types.js";

// --- normalized model -----------------------------------------------------

export type NormalizedBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      name: string;
      id?: string;
      input?: unknown;
      output?: string;
      isError?: boolean;
    };

export interface NormalizedTurn {
  role: "human" | "assistant";
  timestamp?: string;
  blocks: NormalizedBlock[];
}

export interface NormalizedSession {
  id: string;
  title: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  /** A project path or name; its basename drives the project slug. */
  project: string;
  /** Stable id of the last turn (for --skip-same). Falls back to the session id. */
  leafUuid: string | null;
  turns: NormalizedTurn[];
}

/** Lightweight per-session metadata for listing/grouping (no full parse). */
export interface AdapterListItem {
  id: string;
  title: string | null;
  project: string;
  updatedAt: string;
  leafUuid: string | null;
}

/** A provider's format -> normalized model. The only per-provider code needed. */
export interface DatastoreAdapter {
  readonly scheme: string;
  /** Enumerate sessions (cheap metadata only). */
  list(): AdapterListItem[];
  /** Fully parse one session into the normalized model. */
  read(id: string): NormalizedSession;
}

export type DatastoreFidelity = "compact" | "truncated" | "full";

export interface DatastoreSourceOptions {
  fidelity?: DatastoreFidelity;
  /** Inline byte cap for a single tool output in `truncated` mode. Default 20KB. */
  truncateCapBytes?: number;
}

// --- rendering (normalized session -> tree) -------------------------------

const DEFAULT_TRUNCATE_CAP_BYTES = 20 * 1024;

interface RenderedTree {
  files: Map<string, string>;
  messageCount: number;
}

export function renderNormalized(
  session: NormalizedSession,
  opts: DatastoreSourceOptions = {}
): RenderedTree {
  const fidelity = opts.fidelity ?? "compact";
  const cap = opts.truncateCapBytes ?? DEFAULT_TRUNCATE_CAP_BYTES;

  const files = new Map<string, string>();
  const sections: string[] = [];
  let toolSeq = 0;
  let rendered = 0;

  for (const t of session.turns) {
    const body = renderTurn(t, fidelity, cap, files, () => ++toolSeq);
    if (!body.trim()) continue; // e.g. a thinking-only assistant turn in compact mode
    rendered++;
    const role = t.role === "human" ? "Human" : "Assistant";
    sections.push(`## ${role}\n_${t.timestamp ?? ""}_\n\n${body}\n`);
  }

  files.set("conversation.md", sections.join("\n"));
  files.set("README.md", buildReadme(session, rendered, fidelity));
  return { files, messageCount: rendered };
}

function renderTurn(
  turn: NormalizedTurn,
  fidelity: DatastoreFidelity,
  cap: number,
  files: Map<string, string>,
  nextSeq: () => number
): string {
  const parts: string[] = [];
  for (const block of turn.blocks) {
    if (block.kind === "text") {
      if (block.text.trim()) parts.push(block.text.trim());
    } else if (block.kind === "thinking") {
      if (fidelity !== "compact" && block.text.trim()) {
        parts.push(`_thinking:_\n\n${block.text.trim()}`);
      }
    } else {
      parts.push(renderTool(block, fidelity, cap, files, nextSeq));
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

function renderTool(
  block: Extract<NormalizedBlock, { kind: "tool" }>,
  fidelity: DatastoreFidelity,
  cap: number,
  files: Map<string, string>,
  nextSeq: () => number
): string {
  const name = block.name || "tool";
  const id = block.id ?? "";
  const input = block.input === undefined ? "" : jsonPretty(block.input);
  const output = (block.isError ? "[error]\n" : "") + (block.output ?? "");

  if (fidelity === "compact") {
    const rel = externalFilePath(nextSeq(), name, id);
    files.set(rel, toolFileBody(name, id, input, output));
    return `- **tool:** \`${name}\` -> [full I/O](${rel})`;
  }

  const lines: string[] = [`**Tool: \`${name}\`** \`${id}\``];
  if (input) lines.push(`\nInput:\n${fenced(input, "json")}`);

  if (fidelity === "full") {
    lines.push(`\nOutput:\n${fenced(output)}`);
  } else {
    const { body, truncated } = truncateBytes(output, cap);
    if (truncated) {
      const rel = externalFilePath(nextSeq(), name, id);
      files.set(rel, toolFileBody(name, id, input, output));
      lines.push(`\nOutput (truncated, [full output](${rel})):\n${fenced(body)}`);
    } else {
      lines.push(`\nOutput:\n${fenced(output)}`);
    }
  }
  return lines.join("\n");
}

function externalFilePath(seq: number, name: string, id: string): string {
  const num = String(seq).padStart(4, "0");
  const shortId = id.replace(/^(toolu_|call_|prt_)/, "").slice(0, 8) || "noid";
  return `tool-outputs/${num}-${slugify(name) || "tool"}-${shortId}.md`;
}

function toolFileBody(name: string, id: string, input: string, output: string): string {
  return [
    `# Tool: ${name}`,
    `toolUseId: ${id}`,
    ``,
    `## Input`,
    fenced(input || "(none)", "json"),
    ``,
    `## Output`,
    fenced(output || "(none)"),
    ``,
  ].join("\n");
}

function buildReadme(
  session: NormalizedSession,
  messageCount: number,
  fidelity: DatastoreFidelity
): string {
  return [
    `# ${session.title ?? session.id}`,
    ``,
    `- **Session ID:** ${session.id}`,
    `- **Project:** ${session.project || "unknown"}`,
    `- **Model:** ${session.model ?? "unknown"}`,
    `- **Created:** ${session.createdAt}`,
    `- **Updated:** ${session.updatedAt}`,
    `- **Messages:** ${messageCount}`,
    `- **Fidelity:** ${fidelity}`,
    ``,
    `---`,
    ``,
    `Exported from a local agent session datastore by [ClaudeSync](https://github.com/infiniteroomlabs/claudesync)`,
    ``,
  ].join("\n");
}

// --- the generic source surface -------------------------------------------

interface PlannedItem extends AdapterListItem {
  relPath: string;
}

export class DatastoreSource implements SourceSurface {
  readonly uri: ParsedUri;
  readonly caps: SurfaceCaps = { read: true, write: false, delete: false, list: true };

  private readonly byId = new Map<string, PlannedItem>();
  private planned?: PlannedItem[];

  constructor(
    private readonly adapter: DatastoreAdapter,
    private readonly options: DatastoreSourceOptions = {},
    uri?: ParsedUri
  ) {
    this.uri = uri ?? { scheme: adapter.scheme, host: "local", path: "/", query: {} };
  }

  async *list(selector?: Selector): AsyncIterable<ItemRef> {
    for (const p of this.plan()) {
      if (selector?.conversationId && p.id !== selector.conversationId) continue;
      yield this.toRef(p);
    }
  }

  async read(ref: ItemRef): Promise<CanonicalItem> {
    if (!this.byId.has(ref.id)) this.plan();
    const p = this.byId.get(ref.id);
    if (!p) throw new Error(`${this.adapter.scheme} session not found: ${ref.id}`);

    const session = this.adapter.read(p.id);
    const rendered = renderNormalized(session, this.options);
    const state = makeState(session, rendered.messageCount);
    return { ref, tree: { files: rendered.files, state } };
  }

  /** Enumerate + group by project + compute collision-safe output relpaths. */
  private plan(): PlannedItem[] {
    if (this.planned) return this.planned;
    const items = this.adapter.list();

    const byProject = new Map<string, AdapterListItem[]>();
    for (const it of items) {
      const key = projectSlug(it.project);
      let g = byProject.get(key);
      if (!g) byProject.set(key, (g = []));
      g.push(it);
    }

    const planned: PlannedItem[] = [];
    for (const [projSlug, group] of byProject) {
      const slugs = disambiguateSlugs(group.map((it) => ({ name: it.title, uuid: it.id })));
      for (const it of group) {
        planned.push({
          ...it,
          relPath: `${this.adapter.scheme}/${projSlug}/${slugs.get(it.id)!}`,
        });
      }
    }

    this.planned = planned;
    for (const p of planned) this.byId.set(p.id, p);
    return planned;
  }

  private toRef(p: PlannedItem): ItemRef {
    return {
      id: p.id,
      kind: "session",
      name: p.title ?? p.id,
      updatedAt: p.updatedAt,
      currentLeafUuid: p.leafUuid,
      relPath: p.relPath,
    };
  }
}

// --- helpers --------------------------------------------------------------

/** Project slug from a path-or-name: basename, slugified. */
function projectSlug(project: string): string {
  const base = project.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || project;
  return slugify(base) || "root";
}

function makeState(session: NormalizedSession, messageCount: number): SyncState {
  const leaf = session.leafUuid ?? session.id;
  return {
    schema_version: 1,
    conversation_uuid: session.id,
    conversation_name: session.title ?? session.id,
    model: session.model,
    updated_at: session.updatedAt,
    current_leaf_message_uuid: leaf,
    leaves: [{ uuid: leaf, last_message_index: messageCount }],
    artifacts: [],
    last_sync_at: new Date().toISOString(),
    last_sync_action: "full",
  };
}

function jsonPretty(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Wrap body in a code fence long enough to survive backtick runs inside it. */
function fenced(body: string, lang = ""): string {
  let max = 0;
  let run = 0;
  for (const ch of body) {
    if (ch === "`") {
      run++;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  const ticks = "`".repeat(Math.max(3, max + 1));
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

function truncateBytes(s: string, capBytes: number): { body: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= capBytes) return { body: s, truncated: false };
  let body = s.slice(0, capBytes);
  while (Buffer.byteLength(body, "utf8") > capBytes && body.length > 0) {
    body = body.slice(0, -256);
  }
  return { body: body + "\n... [truncated]", truncated: true };
}
