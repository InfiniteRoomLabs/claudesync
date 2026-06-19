/**
 * `aider://` source surface (PRD 001 Phase 1.5). Reads a repo's
 * `.aider.chat.history.md`. Unlike the other Class-D sources there is no global
 * store, so a repo path is required (URI path, or the `path` option).
 */

import { AiderAdapter } from "../aider/adapter.js";
import { DatastoreSource, type DatastoreSourceOptions } from "./datastore.js";
import type { ParsedUri } from "./types.js";

export interface AiderSourceOptions extends DatastoreSourceOptions {
  /** Repo directory (or the .aider.chat.history.md file) to read. */
  path: string;
}

export class AiderSource extends DatastoreSource {
  constructor(options: AiderSourceOptions, uri?: ParsedUri) {
    super(new AiderAdapter(options.path), options, uri);
  }

  static fromUri(uri: ParsedUri, options: Partial<AiderSourceOptions> = {}): AiderSource {
    const target =
      options.path ?? (uri.path && uri.path !== "/" ? uri.path : process.cwd());
    return new AiderSource({ ...options, path: target }, uri);
  }
}
