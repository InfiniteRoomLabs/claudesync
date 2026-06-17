/**
 * Orchestrate a one-shot sync of the local Claude Code session cache into the
 * corpus, mirroring the web exporter's per-conversation layout. Output lands
 * under `<outputRoot>/claude-code/<project>/<session>/` so it sits beside the
 * `export-all` web export.
 */

import fs from "node:fs";
import path from "node:path";

import { disambiguateSlugs, slugify } from "../util/naming.js";
import {
  replaceWithPreserve,
  expandPreserveForProject,
} from "../sync/files-mode.js";
import { CHANGELOG_FILENAME } from "../sync/changelog.js";
import {
  STATE_FILENAME,
  readSyncState,
  writeSyncState,
  type SyncState,
} from "../sync/state.js";
import {
  discoverSessions,
  parseLines,
  parseSession,
  summarize,
  type DiscoveredSession,
  type ParsedSession,
} from "./parse.js";
import { renderSession, type ClaudeCodeFidelity, type RenderedSession } from "./render.js";

export interface RunClaudeCodeSyncOptions {
  /** Corpus root. Content is written under `<outputRoot>/claude-code/`. */
  outputRoot: string;
  fidelity?: ClaudeCodeFidelity;
  /** Inline byte cap for a single tool output in `truncated` mode. Default 20KB. */
  truncateCapBytes?: number;
  /** Convert subagent sidechains too. Default true. */
  includeSubagents?: boolean;
  /** Skip sessions whose output dir already exists. */
  skipExisting?: boolean;
  /** Skip sessions unchanged since last sync (by leaf + updated_at). */
  skipSame?: boolean;
  /** Globs of locally-added files to preserve across re-syncs. */
  preserve?: string[];
  signal?: AbortSignal;
  onProgress?: (e: ClaudeCodeProgressEvent) => void;
}

export type ClaudeCodeProgressEvent =
  | { type: "start"; projects: number; sessions: number }
  | {
      type: "session-done";
      completed: number;
      total: number;
      action: "exported" | "skipped-existing" | "skipped-same";
      displayName: string;
    }
  | { type: "error"; displayName: string; message: string };

export interface RunClaudeCodeSyncResult {
  projects: number;
  sessions: number;
  exported: number;
  skipped: number;
  errors: number;
}

interface SessionMeta extends DiscoveredSession {
  title: string | null;
  leafUuid: string | null;
  updatedAt: string;
}

