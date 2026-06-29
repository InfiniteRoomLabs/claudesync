/**
 * Render a parsed Claude Code session into greppable markdown.
 *
 * The web exporter's `formatConversation` only emits a role header plus the
 * message's plain `text`; Claude Code messages are arrays of typed blocks
 * (text / thinking / tool_use / tool_result), so we render them here.
 *
 * Three fidelity modes (see the plan):
 *   - compact   (default): text turns + a one-line tool reference; the tool's
 *     full input+output is written to an external `tool-outputs/` file. Thinking
 *     is omitted from the transcript.
 *   - truncated: text + thinking inline; tool input inline; tool output inline up
 *     to a byte cap, with the overflow written to an external file + a link.
 *   - full:      everything inline; no external files.
 */

import { slugify } from "../util/naming.js";
import type { CcContentBlock, CcLine, ParsedSession } from "./parse.js";

/**
 * How much of each turn lands inline in `conversation.md` vs. an external file.
 *
 * - `compact`: text turns plus a one-line tool reference; full tool I/O goes to
 *   `tool-outputs/`; thinking is dropped.
 * - `truncated`: text + thinking inline, tool input inline, tool output inline up
 *   to a byte cap with the overflow spilled to a file.
 * - `full`: everything inline, no external files.
 */
export type ClaudeCodeFidelity = "compact" | "truncated" | "full";

/** Knobs for {@link renderSession}. Both fields have defaults when passed partially. */
export interface RenderOptions {
  /** How much detail to inline; see {@link ClaudeCodeFidelity}. */
  fidelity: ClaudeCodeFidelity;
  /** Inline byte cap for a single tool output in `truncated` mode. */
  truncateCapBytes: number;
}

/** The rendered artifacts for one session: the two markdown bodies plus any spill files. */
export interface RenderedSession {
  /** conversation.md body. */
  markdown: string;
  /** README.md body. */
  readme: string;
  /** Relative path (under the session dir) -> file content, e.g. tool-outputs/*. */
  externalFiles: Map<string, string>;
  /** Number of turns on the rendered branch. */
  messageCount: number;
}

/** Default inline cap for a single tool output in `truncated` mode (20 KiB). */
const DEFAULT_TRUNCATE_CAP_BYTES = 20 * 1024;

/**
 * Render a parsed session into greppable markdown plus any external spill files.
 *
 * Linearizes the message DAG to the live branch (via {@link linearBranch}),
 * keeps only `user`/`assistant` turns, and emits one `## Human`/`## Assistant`
 * section per turn. Tool outputs are matched to their calls through the
 * tool_result echo lines collected by {@link collectToolResults}.
 *
 * @param session - The parsed session to render.
 * @param opts - Partial {@link RenderOptions}; defaults to `compact` fidelity and the 20 KiB cap.
 * @returns The rendered markdown, README, spill files, and branch turn count.
 */
export function renderSession(
  session: ParsedSession,
  opts: Partial<RenderOptions> = {}
): RenderedSession {
  const fidelity = opts.fidelity ?? "compact";
  const cap = opts.truncateCapBytes ?? DEFAULT_TRUNCATE_CAP_BYTES;

  // Walk the FULL DAG (CC links user->attachment->assistant, so filtering to
  // user/assistant before walking would orphan the root), then keep only the
  // transcript turns.
  const branch = linearBranch(session.lines, session.leafUuid).filter(
    (l) => l.type === "user" || l.type === "assistant"
  );
  const toolResults = collectToolResults(branch);
  const externalFiles = new Map<string, string>();

  const sections: string[] = [];
  let toolSeq = 0;

  for (const line of branch) {
    if (line.type === "user") {
      const text = humanText(line.message?.content);
      // null = pure tool_result echo (rendered at the tool_use site); ""/blank
      // = nothing to show. Skip either way.
      if (!text || !text.trim()) continue;
      sections.push(turn("Human", line.timestamp, text.trim()));
    } else if (line.type === "assistant") {
      const body = renderAssistant(
        line,
        toolResults,
        { fidelity, cap },
        externalFiles,
        () => ++toolSeq
      );
      if (!body.trim()) continue; // e.g. a thinking-only turn in compact mode
      sections.push(turn("Assistant", line.timestamp, body));
    }
  }

  return {
    markdown: sections.join("\n"),
    readme: buildReadme(session, branch.length, fidelity),
    externalFiles,
    messageCount: branch.length,
  };
}

// --- branch linearization -------------------------------------------------

