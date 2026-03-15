// Auth
export type { AuthProvider } from "./auth/types.js";
export { EnvAuth } from "./auth/env.js";
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
} from "./tree/message-tree.js";

// Export engine
export type { GitBundle, GitBundleCommit } from "./export/types.js";
export type { BuildGitBundleOptions } from "./export/bundle-builder.js";
export { buildGitBundle } from "./export/bundle-builder.js";
export { exportToGit } from "./export/git-exporter.js";
export { formatConversation } from "./export/conversation-formatter.js";
