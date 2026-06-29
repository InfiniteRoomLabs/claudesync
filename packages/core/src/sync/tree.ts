/**
 * Write a pre-rendered file tree (relpath -> content) to a directory with the
 * same preserve/state semantics the conversation exporters use:
 *   - CHANGELOG.md and `--preserve` globs survive a re-sync,
 *   - the `.claudesync-state.json` sidecar is rewritten fresh.
 *
 * This is the write half of the surface seam's pre-rendered-tree path (PRD 001
 * Phase 1). It is the single source of truth shared by the `claude-code`
 * subcommand and the `cc://` FileSink, so both produce byte-identical output.
 */

import fs from "node:fs";
import path from "node:path";
import {
  replaceWithPreserve,
  expandPreserveForProject,
} from "./files-mode.js";
import { CHANGELOG_FILENAME } from "./changelog.js";
import { STATE_FILENAME, writeSyncState, type SyncState } from "./state.js";

/** A pre-rendered tree plus the sync state to record alongside it. */
export interface TreePayload {
  /** Relative path (POSIX, under `outputPath`) -> file content. */
  files: Map<string, string>;
  /** What to write to `.claudesync-state.json`. */
  state: SyncState;
}

/**
 * Writes a pre-rendered file tree to `outputPath` with the same preserve/state
 * semantics the conversation exporters use, then records the sync state sidecar.
 *
 * {@link CHANGELOG_FILENAME} and any caller-supplied `preserve` globs survive
 * the replace; {@link STATE_FILENAME} is always dropped and rewritten fresh by
 * {@link writeSyncState} so it cannot go stale. The replace and the fresh
 * writes run through {@link replaceWithPreserve}, making this the single source
 * of truth shared by the `claude-code` subcommand and the `cc://` FileSink.
 *
 * @param outputPath - Destination directory for the tree.
 * @param payload - The files to write and the {@link SyncState} to persist.
 * @param preserve - Extra preserve globs, expanded via
 * {@link expandPreserveForProject} before matching.
 */
export async function writeTreeWithPreserve(
  outputPath: string,
  payload: TreePayload,
  preserve: readonly string[] = []
): Promise<void> {
  await replaceWithPreserve({
    outputPath,
    alwaysPreserve: [CHANGELOG_FILENAME],
    alwaysDrop: [STATE_FILENAME],
    preserveGlobs: expandPreserveForProject(preserve),
    writeFresh: async () => {
      for (const [rel, content] of payload.files) {
        const dest = path.join(outputPath, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content, "utf-8");
      }
    },
  });
  writeSyncState(outputPath, payload.state);
}
