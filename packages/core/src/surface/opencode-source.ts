/**
 * `opencode://` source surface (PRD 001 Phase 1.5). Reads opencode's SQLite
 * store (`~/.local/share/opencode/opencode.db`).
 */

import { OpencodeAdapter, defaultOpencodeDb } from "../opencode/adapter.js";
import { DatastoreSource, type DatastoreSourceOptions } from "./datastore.js";
import type { ParsedUri } from "./types.js";

/**
 * Construction options for {@link OpencodeSource}. Extends the shared
 * {@link DatastoreSourceOptions} (fidelity / truncation) with an optional
 * override of the opencode SQLite database path.
 */
export interface OpencodeSourceOptions extends DatastoreSourceOptions {
  /** Path to `opencode.db`. Defaults to {@link defaultOpencodeDb} (`~/.local/share/opencode/opencode.db`). */
  dbPath?: string;
}

/**
 * `opencode://` {@link SourceSurface}: a thin {@link DatastoreSource} over an
 * {@link OpencodeAdapter}, which reads opencode's SQLite store
 * (`~/.local/share/opencode/opencode.db`) into the shared normalized model.
 */
export class OpencodeSource extends DatastoreSource {
  /**
   * @param options - Optional db-path override plus shared rendering options.
   * @param uri - Endpoint to advertise; defaults to `opencode://local/`.
   */
  constructor(options: OpencodeSourceOptions = {}, uri?: ParsedUri) {
    super(new OpencodeAdapter(options.dbPath ?? defaultOpencodeDb()), options, uri);
  }

  /**
   * Build an {@link OpencodeSource} from a parsed `opencode://` URI. The db path
   * comes from the explicit `dbPath` option, else the `?db=` query parameter,
   * else the default location.
   *
   * @param uri - Parsed `opencode://[?db=...]` endpoint.
   * @param options - Optional overrides; `dbPath` here wins over the query param.
   * @returns The configured source.
   */
  static fromUri(uri: ParsedUri, options: OpencodeSourceOptions = {}): OpencodeSource {
    return new OpencodeSource({ ...options, dbPath: options.dbPath ?? uri.query.db }, uri);
  }
}
