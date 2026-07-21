/**
 * `file://` sink surface -- the local filesystem expressed as a
 * {@link SinkSurface}. `write` delegates to `materializeConversation` (the same
 * code path `syncConversation` uses), so output is byte-identical to the legacy
 * exporters. `stat` reads the `.claudesync-state.json` sidecar.
 *
 * `format` is a property of the sink (PRD: `file://...?format=git`), so it lives
 * here rather than per-write.
 */

import fs from "node:fs";
import path from "node:path";
import { readSyncState, writeSyncState } from "../sync/state.js";
import { writeTreeWithPreserve } from "../sync/tree.js";
import { materializeConversation, type ExportFormat } from "../sync/materialize.js";
import { cleanEmptyConversation, NO_ARTIFACTS } from "../sync/incremental.js";
import { buildGitBundle } from "../export/bundle-builder.js";
import { safeSlug, displayName as toDisplayName } from "../util/naming.js";
import type {
  ApplyOpts,
  ApplyResult,
  CanonicalItem,
  ItemRef,
  ParsedUri,
  SinkState,
  SinkSurface,
  SurfaceCaps,
} from "./types.js";

/**
 * - "direct": `pathFor(ref)` is `basePath` itself (single-item, e.g. `export`,
 *   where `--output` is the conversation's own directory).
 * - "nested": `pathFor(ref)` is `basePath/<slug>` (multi-item; for the future
 *   `export-all` migration).
 */
export type FileSinkLayout = "direct" | "nested";

/** Construction options for {@link FileSink.fromUri}. */
export interface FileSinkOptions {
  /** Output layout; see {@link FileSinkLayout}. Defaults to `"direct"`. */
  layout?: FileSinkLayout;
}

/**
 * `file://` {@link SinkSurface}: the local filesystem as a write target. Writes
 * delegate to `materializeConversation` (the same path `syncConversation` uses)
 * so output is byte-identical to the legacy exporters, except for pre-rendered
 * trees (`cc://` et al.) which are written verbatim. Read-only operations are
 * unsupported -- this is a write/stat sink only.
 */
export class FileSink implements SinkSurface {
  /** This sink's endpoint, e.g. `file:///path?format=git`. */
  readonly uri: ParsedUri;

  /** Write-only: this surface persists items but never reads, lists, or deletes. */
  readonly caps: SurfaceCaps = {
    read: false,
    write: true,
    delete: false,
    list: false,
  };

  /**
   * @param basePath - Root output directory.
   * @param format - Materialization format (`files`, `git`, `json`); also the sink's `?format=` query.
   * @param layout - How {@link pathFor} maps refs to paths; see {@link FileSinkLayout}.
   * @param uri - Endpoint to advertise; synthesized from `basePath`/`format` when omitted.
   */
  constructor(
    private readonly basePath: string,
    private readonly format: ExportFormat,
    private readonly layout: FileSinkLayout = "direct",
    uri?: ParsedUri
  ) {
    this.uri = uri ?? { scheme: "file", path: basePath, query: { format } };
  }

  /**
   * Build a {@link FileSink} from a parsed `file://` URI. Format comes from the
   * `?format=` query (defaulting to `files`); the base path is the URI path.
   *
   * @param uri - Parsed `file://<path>[?format=...]` endpoint.
   * @param options - Layout override; defaults to `"direct"`.
   * @returns The configured sink.
   */
  static fromUri(uri: ParsedUri, options: FileSinkOptions = {}): FileSink {
    const format = (uri.query.format as ExportFormat) || "files";
    return new FileSink(uri.path, format, options.layout ?? "direct", uri);
  }

