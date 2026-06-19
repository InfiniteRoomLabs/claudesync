/**
 * `gemini-cli://` source surface (PRD 001 Phase 1.5). Reads the Gemini CLI
 * session cache (`~/.gemini/tmp/<id>/chats/*.jsonl`).
 */

import { GeminiCliAdapter, defaultGeminiHome } from "../gemini-cli/adapter.js";
import { DatastoreSource, type DatastoreSourceOptions } from "./datastore.js";
import type { ParsedUri } from "./types.js";

export interface GeminiCliSourceOptions extends DatastoreSourceOptions {
  /** Gemini home (the `tmp` dir). Default: ~/.gemini/tmp. */
  home?: string;
}

export class GeminiCliSource extends DatastoreSource {
  constructor(options: GeminiCliSourceOptions = {}, uri?: ParsedUri) {
    super(new GeminiCliAdapter(options.home ?? defaultGeminiHome()), options, uri);
  }

  static fromUri(uri: ParsedUri, options: GeminiCliSourceOptions = {}): GeminiCliSource {
    return new GeminiCliSource({ ...options, home: options.home ?? uri.query.home }, uri);
  }
}
