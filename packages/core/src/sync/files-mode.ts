/**
 * Stash-and-rebuild file-writing primitive shared between conversation and
 * project export paths.
 *
 * Both code paths produce a fresh, claudesync-canonical directory tree on
 * every re-sync. Without explicit rescue, anything the user added locally
 * (INDEX.md from a downstream indexer, hand-written notes, etc.) would be
 * wiped on every run.
 *
 * This helper:
 *   1. Renames the existing outputPath to a `<outputPath>.prev` stash.
 *   2. Runs the caller-supplied `writeFresh` to populate a clean outputPath.
 *   3. Walks the stash and copies back files that either equal an entry in
 *      `alwaysPreserve` or match any glob in `preserveGlobs`.
 *   4. Removes the stash on success, restores it on failure.
 *
 * Copies are non-destructive: if writeFresh already produced a file at the
 * same relative path, the bundle wins and the stash copy is skipped. This
 * protects against a user pattern accidentally clobbering conversation.md
 * or README.md.
 */

import fs from "node:fs";
import path from "node:path";
import { matchAnyGlob } from "../util/glob.js";

/**
 * Inputs to {@link replaceWithPreserve}: where to write, how to write, and which
 * locally-added files to rescue from the pre-existing tree.
 */
export interface ReplaceWithPreserveOptions {
  /** Final destination directory. May or may not exist. */
  outputPath: string;
  /** Callback that populates `outputPath` from scratch. Must create the dir. */
  writeFresh: () => Promise<void>;
  /**
   * Files preserved by exact relative-path match. CHANGELOG.md is the
   * canonical example; the changelog is appended to by the sync.
   */
  alwaysPreserve?: readonly string[];
  /**
   * Files dropped by exact relative-path match, even if they would otherwise
   * match `preserveGlobs`. `.claudesync-state.json` is the canonical example;
   * the caller rewrites it after this returns.
   */
  alwaysDrop?: readonly string[];
  /**
   * Glob patterns (POSIX) of locally-added files to preserve. Matched against
   * paths relative to `outputPath`. See `util/glob.ts` for syntax.
   */
  preserveGlobs?: readonly string[];
}

/**
 * Expand user `--preserve` globs for the project-bundle scope.
 *
 * `replaceWithPreserve` matches globs relative to the output dir. For a project
 * export the output dir is the project root, but conversation files are nested
 * under `conversations/<slug>/`, so a bare pattern like `INDEX.md` only matches
 * the project-root file and silently drops every nested conversation's
 * `INDEX.md`. The CLI documents `--preserve` as "relative to each conversation
 * dir", so each pattern must also apply at any nested depth.
 *
 * For every user pattern `p` we add a globstar-prefixed variant. The matcher
 * compiles a leading globstar+slash to an OPTIONAL leading-segments group (see
 * util/glob.ts), so the prefixed form already covers both the project root and
 * any nesting depth; we keep the original `p` too for clarity.
 *
 * Example: ["INDEX.md"] -> ["INDEX.md", "(globstar)/INDEX.md"].
 */
export function expandPreserveForProject(
  globs: readonly string[]
): string[] {
  return globs.flatMap((p) => [p, `**/${p}`]);
}

/**
 * Rebuild `outputPath` from scratch while rescuing locally-added files.
 *
 * Stashes any existing `outputPath` to a sibling `<outputPath>.prev`, runs
 * {@link ReplaceWithPreserveOptions.writeFresh} to lay down the canonical tree,
 * then copies back stash entries that match `alwaysPreserve` or `preserveGlobs`
 * (minus `alwaysDrop`). Files the fresh write already produced win -- the stash
 * copy is skipped for any path that now exists.
 *
 * The operation is atomic with respect to failure: if `writeFresh` or the
 * restore throws, the half-written output is removed and the stash is renamed
 * back into place, then the error is re-thrown. On the first sync (no existing
 * output) it is just `writeFresh` with no stash dance.
 *
 * @param opts - Destination, fresh-write callback, and preserve/drop rules.
 * @throws Re-throws whatever {@link ReplaceWithPreserveOptions.writeFresh} or
 *   the restore step throws, after rolling the prior tree back.
 */
export async function replaceWithPreserve(
  opts: ReplaceWithPreserveOptions
): Promise<void> {
  const {
    outputPath,
    writeFresh,
    alwaysPreserve = [],
    alwaysDrop = [],
    preserveGlobs = [],
  } = opts;

  const stash = outputPath + ".prev";
  const isUpdate = fs.existsSync(outputPath);
  if (isUpdate) {
    if (fs.existsSync(stash)) {
      fs.rmSync(stash, { recursive: true, force: true });
    }
    fs.renameSync(outputPath, stash);
  }

  try {
    await writeFresh();
    if (isUpdate) {
      restoreFromStash(stash, outputPath, alwaysPreserve, alwaysDrop, preserveGlobs);
      fs.rmSync(stash, { recursive: true, force: true });
    }
  } catch (error) {
    if (isUpdate) {
      if (fs.existsSync(outputPath)) {
        fs.rmSync(outputPath, { recursive: true, force: true });
      }
      if (fs.existsSync(stash)) {
        fs.renameSync(stash, outputPath);
      }
    }
    throw error;
  }
}

/**
 * Copy preserved files from a stash directory back into the freshly written
 * output, skipping any path the fresh write already produced (bundle wins).
 *
 * @param stash - Directory holding the prior tree (`<outputPath>.prev`).
 * @param outputPath - Freshly written destination to copy survivors into.
 * @param alwaysPreserve - Exact relative paths to preserve regardless of globs.
 * @param alwaysDrop - Exact relative paths to drop even if they match a glob.
 * @param preserveGlobs - POSIX globs of relative paths to preserve.
 */
function restoreFromStash(
  stash: string,
  outputPath: string,
  alwaysPreserve: readonly string[],
  alwaysDrop: readonly string[],
  preserveGlobs: readonly string[]
): void {
  const dropSet = new Set(alwaysDrop);
  const preserveSet = new Set(alwaysPreserve);
  for (const rel of walkRelative(stash)) {
    if (dropSet.has(rel)) continue;
    const shouldPreserve =
      preserveSet.has(rel) || matchAnyGlob(rel, preserveGlobs);
    if (!shouldPreserve) continue;

    const dest = path.join(outputPath, rel);
    if (fs.existsSync(dest)) continue; // bundle wins

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(stash, rel), dest);
  }
}

/** Yield every file path under root, as POSIX-separated paths relative to root. */
export function* walkRelative(root: string): Generator<string> {
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel === "" ? root : path.join(root, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push(childRel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        yield childRel;
      }
    }
  }
}
