/**
 * The fan-out orchestrator (PRD 001 section 7): read each item from the source
 * once, write the same canonical item to every sink. Skip decisions mirror
 * `syncConversation` exactly (skip-existing, then skip-same), so a
 * single-source/single-sink run is byte-identical to the legacy path.
 *
 * Arbitrary N-source x M-sink is out of scope; this is one source, N sinks.
 */

import { isSameByListMetadata } from "../sync/incremental.js";
import { decideEmptyAction, type OnBecameEmpty } from "../sync/empty.js";
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
  /**
   * When true (the default), an item whose source marked
   * {@link CanonicalItem.isEmpty} is diverted to the became-empty policy
   * ({@link onBecameEmpty}) instead of a normal write; see {@link sync}'s doc
   * for the exact per-sink decision. Set `false` to bypass this entirely --
   * an {@link CanonicalItem.isEmpty} item then flows through the normal write
   * path exactly as if this option never existed (matching whatever the
   * source itself does when its own `skipEmpty` is off).
   */
  skipEmpty?: boolean;
  /**
   * Policy applied to a sink when an item is empty and {@link skipEmpty} is in
   * effect. Only consulted when the sink already has output for this item (a
   * never-before-seen empty item is always `"skipped-empty"` regardless of
   * this value); see {@link OnBecameEmpty} for what each policy does.
   * Defaults to `"sync"`.
   */
  onBecameEmpty?: OnBecameEmpty;
}

/**
 * Fan-out sync: list the source once, then for each item write it to every sink,
 * reading the item at most once (lazily, only if some sink actually needs it).
 *
 * Per (ref, sink) the skip order matches `syncConversation`: `--skip-existing`
 * first, then `--skip-same` against {@link SinkSurface.stat}. The prior state from
 * that `stat` is threaded into {@link SinkSurface.write} to avoid a second read.
 *
 * After the read, when the item carries {@link CanonicalItem.isEmpty} and
 * {@link SyncOptions.skipEmpty} is not `false`, each sink is routed through the
 * became-empty policy instead of an unconditional write: no prior output on
 * that sink (`sink.exists` false) -> `"skipped-empty"`; prior output exists ->
 * {@link decideEmptyAction} on `opts.onBecameEmpty ?? "sync"` selects
 * `"retain"` (`"retained-stale"`, no write), `"clean"` (a write carrying
 * {@link ApplyOpts.cleanEmpty}), or `"materialize-full"` (a normal write with
 * `prevState` forced to `null`, mirroring `syncConversation`'s forced-full
 * rebuild for a became-empty `"sync"` policy). This reacts only to the neutral
 * `isEmpty` marker and the neutral `skipEmpty`/`onBecameEmpty` options -- it
 * never inspects messages, senders, or any other source-specific field, so a
 * source with no concept of emptiness (which never sets `isEmpty`) is
 * completely unaffected by this branch.
 *
 * @param source - The single source whose items are enumerated and read.
 * @param sinks - One or more sinks each item is written to.
 * @param opts - Format, author, selector, skip flags, and became-empty policy.
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

      if (item.isEmpty && opts.skipEmpty !== false) {
        const hasPriorOutput = await sink.exists(ref);
        if (!hasPriorOutput) {
          results.push(
            skipResult(ref, "skipped-empty", "item is empty and has no prior sink output to reconcile")
          );
          continue;
        }

        const action = decideEmptyAction(true, opts.onBecameEmpty ?? "sync");
        if (action === "retain") {
          results.push(
            skipResult(ref, "retained-stale", "item is empty; onBecameEmpty=retain keeps stale output untouched")
          );
          continue;
        }
        if (action === "clean") {
          results.push(await sink.write(item, { ...applyOpts, cleanEmpty: true }, prev));
          continue;
        }
        // action === "materialize-full" ("skip" is unreachable here since
        // hasPriorOutput/`decideEmptyAction`'s first argument is always
        // `true`): fall through to a normal write, forcing a fresh
        // (non-incremental) materialization by discarding prevState.
        results.push(await sink.write(item, applyOpts, null));
        continue;
      }

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
  action: "skipped" | "skipped-existing" | "skipped-empty" | "retained-stale",
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