/**
 * Walk `parentUuid` from the leaf back to the root over ALL lines (including
 * non-transcript `attachment`/`queue-operation` nodes that sit in the DAG),
 * then reverse. This yields the canonical branch and drops any rewound/off-leaf
 * turns left in the file. Callers filter the result to the turn types they want.
 *
 * @param lines - All parsed lines (transcript and non-transcript nodes alike).
 * @param leafUuid - The branch leaf to start from; if null or not found, the last line with a uuid is used.
 * @returns The root-to-leaf chain in chronological order (a cycle guard stops on any repeated uuid).
 */
export function linearBranch(lines: CcLine[], leafUuid: string | null): CcLine[] {
  const byUuid = new Map<string, CcLine>();
  for (const l of lines) if (l.uuid) byUuid.set(l.uuid, l);

  let startUuid: string | null = null;
  if (leafUuid && byUuid.has(leafUuid)) {
    startUuid = leafUuid;
  } else {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].uuid) {
        startUuid = lines[i].uuid!;
        break;
      }
    }
  }

  const chain: CcLine[] = [];
  const seen = new Set<string>();
  let cur = startUuid ? byUuid.get(startUuid) : undefined;
  while (cur && cur.uuid && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    chain.push(cur);
    const parent = cur.parentUuid;
    cur = parent ? byUuid.get(parent) : undefined;
  }
  chain.reverse();
  return chain;
}

/** Map tool_use_id -> rendered result text, gathered from tool_result echo lines on the branch. */
function collectToolResults(branch: CcLine[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of branch) {
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        const prefix = block.is_error ? "[error]\n" : "";
        map.set(block.tool_use_id, prefix + stringifyContent(block.content));
      }
    }
  }
  return map;
}

// --- assistant block rendering -------------------------------------------

/**
 * Render one assistant turn's content blocks into a markdown body. Thinking is
 * dropped in `compact`; tool_use blocks are delegated to {@link renderToolUse}.
 *
 * @param line - The assistant line to render.
 * @param toolResults - tool_use_id -> rendered result text, from {@link collectToolResults}.
 * @param opts - Active fidelity and the truncation cap.
 * @param externalFiles - Accumulator the tool renderer writes spill files into.
 * @param nextSeq - Monotonic sequence source for unique spill-file names.
 * @returns The joined block bodies, or "" when nothing renders (e.g. thinking-only in compact).
 */
