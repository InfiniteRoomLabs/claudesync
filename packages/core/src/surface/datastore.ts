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

/** One unit of content within a turn: plain text, model thinking, or a tool call with its result. */
export type NormalizedBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      /** Tool name (e.g. `Bash`, `Read`). */
      name: string;
      /** Provider tool-use id, when the source records one. */
      id?: string;
      /** Tool input; rendered as pretty JSON (or passed through if already a string). */
      input?: unknown;
      /** Tool result text, when available. */
      output?: string;
      /** Whether `output` is an error result. */
      isError?: boolean;
    };

/** One human or assistant turn: an ordered list of {@link NormalizedBlock}s. */
export interface NormalizedTurn {
  /** Who produced the turn. */
  role: "human" | "assistant";
  /** ISO timestamp of the turn, when the source records one. */
  timestamp?: string;
  /** The turn's content blocks, in order. */
  blocks: NormalizedBlock[];
}

/** A whole agent session in the shared normalized model: metadata plus ordered turns. */
export interface NormalizedSession {
  /** Stable session id. */
  id: string;
  /** Session title, or null when the source has none. */
  title: string | null;
  /** Model id, or null when unknown. */
  model: string | null;
  /** ISO creation timestamp. */
  createdAt: string;
  /** ISO last-updated timestamp. */
  updatedAt: string;
  /** A project path or name; its basename drives the project slug. */
  project: string;
  /** Stable id of the last turn (for --skip-same). Falls back to the session id. */
  leafUuid: string | null;
  /** Ordered conversation turns. */
  turns: NormalizedTurn[];
}

/** Lightweight per-session metadata for listing/grouping (no full parse). */
export interface AdapterListItem {
  /** Stable session id. */
  id: string;
  /** Session title, or null. */
  title: string | null;
  /** Project path or name; its basename drives the project slug. */
  project: string;
  /** ISO last-updated timestamp. */
  updatedAt: string;
  /** Stable id of the last turn, or null. */
  leafUuid: string | null;
}

/** A provider's format -> normalized model. The only per-provider code needed. */
export interface DatastoreAdapter {
  /** URI scheme this adapter answers for (e.g. `cc`, `aider`). */
  readonly scheme: string;
  /** Enumerate sessions (cheap metadata only). */
  list(): AdapterListItem[];
  /** Fully parse one session into the normalized model. */
  read(id: string): NormalizedSession;
}

/**
 * How much tool I/O to inline when rendering.
 *
 * - `"compact"` - drop thinking blocks; spill every tool's I/O to a `tool-outputs/`
 *   file and inline only a link.
 * - `"truncated"` - inline tool output up to {@link DatastoreSourceOptions.truncateCapBytes},
 *   spilling the overflow to a file.
 * - `"full"` - inline everything; never spill.
 */
export type DatastoreFidelity = "compact" | "truncated" | "full";

/** Options for {@link renderNormalized} and {@link DatastoreSource}. */
export interface DatastoreSourceOptions {
  /** Rendering detail level. Defaults to `compact`. */
  fidelity?: DatastoreFidelity;
  /** Inline byte cap for a single tool output in `truncated` mode. Default 20KB. */
  truncateCapBytes?: number;
}

// --- rendering (normalized session -> tree) -------------------------------

const DEFAULT_TRUNCATE_CAP_BYTES = 20 * 1024;

/** Output of {@link renderNormalized}: the rendered file map plus rendered-turn count. */
interface RenderedTree {
  /** `relPath -> content` for every file in the rendered tree. */
  files: Map<string, string>;
  /** Number of non-empty turns rendered (drives the state's last message index). */
  messageCount: number;
}

/**
 * Render a normalized session to the greppable `cc://`-style tree: `conversation.md`,
 * `README.md`, and one `tool-outputs/` file per externalized tool I/O. Empty turns
 * (e.g. thinking-only assistant turns in compact mode) are dropped, not counted.
 *
 * @param session - The parsed session to render.
 * @param opts - Fidelity and truncation settings; fidelity defaults to `compact`.
 * @returns The rendered file map and the count of non-empty turns rendered.
 */
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

/**
 * Render one turn's blocks to markdown. Text is emitted verbatim; thinking is
 * dropped in `compact` mode and labeled otherwise; tool blocks defer to
 * {@link renderTool}. Returns `""` for a turn with no visible content.
 *
 * @param turn - The turn whose blocks are rendered.
 * @param fidelity - How much detail to emit.
 * @param cap - Inline byte cap for tool output in `truncated` mode.
 * @param files - Accumulator that externalized tool files are spilled into.
 * @param nextSeq - Monotonic counter used to name externalized files.
 * @returns The turn body as markdown, or `""` if nothing was rendered.
 */
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

/**
 * Render a single tool block. In `compact` mode the full I/O is always spilled to
 * a `tool-outputs/` file and only a link is inlined; in `truncated` mode output
 * over `cap` bytes is spilled; in `full` mode everything is inlined.
 *
 * @param block - The tool block to render.
 * @param fidelity - How much I/O to inline vs. externalize.
 * @param cap - Inline byte cap for output in `truncated` mode.
 * @param files - Accumulator the externalized file is added to.
 * @param nextSeq - Monotonic counter used to name the externalized file.
 * @returns The inline markdown for the block (a link, or fenced I/O).
 */
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

