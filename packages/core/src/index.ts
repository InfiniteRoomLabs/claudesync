/**
 * Public API barrel for `@infinite-room-labs/claudesync-core`, the SDK that wraps
 * the undocumented claude.ai web API and the local agent-session caches.
 *
 * Everything a consumer (the MCP server, CLI, or extension) is meant to use is
 * re-exported here; importing from deep module paths is not supported. The
 * surface is grouped into:
 *
 * - Auth -- session-cookie providers ({@link EnvAuth}, {@link FirefoxProfileAuth}).
 * - Client -- the {@link ClaudeSyncClient} HTTP layer, endpoints, and errors.
 * - Models -- Zod schemas and their inferred types for every API response.
 * - Tree -- {@link buildMessageTree} and helpers for the branching message tree.
 * - Export -- rendering conversations into git bundles and Markdown.
 * - Sync -- incremental state, diffing, changelogs, and the org-wide scheduler.
 * - Concurrency -- rate limiting, adaptive backpressure, and the worker pool.
 * - Surface -- the source/sink seam plus the `cc://`, datastore, and Class-D
 *   adapters (aider, gemini-cli, opencode) for local agent transcripts.
 *
 * @packageDocumentation
 */

// Auth -- session-cookie providers and the auth error type
export type { AuthProvider } from "./auth/types.js";
export { EnvAuth } from "./auth/env.js";
export { FirefoxProfileAuth } from "./auth/firefox.js";
export { AuthError } from "./auth/errors.js";

// Client -- the claude.ai HTTP client, its options, errors, and endpoint helpers
export { ClaudeSyncClient } from "./client/client.js";
export type { ClientOptions, PutProjectMemoryControlsOptions } from "./client/client.js";
export { ClaudeSyncError, RateLimitError } from "./client/errors.js";
export { ENDPOINTS, buildUrl } from "./client/endpoints.js";

// Models -- Zod schemas validating each claude.ai API response shape
export {
  AccountSchema,
  OrganizationSchema,
  ConversationSettingsSchema,
  AttachmentSchema,
  ChatMessageSchema,
  ConversationSummarySchema,
  ConversationSchema,
  SearchChunkSchema,
  SearchResponseSchema,
  ArtifactFileMetadataSchema,
  ArtifactListResponseSchema,
  ProjectSchema,
  ProjectDocSchema,
  ProjectMemorySchema,
} from "./models/schemas.js";

// Models -- Types inferred from the schemas above
export type {
  Account,
  Organization,
  ConversationSettings,
  Attachment,
  ChatMessage,
  ConversationSummary,
  Conversation,
  SearchChunk,
  SearchResponse,
  ArtifactFileMetadata,
  ArtifactListResponse,
  Project,
  ProjectDoc,
  ProjectMemory,
} from "./models/types.js";

// Tree utilities -- build and traverse the branching message tree
export type { MessageTreeNode } from "./tree/message-tree.js";
export {
  buildMessageTree,
  findLeafMessages,
  getLinearBranch,
  getAllBranches,
  findDivergencePoint,
  shortLeafLabel,
} from "./tree/message-tree.js";

// Export engine -- render conversations into git bundles and Markdown
export type { GitBundle, GitBundleCommit } from "./export/types.js";
export type { BuildGitBundleOptions } from "./export/bundle-builder.js";
export { buildGitBundle } from "./export/bundle-builder.js";
export { exportToGit, appendToGit } from "./export/git-exporter.js";
export { formatConversation } from "./export/conversation-formatter.js";

// Sync engine -- persisted sync state, conversation diffing, and changelogs
export type {
  SyncState,
  SyncStateLeaf,
  SyncStateArtifact,
} from "./sync/state.js";
export {
  STATE_FILENAME,
  SyncStateSchema,
  readSyncState,
  writeSyncState,
} from "./sync/state.js";
export type {
  ConversationDiff,
  BranchDiff,
  ArtifactDiff,
  MetadataDiff,
} from "./sync/diff.js";
export { diffConversation } from "./sync/diff.js";
export {
  CHANGELOG_FILENAME,
  renderChangelogSection,
  appendChangelog,
} from "./sync/changelog.js";
export type {
  ExportFormat,
  SyncConversationOptions,
  SyncConversationResult,
} from "./sync/incremental.js";
export {
  syncConversation,
  isSameByListMetadata,
} from "./sync/incremental.js";
export type {
  FetchAndBuildOptions,
  FetchAndBuildResult,
} from "./sync/fetch.js";
export { fetchAndBuild } from "./sync/fetch.js";
export type { ReplaceWithPreserveOptions } from "./sync/files-mode.js";
export { replaceWithPreserve, walkRelative, expandPreserveForProject } from "./sync/files-mode.js";
export type { OnBecameEmpty, EmptyAction } from "./sync/empty.js";
export { isEmptyConversation, summaryLooksEmpty, decideEmptyAction } from "./sync/empty.js";

