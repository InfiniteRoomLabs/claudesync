/**
 * The surface seam (PRD 001 Phase 0).
 *
 * Re-expresses ClaudeSync's two hardcoded ends (claude.ai web API in, local
 * filesystem out) as implementations of one addressable interface, selected by
 * a URI scheme. This is the abstraction Phase 1 (`cc://` and other local
 * datastores) and later phases (`s3://`, rsync, `viking://`) plug into.
 *
 * Two orthogonal axes (PRD 001 section 3):
 *   - transport: where the bytes live -- the URI scheme/host.
 *   - surface/format: what the data is -- `format` is a property of the sink
 *     (`?format=git`), not a scheme.
 */

import type { GitBundle } from "../export/types.js";
import type {
  ArtifactListResponse,
  Conversation,
  ConversationSummary,
} from "../models/types.js";
import type { SyncState } from "../sync/state.js";
import type { TreePayload } from "../sync/tree.js";
import type { ExportFormat } from "../sync/materialize.js";

/** A parsed `scheme://[user@][host][:port]/path[?query]` endpoint. */
export interface ParsedUri {
  scheme: string;
  user?: string;
  host?: string;
  port?: number;
  path: string;
  query: Record<string, string>;
}

export interface SurfaceCaps {
  read: boolean;
  write: boolean;
  delete: boolean;
  list: boolean;
}

/** An addressable endpoint. */
export interface Location {
  readonly uri: ParsedUri;
  readonly caps: SurfaceCaps;
}

export type ItemKind = "conversation" | "project" | "session";

/** A logical unit at a surface, with the list-metadata needed for skip decisions. */
export interface ItemRef {
  id: string;
  kind: ItemKind;
  name: string;
  /** From the list endpoint -- lets the orchestrator do --skip-same without a read. */
  updatedAt?: string;
  currentLeafUuid?: string | null;
  /**
   * Source-suggested relative output path (already slugified/disambiguated).
   * A nested {@link SinkSurface} writes the item at `<base>/<relPath>` when set.
   * Used by multi-item local sources like `cc://` whose nesting is computed
   * across the whole listing (`claude-code/<project>/<session>`).
   */
  relPath?: string;
}

/**
 * Neutral interchange produced by a source and consumed by a sink.
 *
 * Two shapes, distinguished by which field is set:
 *
 *  - **bundle** (claude.ai): the real wire format is the `GitBundle` (it
 *    preserves commit/branch structure a flat map would lose for `format=git`).
 *    `conversation`/`artifacts`/`summary` carry what an *incremental* sink needs
 *    (diff -> changelog, state file). The `materializeConversation` sink path.
 *  - **tree** (`cc://` and other Class D local sources, Phase 1): the source
 *    already rendered a flat `relPath -> content` tree (the PRD's
 *    `CanonicalTree`). The sink writes it verbatim via `writeTreeWithPreserve`.
 *    Bundle-only formats (`git`/`json`) do not apply to pre-rendered trees.
 *
 * Exactly one of `bundle` / `tree` is present.
 */
export interface CanonicalItem {
  ref: ItemRef;
  bundle?: GitBundle;
  conversation?: Conversation;
  artifacts?: ArtifactListResponse;
  summary?: ConversationSummary;
  /** Pre-rendered tree + state (mutually exclusive with `bundle`). */
  tree?: TreePayload;
}

/** What to select from a source. */
export interface Selector {
  /** Restrict a `claude://` source to a single conversation id. */
  conversationId?: string;
}

export interface ApplyOpts {
  format: ExportFormat;
  preserve?: readonly string[];
  authorName?: string;
  authorEmail?: string;
  /** Mirror source deletions. Phase 2 -- not yet honored. */
  delete?: boolean;
  /** Plan only, no writes. Phase 2 -- not yet honored. */
  dryRun?: boolean;
}

/** Sink-side prior state. For the file sink this is the `.claudesync-state.json`. */
export type SinkState = SyncState;

export interface ApplyResult {
  ref: ItemRef;
  action: "full" | "incremental" | "skipped" | "skipped-existing";
  reason?: string;
  changelogWritten: boolean;
  displayName: string;
}

export interface SourceSurface extends Location {
  /** Enumerate items, optionally narrowed by `selector`. */
  list(selector?: Selector): AsyncIterable<ItemRef>;
  /** Fetch + build the canonical item for `ref`. */
  read(ref: ItemRef): Promise<CanonicalItem>;
}

export interface SinkSurface extends Location {
  /** The output location this sink uses for `ref` (for display / nesting). */
  pathFor(ref: ItemRef): string;
  /** Whether the sink's materialized target for `ref` already exists
   *  (format-aware: the `<slug>.json` file in json mode, the dir otherwise). */
  exists(ref: ItemRef): Promise<boolean>;
  /** Prior state for `ref`, or null when nothing has been written yet. */
  stat(ref: ItemRef): Promise<SinkState | null>;
  /** Persist `item`. `prevState` comes from a prior `stat` (avoids a double read). */
  write(
    item: CanonicalItem,
    opts: ApplyOpts,
    prevState: SinkState | null
  ): Promise<ApplyResult>;
}
