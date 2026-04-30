// Auth
export type { AuthProvider } from "./auth/types.js";
export { EnvAuth } from "./auth/env.js";
export { FirefoxProfileAuth } from "./auth/firefox.js";
export { AuthError } from "./auth/errors.js";

// Client
export { ClaudeSyncClient } from "./client/client.js";
export type { ClientOptions } from "./client/client.js";
export { ClaudeSyncError, RateLimitError } from "./client/errors.js";
export { ENDPOINTS, buildUrl } from "./client/endpoints.js";

// Models -- Schemas
export {
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
} from "./models/schemas.js";

// Models -- Types
export type {
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
} from "./models/types.js";

// Tree utilities
export type { MessageTreeNode } from "./tree/message-tree.js";
export {
  buildMessageTree,
  findLeafMessages,
  getLinearBranch,
  getAllBranches,
  findDivergencePoint,
  shortLeafLabel,
} from "./tree/message-tree.js";

// Export engine
export type { GitBundle, GitBundleCommit } from "./export/types.js";
export type { BuildGitBundleOptions } from "./export/bundle-builder.js";
export { buildGitBundle } from "./export/bundle-builder.js";
export { exportToGit, appendToGit } from "./export/git-exporter.js";
export { formatConversation } from "./export/conversation-formatter.js";

// Sync engine
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

// Naming helpers
export { slugify, safeSlug, displayName } from "./util/naming.js";