// Concurrency / backpressure -- rate limiter, adaptive controller, worker pool
export type {
  RequestLimiter,
  Clock,
  AdaptiveControllerOptions,
  PoolTask,
  WorkerPoolOptions,
} from "./concurrency/index.js";
export {
  FixedGapLimiter,
  defaultSleep,
  defaultClock,
  AdaptiveController,
  MinPriorityQueue,
  WorkerPool,
} from "./concurrency/index.js";

// Concurrency config -- schema and loader for concurrency/backpressure settings
export type {
  ConcurrencyConfig,
  ConcurrencyFlags,
} from "./config/index.js";
export {
  ConcurrencyConfigSchema,
  CONFIG_FILENAME,
  loadConfigFile,
  resolveConcurrencyConfig,
} from "./config/index.js";

// Behavior config -- skip-empty-conversations and became-empty policy settings
export type { BehaviorConfig } from "./config/index.js";
export { BehaviorConfigSchema, resolveBehaviorConfig } from "./config/index.js";

// Parallel org sync -- whole-org scheduler and per-project bundle assembly
export type {
  ProgressEvent,
  RunOrgSyncOptions,
  RunOrgSyncResult,
} from "./sync/scheduler.js";
export { runOrgSync } from "./sync/scheduler.js";
export type { ProjectConvBuilt } from "./sync/project-sync.js";
export {
  assembleProjectBundle,
  writeProjectBundle,
  buildProjectReadme,
} from "./sync/project-sync.js";

// Memory -- pull engine for the project memory doc + edit-control mirror
export {
  pullProjectMemory,
  computePrincipalFingerprint,
} from "./memory/pull.js";
export type { MemoryPullOutcome } from "./memory/pull.js";
export type { PullProjectMemoryOptions } from "./memory/pull.js";
export { readMemoryState, writeMemoryState, MEMORY_STATE_FILENAME } from "./memory/state.js";
export type { MemoryState } from "./memory/state.js";
export { canonicalize, serializeEdits, parseEdits } from "./memory/edits.js";
export { hashContent } from "./memory/hash.js";
export {
  mergeProjectMemoryControls,
  assertNoDelimiterEntries,
} from "./memory/merge.js";
export type { ControlsMergeResult } from "./memory/merge.js";
export { withProjectMemoryLock, MEMORY_LOCK_FILENAME } from "./memory/lock.js";
export type { WithProjectMemoryLockOptions } from "./memory/lock.js";
export { planProjectMemoryPush, applyProjectMemoryPush } from "./memory/push.js";
export type {
  PlanProjectMemoryPushOptions,
  ProjectMemoryPushPlan,
  ApplyProjectMemoryPushOptions,
  ProjectMemoryPushOutcome,
} from "./memory/push.js";

// Naming helpers -- slugify titles into filesystem-safe names
export { slugify, safeSlug, displayName } from "./util/naming.js";

// Glob helpers -- compile and match glob patterns for path filtering
export { matchGlob, matchAnyGlob, compileGlob } from "./util/glob.js";

// Surface seam (PRD 001 Phase 0): addressable source/sink surfaces + URI grammar
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
  ClaudeSourceOptions,
  CcSourceOptions,
  FileSinkLayout,
  FileSinkOptions,
  SyncOptions,
  DatastoreAdapter,
  DatastoreSourceOptions,
  DatastoreFidelity,
  NormalizedBlock,
  NormalizedTurn,
  NormalizedSession,
  AdapterListItem,
  AiderSourceOptions,
  GeminiCliSourceOptions,
  OpencodeSourceOptions,
} from "./surface/index.js";
export {
  parseLocationUri,
  fileUri,
  ClaudeSource,
  CcSource,
  FileSink,
  sync,
  DatastoreSource,
  renderNormalized,
  AiderSource,
  GeminiCliSource,
  OpencodeSource,
} from "./surface/index.js";

// Claude Code (local session cache) source -- the `cc://` reader (PRD 001 Phase 1)
export type {
  CcLine,
  CcContentBlock,
  DiscoveredSession,
  ParsedSession,
} from "./claude-code/parse.js";
export {
  discoverSessions,
  parseSession,
  parseLines,
  summarize,
} from "./claude-code/parse.js";
export type {
  ClaudeCodeFidelity,
  RenderOptions,
  RenderedSession,
} from "./claude-code/render.js";
export { renderSession } from "./claude-code/render.js";
export type {
  PlannedSession,
  BuildSessionTreeOptions,
} from "./claude-code/build.js";
export { planSessions, buildSessionTree } from "./claude-code/build.js";
export type {
  RunClaudeCodeSyncOptions,
  RunClaudeCodeSyncResult,
  ClaudeCodeProgressEvent,
} from "./claude-code/sync.js";
export { runClaudeCodeSync } from "./claude-code/sync.js";