  /**
   * Resolve the output directory for `ref`. A source-computed `ref.relPath`
   * (e.g. `cc://`'s `claude-code/<proj>/<session>`) wins; otherwise `direct`
   * layout uses `basePath` itself and `nested` appends a per-item slug.
   *
   * @param ref - Item whose target directory is requested.
   * @returns The absolute output directory.
   */
  pathFor(ref: ItemRef): string {
    // A source-computed relpath (e.g. cc://'s `claude-code/<proj>/<session>`)
    // wins over the sink's own slugging.
    if (ref.relPath) return path.join(this.basePath, ref.relPath);
    return this.layout === "direct"
      ? this.basePath
      : path.join(this.basePath, safeSlug(ref.name, ref.id));
  }

  /** Where the materialized output lands: a `<path>.json` file in json mode, else {@link pathFor}. */
  private targetPath(ref: ItemRef): string {
    const p = this.pathFor(ref);
    return this.format === "json" ? `${p}.json` : p;
  }

  /** Directory holding the `.claudesync-state.json` sidecar (json keeps it in the parent dir). */
  private stateDir(ref: ItemRef): string {
    const p = this.pathFor(ref);
    return this.format === "json" ? path.dirname(p) : p;
  }

  /**
   * Whether a prior materialization of `ref` is already on disk.
   *
   * @param ref - Item to check.
   * @returns `true` if {@link targetPath} exists.
   */
  async exists(ref: ItemRef): Promise<boolean> {
    return fs.existsSync(this.targetPath(ref));
  }

  /**
   * Read the prior sync state sidecar for `ref`. A corrupted or unreadable
   * sidecar is treated as absent (fresh sync), matching `syncConversation`.
   *
   * @param ref - Item to look up.
   * @returns The stored state, or `null` when nothing has been written yet.
   */
  async stat(ref: ItemRef): Promise<SinkState | null> {
    const dir = this.stateDir(ref);
    if (!fs.existsSync(dir)) return null;
    try {
      return readSyncState(dir) ?? null;
    } catch {
      // Corrupted state -> treat as fresh (matches syncConversation).
      return null;
    }
  }

