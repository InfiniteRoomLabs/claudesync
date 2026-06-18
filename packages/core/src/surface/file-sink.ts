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

export interface FileSinkOptions {
  layout?: FileSinkLayout;
}

export class FileSink implements SinkSurface {
  readonly uri: ParsedUri;
  readonly caps: SurfaceCaps = {
    read: false,
    write: true,
    delete: false,
    list: false,
  };

  constructor(
    private readonly basePath: string,
    private readonly format: ExportFormat,
    private readonly layout: FileSinkLayout = "direct",
    uri?: ParsedUri
  ) {
    this.uri = uri ?? { scheme: "file", path: basePath, query: { format } };
  }

  static fromUri(uri: ParsedUri, options: FileSinkOptions = {}): FileSink {
    const format = (uri.query.format as ExportFormat) || "files";
    return new FileSink(uri.path, format, options.layout ?? "direct", uri);
  }

  pathFor(ref: ItemRef): string {
    return this.layout === "direct"
      ? this.basePath
      : path.join(this.basePath, safeSlug(ref.name, ref.id));
  }

  /** Where the materialized output lands (json writes a `<path>.json` file). */
  private targetPath(ref: ItemRef): string {
    const p = this.pathFor(ref);
    return this.format === "json" ? `${p}.json` : p;
  }

  /** Where the state sidecar lives (json keeps it in the parent dir). */
  private stateDir(ref: ItemRef): string {
    const p = this.pathFor(ref);
    return this.format === "json" ? path.dirname(p) : p;
  }

  async exists(ref: ItemRef): Promise<boolean> {
    return fs.existsSync(this.targetPath(ref));
  }

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

  async write(
    item: CanonicalItem,
    opts: ApplyOpts,
    prevState: SinkState | null
  ): Promise<ApplyResult> {
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
