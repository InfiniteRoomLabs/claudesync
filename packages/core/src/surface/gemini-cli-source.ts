/**
 * `gemini-cli://` source surface (PRD 001 Phase 1.5). Reads the Gemini CLI
 * session cache (`~/.gemini/tmp/<id>/chats/*.jsonl`).
 */

import { GeminiCliAdapter, defaultGeminiHome } from "../gemini-cli/adapter.js";
import { DatastoreSource, type DatastoreSourceOptions } from "./datastore.js";
import type { ParsedUri } from "./types.js";

/**
 * Construction options for {@link GeminiCliSource}. Extends the shared
 * {@link DatastoreSourceOptions} (fidelity / truncation) with an optional
 * override of the Gemini CLI store location.
 */
export interface GeminiCliSourceOptions extends DatastoreSourceOptions {
  /** Gemini home (the `tmp` dir holding session caches). Defaults to {@link defaultGeminiHome} (`~/.gemini/tmp`). */
  home?: string;
}

/**
 * `gemini-cli://` {@link SourceSurface}: a thin {@link DatastoreSource} over a
 * {@link GeminiCliAdapter}, which parses the Gemini CLI session cache
 * (`~/.gemini/tmp/<id>/chats/*.jsonl`) into the shared normalized model.
 */
export class GeminiCliSource extends DatastoreSource {
  /**
   * @param options - Optional store-location override plus shared rendering options.
   * @param uri - Endpoint to advertise; defaults to `gemini-cli://local/`.
   */
  constructor(options: GeminiCliSourceOptions = {}, uri?: ParsedUri) {
    super(new GeminiCliAdapter(options.home ?? defaultGeminiHome()), options, uri);
  }

  /**
   * Build a {@link GeminiCliSource} from a parsed `gemini-cli://` URI. The store
   * location comes from the explicit `home` option, else the `?home=` query
   * parameter, else the default home.
   *
   * @param uri - Parsed `gemini-cli://[?home=...]` endpoint.
   * @param options - Optional overrides; `home` here wins over the query param.
   * @returns The configured source.
   */
  static fromUri(uri: ParsedUri, options: GeminiCliSourceOptions = {}): GeminiCliSource {
    return new GeminiCliSource({ ...options, home: options.home ?? uri.query.home }, uri);
  }
}
