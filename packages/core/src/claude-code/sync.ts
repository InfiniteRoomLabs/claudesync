/**
 * Orchestrate a one-shot sync of the local Claude Code session cache into the
 * corpus, mirroring the web exporter's per-conversation layout. Output lands
 * under `<outputRoot>/claude-code/<project>/<session>/` so it sits beside the
 * `export-all` web export.
 *
 * The layout planning and session->tree rendering live in `build.ts`, shared
 * with the `cc://` source surface so the two paths are byte-identical
 * (PRD 001 Phase 1). This module owns the progress/skip/abort orchestration.
 */

import fs from "node:fs";
import path from "node:path";

import { writeTreeWithPreserve } from "../sync/tree.js";
import { readSyncState, type SyncState } from "../sync/state.js";
import {
  planSessions,
  buildSessionTree,
  type PlannedSession,
} from "./build.js";
import type { ClaudeCodeFidelity } from "./render.js";

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

export async function runClaudeCodeSync(
  ccHome: string,
  opts: RunClaudeCodeSyncOptions
): Promise<RunClaudeCodeSyncResult> {
  const onProgress = opts.onProgress ?? (() => {});

  // Pass 1: plan output paths from peeked metadata (a parse failure here is
  // reported but does not count toward the write-error tally).
  const planned = planSessions(ccHome, (sessionId, message) =>
    onProgress({ type: "error", displayName: sessionId, message })
  );

  const result: RunClaudeCodeSyncResult = {
    projects: new Set(planned.map((p) => p.projectDir)).size,
    sessions: planned.length,
    exported: 0,
    skipped: 0,
    errors: 0,
  };
  onProgress({ type: "start", projects: result.projects, sessions: result.sessions });

  let completed = 0;
  for (const p of planned) {
    if (opts.signal?.aborted) return result;
    completed++;
    const displayName = p.title ?? p.sessionId;
    const sessionDir = path.join(opts.outputRoot, p.relPath);

    try {
      if (opts.skipExisting && fs.existsSync(sessionDir)) {
        result.skipped++;
        onProgress({ type: "session-done", completed, total: result.sessions, action: "skipped-existing", displayName });
        continue;
      }
      if (opts.skipSame && isUnchanged(sessionDir, p)) {
        result.skipped++;
        onProgress({ type: "session-done", completed, total: result.sessions, action: "skipped-same", displayName });
        continue;
      }

      const tree = buildSessionTree(p, {
        fidelity: opts.fidelity,
        truncateCapBytes: opts.truncateCapBytes,
        includeSubagents: opts.includeSubagents,
      });
      await writeTreeWithPreserve(sessionDir, tree, opts.preserve ?? []);

      result.exported++;
      onProgress({ type: "session-done", completed, total: result.sessions, action: "exported", displayName });
    } catch (err) {
      result.errors++;
      onProgress({ type: "error", displayName, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

function isUnchanged(sessionDir: string, p: PlannedSession): boolean {
  let state: SyncState | undefined;
  try {
    state = readSyncState(sessionDir);
  } catch {
    return false; // corrupt/unreadable state -> re-export
  }
  return (
    !!state &&
    state.current_leaf_message_uuid === p.leafUuid &&
    state.updated_at === p.updatedAt
  );
}
