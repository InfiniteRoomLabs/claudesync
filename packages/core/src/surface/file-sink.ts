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
import { readSyncState } from "../sync/state.js";
import { writeTreeWithPreserve } from "../sync/tree.js";
import { materializeConversation, type ExportFormat } from "../sync/materialize.js";
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
   * Materialize `item` under {@link pathFor}. A pre-rendered `item.tree`
   * (`cc://` and other Class-D sources) is written verbatim via
   * `writeTreeWithPreserve`; otherwise the claude.ai bundle path runs through
   * `materializeConversation`, honoring `prevState` for incremental diffing.
   *
   * @param item - The canonical payload to write; must carry either a `tree` or a full bundle.
   * @param opts - Write options; `preserve` patterns are passed through to the writer.
   * @param prevState - Prior state from {@link stat}, or `null` for a fresh sync.
   * @returns The outcome of the write.
   * @throws If `item` carries neither a pre-rendered tree nor a complete bundle.
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
}
