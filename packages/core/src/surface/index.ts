/**
 * Public barrel for the surface seam (PRD 001). Re-exports the seam contract
 * ({@link SourceSurface} / {@link SinkSurface} and their value types), the URI
 * parser, every concrete source/sink, and the fan-out {@link sync} orchestrator.
 * Each symbol is documented at its definition; this file only groups them.
 */

// Seam contract: the addressable interfaces and their interchange types.
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
// Location-string parsing.
export { parseLocationUri, fileUri } from "./uri.js";
// Concrete source surfaces.
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
// Concrete sink surface.
export {
  FileSink,
  type FileSinkLayout,
  type FileSinkOptions,
} from "./file-sink.js";
// Fan-out orchestrator: one source -> N sinks.
export { sync, type SyncOptions } from "./orchestrator.js";
