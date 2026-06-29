/**
 * The fan-out orchestrator (PRD 001 section 7): read each item from the source
 * once, write the same canonical item to every sink. Skip decisions mirror
 * `syncConversation` exactly (skip-existing, then skip-same), so a
 * single-source/single-sink run is byte-identical to the legacy path.
 *
 * Arbitrary N-source x M-sink is out of scope; this is one source, N sinks.
 */

import { isSameByListMetadata } from "../sync/incremental.js";
import { displayName as toDisplayName } from "../util/naming.js";
import type { ExportFormat } from "../sync/materialize.js";
import type {
  ApplyOpts,
  ApplyResult,
  CanonicalItem,
  ItemRef,
  Selector,
  SinkSurface,
  SourceSurface,
} from "./types.js";

/**
 * Options for one {@link sync} run. Mirrors the legacy `syncConversation` flags
 * so a single-source/single-sink run reproduces it exactly.
 */
export interface SyncOptions {
  /** Narrows which items {@link SourceSurface.list} yields. */
  selector?: Selector;
  /** Output format passed through to every sink (e.g. `git`, `json`). */
  format: ExportFormat;
  /** Glob/path patterns a sink leaves untouched when overwriting. */
  preserve?: readonly string[];
  /** Commit author name, for git-format output. */
  authorName?: string;
  /** Commit author email, for git-format output. */
  authorEmail?: string;
  /** Skip an item when the sink's target already exists (the dumb existence check). */
  skipExisting?: boolean;
  /** Skip an item when list metadata matches the sink's prior state (the incremental check). */
  skipSame?: boolean;
}

/**
 * Fan-out sync: list the source once, then for each item write it to every sink,
 * reading the item at most once (lazily, only if some sink actually needs it).
 *
 * Per (ref, sink) the skip order matches `syncConversation`: `--skip-existing`
 * first, then `--skip-same` against {@link SinkSurface.stat}. The prior state from
 * that `stat` is threaded into {@link SinkSurface.write} to avoid a second read.
 *
 * @param source - The single source whose items are enumerated and read.
 * @param sinks - One or more sinks each item is written to.
 * @param opts - Format, author, selector, and skip flags.
 * @returns One {@link ApplyResult} per (item, sink) attempt, in encounter order.
 */
export async function sync(
  source: SourceSurface,
  sinks: SinkSurface[],
  opts: SyncOptions
): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  const applyOpts: ApplyOpts = {
    format: opts.format,
    preserve: opts.preserve,
    authorName: opts.authorName,
    authorEmail: opts.authorEmail,
  };

  for await (const ref of source.list(opts.selector)) {
    // Read at most once per ref, lazily, then fan out to each writing sink.
    let item: CanonicalItem | null = null;

    for (const sink of sinks) {
      // --skip-existing: dumb existence check on the sink's target.
      if (opts.skipExisting && (await sink.exists(ref))) {
        results.push(skipResult(ref, "skipped-existing", "output exists"));
        continue;
      }

      // --skip-same: compare list metadata against the sink's prior state.
      const prev = await sink.stat(ref);
      if (opts.skipSame && isSameByListMetadata(refMeta(ref), prev ?? undefined)) {
        results.push(skipResult(ref, "skipped", "unchanged since last sync"));
        continue;
      }

      if (!item) item = await source.read(ref);
      results.push(await sink.write(item, applyOpts, prev));
    }
  }

  return results;
}

/**
 * Adapt an {@link ItemRef} to the list-metadata shape `isSameByListMetadata` expects.
 *
 * @param ref - The item reference whose freshness fields are read.
 * @returns The `updated_at` / `current_leaf_message_uuid` pair, with defaults for absent fields.
 */
function refMeta(ref: ItemRef): {
  updated_at: string;
  current_leaf_message_uuid: string | null;
} {
  return {
    updated_at: ref.updatedAt ?? "",
    current_leaf_message_uuid: ref.currentLeafUuid ?? null,
  };
}

/**
 * Build the {@link ApplyResult} recorded when an item is skipped (no write occurs).
 *
 * @param ref - The skipped item.
 * @param action - Which kind of skip this was.
 * @param reason - Human-readable explanation surfaced in logs.
 * @returns A result with `changelogWritten: false` and a derived display name.
 */
function skipResult(
  ref: ItemRef,
  action: "skipped" | "skipped-existing",
  reason: string
): ApplyResult {
  return {
    ref,
    action,
    reason,
    changelogWritten: false,
    displayName: toDisplayName(ref.name, ref.id),
  };
}
