/**
 * `aider://` source surface (PRD 001 Phase 1.5). Reads a repo's
 * `.aider.chat.history.md`. Unlike the other Class-D sources there is no global
 * store, so a repo path is required (URI path, or the `path` option).
 */

import { AiderAdapter } from "../aider/adapter.js";
import { DatastoreSource, type DatastoreSourceOptions } from "./datastore.js";
import type { ParsedUri } from "./types.js";

/**
 * Construction options for {@link AiderSource}. Extends the shared
 * {@link DatastoreSourceOptions} (fidelity / truncation) with the one piece of
 * state aider needs that the global-store sources do not: a repo path, since
 * aider writes its history per-repo rather than to a single global location.
 */
export interface AiderSourceOptions extends DatastoreSourceOptions {
  /** Repo directory (or the `.aider.chat.history.md` file itself) to read. */
  path: string;
}

/**
 * `aider://` {@link SourceSurface}: a thin {@link DatastoreSource} over an
 * {@link AiderAdapter}, which parses a repo's `.aider.chat.history.md` into the
 * shared normalized model. Unlike {@link GeminiCliSource} / {@link OpencodeSource}
 * there is no global store, so a repo path is always required.
 */
export class AiderSource extends DatastoreSource {
  /**
   * @param options - Repo path plus shared rendering options.
   * @param uri - Endpoint to advertise; defaults to `aider://local/`.
   */
  constructor(options: AiderSourceOptions, uri?: ParsedUri) {
    super(new AiderAdapter(options.path), options, uri);
  }

  /**
   * Build an {@link AiderSource} from a parsed `aider://` URI. The repo path is
   * taken from the explicit `path` option, else the URI path (when not the bare
   * root `/`), else the current working directory.
   *
   * @param uri - Parsed `aider://[path]` endpoint.
   * @param options - Optional overrides; `path` here wins over the URI path.
   * @returns The configured source.
   */
  static fromUri(uri: ParsedUri, options: Partial<AiderSourceOptions> = {}): AiderSource {
    const target =
      options.path ?? (uri.path && uri.path !== "/" ? uri.path : process.cwd());
    return new AiderSource({ ...options, path: target }, uri);
  }
}