export async function runClaudeCodeSync(
  ccHome: string,
  opts: RunClaudeCodeSyncOptions
): Promise<RunClaudeCodeSyncResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const fidelity = opts.fidelity ?? "compact";
  const truncateCapBytes = opts.truncateCapBytes;
  const includeSubagents = opts.includeSubagents ?? true;
  const root = path.join(opts.outputRoot, "claude-code");

  // Pass 1: peek every session for the metadata needed to compute stable,
  // collision-safe directory names (and freshness for --skip-same).
  const discovered = discoverSessions(ccHome);
  const metas: SessionMeta[] = [];
  for (const d of discovered) {
    try {
      const s = parseSession(d.jsonlPath);
      metas.push({ ...d, title: s.title, leafUuid: s.leafUuid, updatedAt: s.updatedAt });
    } catch (err) {
      onProgress({ type: "error", displayName: d.sessionId, message: errMsg(err) });
    }
  }

  // Group by project dir; compute project + session slugs.
  const byProject = new Map<string, SessionMeta[]>();
  for (const m of metas) {
    let group = byProject.get(m.projectDir);
    if (!group) {
      group = [];
      byProject.set(m.projectDir, group);
    }
    group.push(m);
  }

  const result: RunClaudeCodeSyncResult = {
    projects: byProject.size,
    sessions: metas.length,
    exported: 0,
    skipped: 0,
    errors: 0,
  };
  onProgress({ type: "start", projects: result.projects, sessions: result.sessions });

  let completed = 0;
  const preserveGlobs = expandPreserveForProject(opts.preserve ?? []);

  for (const [projectDir, group] of byProject) {
    const projectSlug = projectDirToSlug(projectDir);
    const sessionSlugs = disambiguateSlugs(
      group.map((m) => ({ name: m.title, uuid: m.sessionId }))
    );

    for (const meta of group) {
      if (opts.signal?.aborted) return result;
      completed++;
      const displayName = meta.title ?? meta.sessionId;
      const sessionDir = path.join(root, projectSlug, sessionSlugs.get(meta.sessionId)!);

      try {
        // Skip checks (cheap, from pass-1 metadata).
        if (opts.skipExisting && fs.existsSync(sessionDir)) {
          result.skipped++;
          onProgress({ type: "session-done", completed, total: result.sessions, action: "skipped-existing", displayName });
          continue;
        }
        if (opts.skipSame && isUnchanged(sessionDir, meta)) {
          result.skipped++;
          onProgress({ type: "session-done", completed, total: result.sessions, action: "skipped-same", displayName });
          continue;
        }

        const session = parseSession(meta.jsonlPath);
        const rendered = renderSession(session, { fidelity, truncateCapBytes });

        await replaceWithPreserve({
          outputPath: sessionDir,
          alwaysPreserve: [CHANGELOG_FILENAME],
          alwaysDrop: [STATE_FILENAME],
          preserveGlobs,
          writeFresh: async () => {
            writeRendered(sessionDir, rendered);
            if (includeSubagents && meta.sidecarDir) {
              writeSubagents(sessionDir, meta.sidecarDir, { fidelity, truncateCapBytes });
            }
          },
        });

        writeSyncState(sessionDir, buildState(session, rendered.messageCount));
        result.exported++;
        onProgress({ type: "session-done", completed, total: result.sessions, action: "exported", displayName });
      } catch (err) {
        result.errors++;
        onProgress({ type: "error", displayName, message: errMsg(err) });
      }
    }
  }

  return result;
}

// --- writing --------------------------------------------------------------

function writeRendered(dir: string, rendered: RenderedSession): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "conversation.md"), rendered.markdown, "utf-8");
  fs.writeFileSync(path.join(dir, "README.md"), rendered.readme, "utf-8");
  for (const [rel, content] of rendered.externalFiles) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, "utf-8");
  }
}

/** Convert each `subagents/agent-*.jsonl` sidechain into its own folder under the session. */
function writeSubagents(
  sessionDir: string,
  sidecarDir: string,
  opts: { fidelity: ClaudeCodeFidelity; truncateCapBytes?: number }
): void {
  const subRoot = path.join(sidecarDir, "subagents");
  let entries: string[];
  try {
    entries = fs.readdirSync(subRoot).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return;
  }
  if (entries.length === 0) return;

  // Disambiguate subagent folder names by agentType + the file's id.
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
      const rendered = renderSession(session, opts);
      writeRendered(path.join(sessionDir, "subagents", slugs.get(it.id)!), rendered);
    } catch {
      // One bad subagent log should not fail the parent session.
    }
  }
}

function readSubagentMeta(metaPath: string): { agentType?: string } {
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return {};
  }
}

function buildState(session: ParsedSession, messageCount: number): SyncState {
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

function isUnchanged(sessionDir: string, meta: SessionMeta): boolean {
  let state: SyncState | undefined;
  try {
    state = readSyncState(sessionDir);
  } catch {
    return false; // corrupt/unreadable state -> re-export
  }
  return (
    !!state &&
    state.current_leaf_message_uuid === meta.leafUuid &&
    state.updated_at === meta.updatedAt
  );
}

// --- naming ---------------------------------------------------------------

/**
 * Project slug from the dash-encoded project dir name. CC encodes the cwd by
 * replacing every `/` with `-`, which is already unique per project; we just
 * strip the leading dash(es) for a cleaner directory name.
 */
function projectDirToSlug(projectDir: string): string {
  return projectDir.replace(/^-+/, "") || "root";
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
