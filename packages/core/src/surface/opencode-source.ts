/**
 * `opencode://` source surface (PRD 001 Phase 1.5). Reads opencode's SQLite
 * store (`~/.local/share/opencode/opencode.db`).
 */

import { OpencodeAdapter, defaultOpencodeDb } from "../opencode/adapter.js";
import { DatastoreSource, type DatastoreSourceOptions } from "./datastore.js";
import type { ParsedUri } from "./types.js";

export interface OpencodeSourceOptions extends DatastoreSourceOptions {
  /** Path to opencode.db. Default: ~/.local/share/opencode/opencode.db. */
  dbPath?: string;
}

export class OpencodeSource extends DatastoreSource {
  constructor(options: OpencodeSourceOptions = {}, uri?: ParsedUri) {
    super(new OpencodeAdapter(options.dbPath ?? defaultOpencodeDb()), options, uri);
  }

  static fromUri(uri: ParsedUri, options: OpencodeSourceOptions = {}): OpencodeSource {
    return new OpencodeSource({ ...options, dbPath: options.dbPath ?? uri.query.db }, uri);
  }
}
