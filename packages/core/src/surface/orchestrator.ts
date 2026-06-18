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

export interface SyncOptions {
  selector?: Selector;
  format: ExportFormat;
  preserve?: readonly string[];
  authorName?: string;
  authorEmail?: string;
  skipExisting?: boolean;
  skipSame?: boolean;
}

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

function refMeta(ref: ItemRef): {
  updated_at: string;
  current_leaf_message_uuid: string | null;
} {
  return {
    updated_at: ref.updatedAt ?? "",
    current_leaf_message_uuid: ref.currentLeafUuid ?? null,
  };
}

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
