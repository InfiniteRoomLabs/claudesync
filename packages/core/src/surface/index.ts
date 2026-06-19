export type {
  ParsedUri,
  SurfaceCaps,
  Location,
  ItemKind,
  ItemRef,
  CanonicalItem,
  Selector,
  ApplyOpts,
  SinkState,
  ApplyResult,
  SourceSurface,
  SinkSurface,
} from "./types.js";
export { parseLocationUri, fileUri } from "./uri.js";
export { ClaudeSource, type ClaudeSourceOptions } from "./claude-source.js";
export { CcSource, type CcSourceOptions } from "./cc-source.js";
// Class-D local datastore sources (PRD 001 Phase 1.5)
export {
  DatastoreSource,
  renderNormalized,
  type DatastoreAdapter,
  type DatastoreSourceOptions,
  type DatastoreFidelity,
  type NormalizedBlock,
  type NormalizedTurn,
  type NormalizedSession,
  type AdapterListItem,
} from "./datastore.js";
export { AiderSource, type AiderSourceOptions } from "./aider-source.js";
export { GeminiCliSource, type GeminiCliSourceOptions } from "./gemini-cli-source.js";
export { OpencodeSource, type OpencodeSourceOptions } from "./opencode-source.js";
export {
  FileSink,
  type FileSinkLayout,
  type FileSinkOptions,
} from "./file-sink.js";
export { sync, type SyncOptions } from "./orchestrator.js";
