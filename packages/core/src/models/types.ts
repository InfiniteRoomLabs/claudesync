import type { z } from "zod";
import type {
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
} from "./schemas.js";

/**
 * Wire types for the claude.ai web API, each inferred from its Zod schema in
 * {@link ./schemas.js} so the static type and the runtime validator never drift.
 * Edit the schema, not these aliases.
 */

/** Inferred type for {@link AccountSchema}. */
export type Account = z.infer<typeof AccountSchema>;
/** Inferred type for {@link OrganizationSchema}. */
export type Organization = z.infer<typeof OrganizationSchema>;
/** Inferred type for {@link ConversationSettingsSchema}. */
export type ConversationSettings = z.infer<typeof ConversationSettingsSchema>;
/** Inferred type for {@link AttachmentSchema}. */
export type Attachment = z.infer<typeof AttachmentSchema>;
/** Inferred type for {@link ChatMessageSchema}. */
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
/** Inferred type for {@link ConversationSummarySchema} (metadata, no messages). */
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
/** Inferred type for {@link ConversationSchema} (summary plus message tree). */
export type Conversation = z.infer<typeof ConversationSchema>;
/** Inferred type for {@link SearchChunkSchema}. */
export type SearchChunk = z.infer<typeof SearchChunkSchema>;
/** Inferred type for {@link SearchResponseSchema}. */
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
/** Inferred type for {@link ArtifactFileMetadataSchema}. */
export type ArtifactFileMetadata = z.infer<typeof ArtifactFileMetadataSchema>;
/** Inferred type for {@link ArtifactListResponseSchema}. */
export type ArtifactListResponse = z.infer<typeof ArtifactListResponseSchema>;
/** Inferred type for {@link ProjectSchema}. */
export type Project = z.infer<typeof ProjectSchema>;
/** Inferred type for {@link ProjectDocSchema}. */
export type ProjectDoc = z.infer<typeof ProjectDocSchema>;
/** A project's memory doc + edit-control list. Inferred from {@link ProjectMemorySchema}. */
export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;
