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

/** Options for {@link runClaudeCodeSync}. Only `outputRoot` is required. */
export interface RunClaudeCodeSyncOptions {
  /** Corpus root. Content is written under `<outputRoot>/claude-code/`. */
  outputRoot: string;
  /** Render fidelity; defaults to `compact`. */
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
  /** Cooperative cancellation; checked before each session, returns the partial result when aborted. */
  signal?: AbortSignal;
  /** Progress sink invoked as the run proceeds; see {@link ClaudeCodeProgressEvent}. */
  onProgress?: (e: ClaudeCodeProgressEvent) => void;
}

/** Progress events emitted by {@link runClaudeCodeSync} via `onProgress`. */
export type ClaudeCodeProgressEvent =
  /** Emitted once after planning, before any session is written. */
  | { type: "start"; projects: number; sessions: number }
  /** Emitted once per session that finished (whether exported or skipped). */
  | {
      type: "session-done";
      completed: number;
      total: number;
      action: "exported" | "skipped-existing" | "skipped-same";
      displayName: string;
    }
  /** Emitted on a plan-time parse failure or a write failure for one session. */
  | { type: "error"; displayName: string; message: string };

/** Tally returned by {@link runClaudeCodeSync} once the run completes (or aborts). */
export interface RunClaudeCodeSyncResult {
  /** Distinct project dirs seen across the planned sessions. */
  projects: number;
  /** Total sessions planned (the denominator for progress). */
  sessions: number;
  /** Sessions written this run. */
  exported: number;
  /** Sessions skipped via `skipExisting` or `skipSame`. */
  skipped: number;
  /** Sessions that failed to write (plan-time parse errors are not counted here). */
  errors: number;
}

/**
 * Sync the local Claude Code session cache into the corpus in two passes: plan
 * output paths from peeked metadata ({@link planSessions}), then build and write
 * each session ({@link buildSessionTree} + {@link writeTreeWithPreserve}),
 * honoring the skip and abort options and emitting progress as it goes.
 *
 * A plan-time parse failure is reported as an `error` event but does not count
 * toward {@link RunClaudeCodeSyncResult.errors}; only per-session write failures do.
 *
 * @param ccHome - Claude Code home dir (the parent of `projects/`).
 * @param opts - Output root plus fidelity, skip, preserve, abort, and progress options.
 * @returns The run tally (also returned early, partially filled, if `opts.signal` aborts mid-run).
 */
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

/**
 * True if a previously written session is unchanged and can be skipped: its
 * persisted {@link SyncState} leaf uuid and `updated_at` both still match the
 * freshly planned session. A missing or corrupt state forces a re-export.
 *
 * @param sessionDir - The session's output dir, holding the prior sync state.
 * @param p - The freshly planned session to compare against.
 * @returns True when nothing changed since the last sync.
 */
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
