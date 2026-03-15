import type { z } from "zod";
import type {
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
} from "./schemas.js";

export type Organization = z.infer<typeof OrganizationSchema>;
export type ConversationSettings = z.infer<typeof ConversationSettingsSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type SearchChunk = z.infer<typeof SearchChunkSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type ArtifactFileMetadata = z.infer<typeof ArtifactFileMetadataSchema>;
export type ArtifactListResponse = z.infer<typeof ArtifactListResponseSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectDoc = z.infer<typeof ProjectDocSchema>;