function renderAssistant(
  line: CcLine,
  toolResults: Map<string, string>,
  opts: { fidelity: ClaudeCodeFidelity; cap: number },
  externalFiles: Map<string, string>,
  nextSeq: () => number
): string {
  const content = line.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    switch (block?.type) {
      case "text":
        if (block.text?.trim()) parts.push(block.text.trim());
        break;
      case "thinking":
        if (opts.fidelity !== "compact" && block.thinking?.trim()) {
          parts.push(`_thinking:_\n\n${block.thinking.trim()}`);
        }
        break;
      case "tool_use":
        parts.push(
          renderToolUse(block, toolResults, opts, externalFiles, nextSeq)
        );
        break;
      // tool_result blocks never appear on assistant lines; ignore others.
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Render a single `tool_use` block (and its matched output) at the chosen
 * fidelity. In `compact` the whole I/O is spilled to a `tool-outputs/` file and
 * only a one-line link is inlined; in `truncated` the output is inlined up to
 * the byte cap, spilling the remainder; in `full` everything is inlined.
 *
 * @param block - The `tool_use` content block.
 * @param toolResults - tool_use_id -> rendered result text, from {@link collectToolResults}.
 * @param opts - Active fidelity and the truncation cap.
 * @param externalFiles - Accumulator that receives any spill file (keyed by relative path).
 * @param nextSeq - Monotonic sequence source for unique spill-file names.
 * @returns The markdown for this tool call.
 */
function renderToolUse(
  block: CcContentBlock,
  toolResults: Map<string, string>,
  opts: { fidelity: ClaudeCodeFidelity; cap: number },
  externalFiles: Map<string, string>,
  nextSeq: () => number
): string {
  const name = block.name ?? "tool";
  const toolId = block.id ?? "";
  const input = block.input === undefined ? "" : jsonPretty(block.input);
  const output = (toolId && toolResults.get(toolId)) || "";

  if (opts.fidelity === "compact") {
    const rel = externalFilePath(nextSeq(), name, toolId);
    externalFiles.set(rel, toolFileBody(name, toolId, input, output));
    return `- **tool:** \`${name}\` -> [full I/O](${rel})`;
  }

  const lines: string[] = [`**Tool: \`${name}\`** \`${toolId}\``];
  if (input) lines.push(`\nInput:\n${fenced(input, "json")}`);

  if (opts.fidelity === "full") {
    lines.push(`\nOutput:\n${fenced(output)}`);
  } else {
    // truncated
    const { body, truncated } = truncateBytes(output, opts.cap);
    if (truncated) {
      const rel = externalFilePath(nextSeq(), name, toolId);
      externalFiles.set(rel, toolFileBody(name, toolId, input, output));
      lines.push(
        `\nOutput (truncated, [full output](${rel})):\n${fenced(body)}`
      );
    } else {
      lines.push(`\nOutput:\n${fenced(output)}`);
    }
  }
  return lines.join("\n");
}

/** Build a stable, collision-resistant spill-file relpath: `tool-outputs/NNNN-<slug>-<shortid>.md`. */
function externalFilePath(seq: number, name: string, toolId: string): string {
  const num = String(seq).padStart(4, "0");
  const shortId = toolId.replace(/^toolu_/, "").slice(0, 8) || "noid";
  return `tool-outputs/${num}-${slugify(name) || "tool"}-${shortId}.md`;
}

/** Assemble the full markdown body of a spilled `tool-outputs/` file (header + fenced input/output). */
function toolFileBody(name: string, toolId: string, input: string, output: string): string {
  return [
    `# Tool: ${name}`,
    `toolUseId: ${toolId}`,
    ``,
    `## Input`,
    fenced(input || "(none)", "json"),
    ``,
    `## Output`,
    fenced(output || "(none)"),
    ``,
  ].join("\n");
}

// --- helpers --------------------------------------------------------------

/**
 * Extract human-authored text from a user line's content. Returns null when the
 * line carries no human text (i.e. it is a pure tool_result echo), signalling
 * the caller to skip it.
 */
function humanText(content: string | CcContentBlock[] | undefined): string | null {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  let sawToolResult = false;
  for (const block of content) {
    if (block?.type === "text" && block.text?.trim()) texts.push(block.text.trim());
    else if (block?.type === "tool_result") sawToolResult = true;
  }
  if (texts.length === 0 && sawToolResult) return null;
  return texts.join("\n\n");
}

/** Flatten a tool_result `content` value (string, block array, or arbitrary value) to display text. */
function stringifyContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as CcContentBlock;
        if (block?.type === "text" && typeof block.text === "string") return block.text;
        if (block?.type === "image") return "[image]";
        return jsonPretty(block);
      })
      .join("\n");
  }
  return jsonPretty(content);
}

/** Pretty-print a value as 2-space JSON, falling back to `String(value)` if it is not serializable. */
function jsonPretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Wrap a turn body in its `## <role>` header plus an italic timestamp line. */
function turn(role: string, timestamp: string | undefined, body: string): string {
  return `## ${role}\n_${timestamp ?? ""}_\n\n${body}\n`;
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
 * Trim a string to at most `capBytes` UTF-8 bytes, appending a `... [truncated]`
 * marker when it had to cut. Slices by characters (never mid-byte) so the result
 * is always valid UTF-8.
 *
 * @param s - The text to cap.
 * @param capBytes - Maximum allowed UTF-8 byte length before truncation.
 * @returns The (possibly trimmed) body and whether truncation occurred.
 */
function truncateBytes(s: string, capBytes: number): { body: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= capBytes) return { body: s, truncated: false };
  // Slice by chars until under cap, then append a marker.
  let body = s.slice(0, capBytes);
  while (Buffer.byteLength(body, "utf8") > capBytes && body.length > 0) {
    body = body.slice(0, -256);
  }
  return { body: body + "\n... [truncated]", truncated: true };
}

/** Build the `README.md` body: a metadata header summarizing the session and render settings. */
function buildReadme(
  session: ParsedSession,
  messageCount: number,
  fidelity: ClaudeCodeFidelity
): string {
  return [
    `# ${session.title ?? session.sessionId}`,
    ``,
    `- **Session ID:** ${session.sessionId}`,
    `- **Project (cwd):** ${session.cwd || "unknown"}`,
    `- **Model:** ${session.model ?? "unknown"}`,
    `- **Created:** ${session.createdAt}`,
    `- **Updated:** ${session.updatedAt}`,
    `- **Git branch:** ${session.gitBranch ?? "n/a"}`,
    `- **Messages:** ${messageCount}`,
    `- **Fidelity:** ${fidelity}`,
    ``,
    `---`,
    ``,
    `Exported from the local Claude Code session cache by [ClaudeSync](https://github.com/infiniteroomlabs/claudesync)`,
    ``,
  ].join("\n");
}