/**
 * Build the collision-safe relative path for an externalized tool file:
 * `tool-outputs/{seq}-{slug}-{shortId}.md`. The sequence number is zero-padded to
 * 4 digits and the provider id prefix (`toolu_`/`call_`/`prt_`) is stripped before
 * taking the first 8 chars (falling back to `noid`).
 *
 * @param seq - Monotonic sequence number, zero-padded to 4 digits.
 * @param name - Tool name; slugified for the path.
 * @param id - Tool-use id; prefix-stripped and truncated to 8 chars.
 * @returns The relative `tool-outputs/...md` path.
 */
function externalFilePath(seq: number, name: string, id: string): string {
  const num = String(seq).padStart(4, "0");
  const shortId = id.replace(/^(toolu_|call_|prt_)/, "").slice(0, 8) || "noid";
  return `tool-outputs/${num}-${slugify(name) || "tool"}-${shortId}.md`;
}

/**
 * Format the body of an externalized tool file: a header plus fenced Input and
 * Output sections (each shown as `(none)` when empty).
 *
 * @param name - Tool name.
 * @param id - Tool-use id.
 * @param input - Pre-stringified tool input.
 * @param output - Tool output (already error-prefixed if applicable).
 * @returns The full markdown file body.
 */
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

/**
 * Build the per-session `README.md`: a title plus a metadata block (id, project,
 * model, timestamps, message count, fidelity).
 *
 * @param session - Source of the metadata.
 * @param messageCount - Rendered-turn count, as returned by {@link renderNormalized}.
 * @param fidelity - The fidelity the session was rendered at.
 * @returns The `README.md` contents.
 */
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

/** An {@link AdapterListItem} with its computed, collision-safe output path. */
interface PlannedItem extends AdapterListItem {
  /** Output path relative to the sink base: `<scheme>/<project>/<session>`. */
  relPath: string;
}

/**
 * A read-only {@link SourceSurface} over any {@link DatastoreAdapter}: lists the
 * adapter's sessions (grouped by project into collision-safe output paths) and
 * reads each into the shared rendered tree via {@link renderNormalized}.
 */
export class DatastoreSource implements SourceSurface {
  /** This source's endpoint, e.g. `cc://local/`. */
  readonly uri: ParsedUri;

  /** Read-only: this surface lists and reads, never writes or deletes. */
  readonly caps: SurfaceCaps = { read: true, write: false, delete: false, list: true };

  /** Planned items indexed by session id, populated lazily by {@link plan}. */
  private readonly byId = new Map<string, PlannedItem>();
  /** Memoized plan; computed once on first {@link list}/{@link read}. */
  private planned?: PlannedItem[];

  /**
   * @param adapter - Provider that supplies the format -> normalized-model mapping.
   * @param options - Rendering options forwarded to {@link renderNormalized}.
   * @param uri - Endpoint to advertise; defaults to `<scheme>://local/`.
   */
  constructor(
    private readonly adapter: DatastoreAdapter,
    private readonly options: DatastoreSourceOptions = {},
    uri?: ParsedUri
  ) {
    this.uri = uri ?? { scheme: adapter.scheme, host: "local", path: "/", query: {} };
  }

  /**
   * Enumerate sessions as {@link ItemRef}s, optionally narrowed to a single
   * session id via `selector.conversationId`.
   *
   * @param selector - Optional filter restricting which sessions are yielded.
   * @returns Lazily-produced references to each matching session.
   */
  async *list(selector?: Selector): AsyncIterable<ItemRef> {
    for (const p of this.plan()) {
      if (selector?.conversationId && p.id !== selector.conversationId) continue;
      yield this.toRef(p);
    }
  }

  /**
   * Fully parse and render the session named by `ref` into a tree {@link CanonicalItem}.
   *
   * @param ref - Reference (typically from {@link list}) to read.
   * @returns The canonical item carrying the rendered `tree`.
   * @throws If no planned session matches `ref.id`.
   */
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

  /** Project a planned session into the public {@link ItemRef} shape. */
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

/**
 * Build the sink {@link SyncState} for a freshly rendered session. Local datastore
 * reads are always full syncs (no incremental diffing), so `last_sync_action` is
 * `"full"` and the single leaf records `messageCount` as its last message index.
 *
 * @param session - The session that was rendered.
 * @param messageCount - Rendered-turn count from {@link renderNormalized}.
 * @returns The state to persist alongside the tree.
 */
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

/** Pretty-print a value as 2-space JSON; pass strings through unchanged; never throw. */
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

/**
 * Truncate a string to at most `capBytes` UTF-8 bytes on a character boundary,
 * appending a `... [truncated]` marker when it cuts.
 *
 * @param s - The string to bound.
 * @param capBytes - Maximum UTF-8 byte length.
 * @returns The possibly-truncated body and whether truncation occurred.
 */
function truncateBytes(s: string, capBytes: number): { body: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= capBytes) return { body: s, truncated: false };
  let body = s.slice(0, capBytes);
  while (Buffer.byteLength(body, "utf8") > capBytes && body.length > 0) {
    body = body.slice(0, -256);
  }
  return { body: body + "\n... [truncated]", truncated: true };
}
