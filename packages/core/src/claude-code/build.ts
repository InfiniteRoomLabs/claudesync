/**
 * Pure builders shared by the `claude-code` subcommand (`runClaudeCodeSync`) and
 * the `cc://` source surface (`CcSource`). Keeping the layout planning and the
 * session->tree rendering in one place is what makes the two paths produce
 * byte-identical output (PRD 001 Phase 1).
 *
 *   planSessions(ccHome)   -- discover + peek + group + slug -> output relpaths.
 *   buildSessionTree(meta) -- parse + render (+ subagents) + state -> a tree.
 */

import fs from "node:fs";
import path from "node:path";

import { disambiguateSlugs } from "../util/naming.js";
import type { SyncState } from "../sync/state.js";
import type { TreePayload } from "../sync/tree.js";
import {
  discoverSessions,
  parseLines,
  parseSession,
  summarize,
  type DiscoveredSession,
  type ParsedSession,
} from "./parse.js";
import { renderSession, type ClaudeCodeFidelity } from "./render.js";

/** A discovered session plus the peeked metadata + computed output relpath. */
export interface PlannedSession {
  /** Session UUID. */
  sessionId: string;
  /** Absolute path to the session's `<sessionId>.jsonl` file. */
  jsonlPath: string;
  /** Absolute path to the `<sessionId>/` sidecar dir, or null if absent. */
  sidecarDir: string | null;
  /** Human-readable title (latest `ai-title`), or null. */
  title: string | null;
  /** Canonical leaf uuid; used for the unchanged-since-last-sync check. */
  leafUuid: string | null;
  /** ISO timestamp of the last line; used for the unchanged-since-last-sync check. */
  updatedAt: string;
  /** The dash-encoded project directory name this session belongs to. */
  projectDir: string;
  /** Relative output path under the corpus root: `claude-code/<proj>/<session>`. */
  relPath: string;
}

/** Options for {@link buildSessionTree}; all optional, with the defaults noted per field. */
export interface BuildSessionTreeOptions {
  /** Render fidelity; defaults to `compact`. */
  fidelity?: ClaudeCodeFidelity;
  /** Inline byte cap for a single tool output in `truncated` mode. */
  truncateCapBytes?: number;
  /** Convert subagent sidechains too. Default true. */
  includeSubagents?: boolean;
}

/** A {@link DiscoveredSession} enriched with the metadata peeked in pass 1 of {@link planSessions}. */
interface PeekedSession extends DiscoveredSession {
  /** Human-readable title (latest `ai-title`), or null. */
  title: string | null;
  /** Canonical leaf uuid, or null. */
  leafUuid: string | null;
  /** ISO timestamp of the last line. */
  updatedAt: string;
}

/**
 * Pass 1: enumerate every session, peek the metadata needed for collision-safe
 * directory names + freshness checks, and compute each session's output
 * relpath. Grouping/slug order follows `discoverSessions` order so both the
 * subcommand and the seam land sessions in identical directories.
 *
 * @param ccHome - Claude Code home dir (the parent of `projects/`).
 * @param onError - Called per session whose JSONL fails to parse; that session is dropped from the plan, not fatal.
 * @returns One {@link PlannedSession} per parseable session, with output relpaths assigned.
 */
export function planSessions(
  ccHome: string,
  onError?: (sessionId: string, message: string) => void
): PlannedSession[] {
  const peeked: PeekedSession[] = [];
  for (const d of discoverSessions(ccHome)) {
    try {
      const s = parseSession(d.jsonlPath);
      peeked.push({ ...d, title: s.title, leafUuid: s.leafUuid, updatedAt: s.updatedAt });
    } catch (err) {
      onError?.(d.sessionId, err instanceof Error ? err.message : String(err));
    }
  }

  // Group by project dir (preserving discovery order).
  const byProject = new Map<string, PeekedSession[]>();
  for (const m of peeked) {
    let group = byProject.get(m.projectDir);
    if (!group) byProject.set(m.projectDir, (group = []));
    group.push(m);
  }

  const planned: PlannedSession[] = [];
  for (const [projectDir, group] of byProject) {
    const projectSlug = projectDirToSlug(projectDir);
    const sessionSlugs = disambiguateSlugs(
      group.map((m) => ({ name: m.title, uuid: m.sessionId }))
    );
    for (const m of group) {
      planned.push({
        sessionId: m.sessionId,
        jsonlPath: m.jsonlPath,
        sidecarDir: m.sidecarDir,
        title: m.title,
        leafUuid: m.leafUuid,
        updatedAt: m.updatedAt,
        projectDir,
        relPath: `claude-code/${projectSlug}/${sessionSlugs.get(m.sessionId)!}`,
      });
    }
  }
  return planned;
}

/**
 * Parse + render a single session (and its subagents) into a writable tree.
 *
 * Produces `conversation.md`, `README.md`, any `tool-outputs/` spill files, and
 * -- when enabled -- a `subagents/<slug>/...` subtree per sidechain, plus the
 * {@link SyncState} that drives the unchanged-since-last-sync check.
 *
 * @param meta - The session to build; only its id and on-disk paths are needed.
 * @param opts - Render fidelity, truncation cap, and subagent inclusion (see {@link BuildSessionTreeOptions}).
 * @returns The `files` map (relpath -> content) plus the session's sync `state`.
 * @throws If the session JSONL cannot be read or parsed.
 */
