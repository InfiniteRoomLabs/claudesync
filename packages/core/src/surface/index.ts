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
export {
  FileSink,
  type FileSinkLayout,
  type FileSinkOptions,
} from "./file-sink.js";
export { sync, type SyncOptions } from "./orchestrator.js";