  /**
   * Whether `ref`'s output directory carries a parseable
   * `.claudesync-state.json` sidecar -- i.e. whether this sink actually wrote
   * `ref` before, as distinct from {@link exists}'s mere path-existence
   * check. Resolves the same directory {@link stat} reads
   * ({@link stateDir}), and treats an absent or unparseable sidecar
   * identically (both resolve `false`): this is the closed near-miss where a
   * directory existing at the target path (e.g. an entire export archive
   * root pointed at by mistake) was previously enough to make the
   * became-empty `"clean"` policy engage on it.
   *
   * @param ref - Item to check.
   * @returns `true` iff {@link stateDir}'s sidecar exists and parses.
   */
  async hasPriorState(ref: ItemRef): Promise<boolean> {
    try {
      return readSyncState(this.stateDir(ref)) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Materialize `item` under {@link pathFor}. A pre-rendered `item.tree`
   * (`cc://` and other Class-D sources) is written verbatim via
   * `writeTreeWithPreserve`; an `item.isEmpty` item is handled by
   * {@link writeEmpty}; otherwise the claude.ai bundle path runs through
   * `materializeConversation`, honoring `prevState` for incremental diffing.
   *
   * @param item - The canonical payload to write; must carry a `tree`, a full
   * bundle, or (`isEmpty: true`) a `conversation` + `summary`.
   * @param opts - Write options; `preserve` patterns are passed through to the writer.
   * @param prevState - Prior state from {@link stat}, or `null` for a fresh sync.
   * @returns The outcome of the write.
   * @throws If `item` carries none of a pre-rendered tree, a complete bundle,
   * or the `isEmpty` conversation/summary pair.
   */
  async write(
    item: CanonicalItem,
    opts: ApplyOpts,
    prevState: SinkState | null
  ): Promise<ApplyResult> {
    // Pre-rendered tree (cc:// and other Class D sources): write verbatim.
    if (item.tree) {
      await writeTreeWithPreserve(this.pathFor(item.ref), item.tree, opts.preserve ?? []);
      return {
        ref: item.ref,
        action: "full",
        changelogWritten: false,
        displayName: toDisplayName(item.ref.name, item.ref.id),
      };
    }

    if (item.isEmpty) {
      return this.writeEmpty(item, opts, prevState);
    }

    if (!item.bundle || !item.conversation || !item.artifacts || !item.summary) {
      throw new Error("FileSink.write: CanonicalItem must carry either a bundle or a tree");
    }

    const res = await materializeConversation({
      bundle: item.bundle,
      conversation: item.conversation,
      artifacts: item.artifacts,
      summary: item.summary,
      prevState: prevState ?? undefined,
      outputPath: this.pathFor(item.ref),
      format: this.format,
      preserve: opts.preserve ?? [],
    });
    return {
      ref: item.ref,
      action: res.action,
      changelogWritten: res.changelogWritten,
      displayName: toDisplayName(item.summary.name, item.summary.uuid),
    };
  }

  /**
   * Handles an `item.isEmpty` canonical item: either the became-empty
   * `"clean"` directive ({@link ApplyOpts.cleanEmpty}) or a forced full
   * materialization of an empty snapshot (the orchestrator's
   * `"materialize-full"` outcome, signaled by `prevState: null`). Mirrors
   * `syncConversation`'s `handleBecameEmpty` (`packages/core/src/sync/incremental.ts`)
   * -- reusing its `cleanEmptyConversation`/`NO_ARTIFACTS` helpers -- so a
   * became-empty item lands on disk identically whether it flows through the
   * legacy path or the surface seam.
   *
   * @param item - Canonical item with `isEmpty: true`; must carry `conversation`
   * and `summary` (no `bundle`/`artifacts` -- the source short-circuited before
   * building them).
   * @param opts - Write options; `cleanEmpty` selects the clean directive.
   * @param prevState - Prior state; ignored (treated as absent) for the clean
   * directive, and expected to be `null` from the orchestrator for the
   * forced-full path so `materializeConversation` treats this as an initial
   * diff (mirrors Task 3's `prevState: undefined`).
   * @returns `"cleaned-empty"` for the clean directive, otherwise the normal
   * `materializeConversation` action (`"full"` when `prevState` is `null`).
   * @throws If `item` lacks the `conversation`/`summary` an empty item must carry.
   */
  private async writeEmpty(
    item: CanonicalItem,
    opts: ApplyOpts,
    prevState: SinkState | null
  ): Promise<ApplyResult> {
    if (!item.conversation || !item.summary) {
      throw new Error(
        "FileSink.write: an isEmpty CanonicalItem must carry conversation and summary"
      );
    }
    const { conversation, summary } = item;
    const outputPath = this.pathFor(item.ref);
    const displayLabel = toDisplayName(summary.name, summary.uuid);

    if (opts.cleanEmpty) {
      await cleanEmptyConversation(outputPath, this.format, opts.preserve ?? []);
      const state: SinkState = {
        schema_version: 1,
        conversation_uuid: conversation.uuid,
        conversation_name: conversation.name,
        model: conversation.model ?? null,
        updated_at: summary.updated_at,
        current_leaf_message_uuid: conversation.current_leaf_message_uuid ?? null,
        leaves: [],
        artifacts: [],
        last_sync_at: new Date().toISOString(),
        last_sync_action: "cleaned-empty",
      };
      writeSyncState(this.stateDir(item.ref), state);
      return {
        ref: item.ref,
        action: "cleaned-empty",
        changelogWritten: false,
        displayName: displayLabel,
      };
    }

    const bundle = buildGitBundle(conversation, NO_ARTIFACTS, new Map(), {
      authorName: opts.authorName,
      authorEmail: opts.authorEmail,
      multiBranch: true,
    });
    const res = await materializeConversation({
      bundle,
      conversation,
      artifacts: NO_ARTIFACTS,
      summary,
      prevState: prevState ?? undefined,
      outputPath,
      format: this.format,
      preserve: opts.preserve ?? [],
    });
    return {
      ref: item.ref,
      action: res.action,
      changelogWritten: res.changelogWritten,
      displayName: displayLabel,
    };
  }
}