export function buildSessionTree(
  meta: Pick<PlannedSession, "sessionId" | "jsonlPath" | "sidecarDir">,
  opts: BuildSessionTreeOptions = {}
): TreePayload {
  const renderOpts = {
    fidelity: opts.fidelity ?? ("compact" as ClaudeCodeFidelity),
    truncateCapBytes: opts.truncateCapBytes,
  };
  const session = parseSession(meta.jsonlPath);
  const rendered = renderSession(session, renderOpts);

  const files = new Map<string, string>();
  files.set("conversation.md", rendered.markdown);
  files.set("README.md", rendered.readme);
  for (const [rel, content] of rendered.externalFiles) files.set(rel, content);

  if ((opts.includeSubagents ?? true) && meta.sidecarDir) {
    for (const [rel, content] of buildSubagentFiles(meta.sidecarDir, renderOpts)) {
      files.set(rel, content);
    }
  }

  return { files, state: buildState(session, rendered.messageCount) };
}

// --- subagents ------------------------------------------------------------

/**
 * Render each `subagents/agent-*.jsonl` sidechain into `subagents/<slug>/...`
 * tree entries. Slugs come from each sidechain's `agentType` (disambiguated by
 * id). A missing `subagents/` dir, no sidechains, or one bad sidechain log all
 * degrade gracefully rather than failing the parent session.
 *
 * @param sidecarDir - The session's `<sessionId>/` sidecar dir.
 * @param renderOpts - Fidelity and truncation cap forwarded to {@link renderSession}.
 * @returns Relpath -> content for every successfully rendered subagent; empty when there are none.
 */
function buildSubagentFiles(
  sidecarDir: string,
  renderOpts: { fidelity: ClaudeCodeFidelity; truncateCapBytes?: number }
): Map<string, string> {
  const out = new Map<string, string>();
  const subRoot = path.join(sidecarDir, "subagents");
  let entries: string[];
  try {
    entries = fs.readdirSync(subRoot).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return out;
  }
  if (entries.length === 0) return out;

  const items = entries.map((file) => {
    const id = file.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    const meta = readSubagentMeta(path.join(subRoot, `agent-${id}.meta.json`));
    return { file, id, agentType: meta.agentType };
  });
  const slugs = disambiguateSlugs(
    items.map((it) => ({ name: it.agentType ?? "agent", uuid: it.id }))
  );

  for (const it of items) {
    try {
      const raw = fs.readFileSync(path.join(subRoot, it.file), "utf-8");
      const session = summarize(it.id, parseLines(raw));
      if (session.transcript.length === 0) continue;
      const rendered = renderSession(session, renderOpts);
      const base = `subagents/${slugs.get(it.id)!}`;
      out.set(`${base}/conversation.md`, rendered.markdown);
      out.set(`${base}/README.md`, rendered.readme);
      for (const [rel, content] of rendered.externalFiles) out.set(`${base}/${rel}`, content);
    } catch {
      // One bad subagent log should not fail the parent session.
    }
  }
  return out;
}

/** Read a subagent's `agent-<id>.meta.json` sidecar; returns `{}` if missing or unparseable. */
function readSubagentMeta(metaPath: string): { agentType?: string } {
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return {};
  }
}

// --- state + naming -------------------------------------------------------

/**
 * Build the {@link SyncState} sidecar persisted next to a rendered session. The
 * `current_leaf_message_uuid` + `updated_at` pair is what `skipSame` re-syncs
 * compare against to detect an unchanged session.
 *
 * @param session - The parsed session the state describes.
 * @param messageCount - Turn count on the rendered branch, recorded as the leaf's `last_message_index`.
 * @returns A fully populated state with `last_sync_action: "full"` and the current timestamp.
 */
export function buildState(session: ParsedSession, messageCount: number): SyncState {
  return {
    schema_version: 1,
    conversation_uuid: session.sessionId,
    conversation_name: session.title ?? session.sessionId,
    model: session.model,
    updated_at: session.updatedAt,
    current_leaf_message_uuid: session.leafUuid,
    leaves: session.leafUuid
      ? [{ uuid: session.leafUuid, last_message_index: messageCount }]
      : [],
    artifacts: [],
    last_sync_at: new Date().toISOString(),
    last_sync_action: "full",
  };
}

/**
 * Project slug from the dash-encoded project dir name. CC encodes the cwd by
 * replacing every `/` with `-`, which is already unique per project; we strip
 * the leading dash(es) for a cleaner directory name.
 *
 * @param projectDir - The dash-encoded project dir name (e.g. `-home-deathnerd-foo`).
 * @returns The slug with leading dashes stripped, or `"root"` if nothing remains.
 */
export function projectDirToSlug(projectDir: string): string {
  return projectDir.replace(/^-+/, "") || "root";
}
