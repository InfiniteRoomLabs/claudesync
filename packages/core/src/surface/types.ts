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

/**
 * A parsed `scheme://[user@][host][:port]/path[?query]` endpoint.
 */
export interface ParsedUri {
  /** URI scheme that selects the transport (e.g. `claude`, `cc`, `file`, `s3`). */
  scheme: string;
  /** Userinfo component (`user@`), when present. */
  user?: string;
  /** Host / authority component, when present. */
  host?: string;
  /** Port number, when present. */
  port?: number;
  /** Hierarchical path component (may be empty). */
  path: string;
  /** Decoded `?key=value` query parameters (e.g. `format=git`). */
  query: Record<string, string>;
}

/**
 * Capability flags advertising which operations a surface permits.
 */
export interface SurfaceCaps {
  /** The surface can read/fetch items. */
  read: boolean;
  /** The surface can persist items. */
  write: boolean;
  /** The surface can delete items at the target. */
  delete: boolean;
  /** The surface can enumerate its items. */
  list: boolean;
}

/**
 * An addressable endpoint: a parsed URI together with its capability flags.
 */
export interface Location {
  /** The endpoint's address. */
  readonly uri: ParsedUri;
  /** Operations this endpoint permits. */
  readonly caps: SurfaceCaps;
}

/**
 * The kind of item a surface exposes.
 *
 * - `"conversation"` - a single claude.ai conversation.
 * - `"project"` - a claude.ai project (a container of conversations + docs).
 * - `"session"` - a local agent session (e.g. a `cc://` Claude Code session).
 */
export type ItemKind = "conversation" | "project" | "session";

/**
 * A logical unit at a surface, with the list-metadata needed for skip decisions.
 */
export interface ItemRef {
  /** Stable identifier of the item within its source. */
  id: string;
  /** What sort of item this is. */
  kind: ItemKind;
  /** Human-readable display name. */
  name: string;
  /**
   * Last-modified timestamp from the list endpoint; lets the orchestrator do
   * `--skip-same` without a read.
   */
  updatedAt?: string;
  /**
   * UUID of the conversation's current leaf message, when the listing exposes
   * it; used for incremental skip checks.
   */
  currentLeafUuid?: string | null;
  /**
   * Source-suggested relative output path (already slugified/disambiguated). A
   * nested {@link SinkSurface} writes the item at `<base>/<relPath>` when set.
   * Used by multi-item local sources like `cc://` whose nesting is computed
   * across the whole listing (`claude-code/<project>/<session>`).
   */
  relPath?: string;
}

/**
 * Neutral interchange produced by a source and consumed by a sink.
 *
 * Carries exactly one of two payload shapes, distinguished by which field is set:
 *
 *  - **bundle** (claude.ai): the real wire format is the `GitBundle` (it preserves
 *    the commit/branch structure a flat map would lose for `format=git`).
 *    `conversation` / `artifacts` / `summary` carry what an *incremental* sink
 *    needs (diff -> changelog, state file). This is the `materializeConversation`
 *    sink path.
 *  - **tree** (`cc://` and other Class D local sources, Phase 1): the source has
 *    already rendered a flat `relPath -> content` tree (the PRD's `CanonicalTree`);
 *    the sink writes it verbatim via `writeTreeWithPreserve`. Bundle-only formats
 *    (`git` / `json`) do not apply to pre-rendered trees.
 *
 * Exactly one of {@link CanonicalItem.bundle} / {@link CanonicalItem.tree} is present.
 */
export interface CanonicalItem {
  /** Reference identifying this item. */
  ref: ItemRef;
  /** claude.ai wire payload; mutually exclusive with {@link CanonicalItem.tree}. */
  bundle?: GitBundle;
  /** Full conversation, for incremental diff/changelog. */
  conversation?: Conversation;
  /** Associated artifacts, when fetched. */
  artifacts?: ArtifactListResponse;
  /** List-endpoint summary, for state tracking. */
  summary?: ConversationSummary;
  /** Pre-rendered `relPath -> content` tree; mutually exclusive with {@link CanonicalItem.bundle}. */
  tree?: TreePayload;
}

/**
 * What to select from a source.
 */
export interface Selector {
  /** Restrict a `claude://` source to a single conversation id. */
  conversationId?: string;
}

/**
 * Options controlling how a sink writes an item.
 */
export interface ApplyOpts {
  /** Output format the sink should materialize (e.g. `git`, `json`). */
  format: ExportFormat;
  /** Glob/path patterns left untouched when overwriting an existing target. */
  preserve?: readonly string[];
  /** Commit author name, for git-format output. */
  authorName?: string;
  /** Commit author email, for git-format output. */
  authorEmail?: string;
  /** Mirror source deletions. Phase 2 -- not yet honored. */
  delete?: boolean;
  /** Plan only, no writes. Phase 2 -- not yet honored. */
  dryRun?: boolean;
}

/**
 * Sink-side prior state. For the file sink this is the `.claudesync-state.json`.
 *
 * @see SyncState
 */
export type SinkState = SyncState;

/**
 * The outcome of a single {@link SinkSurface.write}.
 */
export interface ApplyResult {
  /** The item that was written. */
  ref: ItemRef;
  /**
   * What the sink did: a full write, an incremental update, a skip (unchanged),
   * or a skip because the target already existed.
   */
  action: "full" | "incremental" | "skipped" | "skipped-existing";
  /** Human-readable explanation, primarily for skips. */
  reason?: string;
  /** Whether a changelog entry was emitted. */
  changelogWritten: boolean;
  /** Name used in progress/log output. */
  displayName: string;
}

/**
 * A readable surface: enumerates items and builds their canonical form.
 *
 * @see Location
 */
export interface SourceSurface extends Location {
  /**
   * Enumerate items, optionally narrowed by `selector`.
   *
   * @param selector - Optional filter restricting which items are yielded.
   * @returns Lazily-produced references to each matching item.
   */
  list(selector?: Selector): AsyncIterable<ItemRef>;
  /**
   * Fetch and build the canonical item for `ref`.
   *
   * @param ref - Reference (typically from {@link SourceSurface.list}) to read.
   * @returns The neutral-interchange payload for the item.
   */
  read(ref: ItemRef): Promise<CanonicalItem>;
}

/**
 * A writable surface: materializes canonical items at an output location.
 *
 * @see Location
 */
export interface SinkSurface extends Location {
  /**
   * The output location this sink uses for `ref` (for display / nesting).
   *
   * @param ref - Item whose target path is requested.
   * @returns The relative/absolute path the item would be written to.
   */
  pathFor(ref: ItemRef): string;
  /**
   * Whether the sink's materialized target for `ref` already exists. Format-aware:
   * the `<slug>.json` file in json mode, the directory otherwise.
   *
   * @param ref - Item to check.
   * @returns `true` if a prior materialization is present.
   */
  exists(ref: ItemRef): Promise<boolean>;
  /**
   * Prior persisted state for `ref`.
   *
   * @param ref - Item to look up.
   * @returns The stored state, or `null` when nothing has been written yet.
   */
  stat(ref: ItemRef): Promise<SinkState | null>;
  /**
   * Persist `item`.
   *
   * @param item - The canonical payload to write.
   * @param opts - Format and write options.
   * @param prevState - State from a prior {@link SinkSurface.stat} (avoids a double read).
   * @returns The outcome of the write.
   */
  write(
    item: CanonicalItem,
    opts: ApplyOpts,
    prevState: SinkState | null
  ): Promise<ApplyResult>;
}
