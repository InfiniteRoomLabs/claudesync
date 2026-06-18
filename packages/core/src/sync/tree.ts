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
