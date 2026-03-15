import { z } from "zod";

export const OrganizationSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    capabilities: z.array(z.string()).default([]),
    active_flags: z.array(z.string()).default([]),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

// ConversationSettings uses .passthrough() because field names are
// unstable codenames (bananagrams, sourdough, foccacia) that Anthropic
// changes without notice. Only stable fields are typed explicitly.
export const ConversationSettingsSchema = z
  .object({
    enabled_web_search: z.boolean().nullable().optional(),
    enabled_mcp_tools: z.record(z.string(), z.boolean()).nullable().optional(),
  })
  .passthrough();

export const AttachmentSchema = z
  .object({
    file_name: z.string(),
    file_size: z.union([z.string(), z.number()]),
    file_type: z.string(),
  })
  .passthrough();

export const ChatMessageSchema = z
  .object({
    uuid: z.string(),
    text: z.string(),
    sender: z.enum(["human", "assistant"]),
    index: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
    parent_message_uuid: z.string(),
    attachments: z.array(AttachmentSchema).default([]),
    files_v2: z.array(z.unknown()).default([]),
    sync_sources: z.array(z.unknown()).default([]),
    truncated: z.boolean().optional(),
    stop_reason: z.string().optional(),
    input_mode: z.string().optional(),
  })
  .passthrough();

export const ConversationSummarySchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    model: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    current_leaf_message_uuid: z.string().nullable(),
    settings: ConversationSettingsSchema.optional(),
    is_starred: z.boolean().optional(),
    is_temporary: z.boolean().optional(),
    project_uuid: z.string().nullable().optional(),
    summary: z.string().optional(),
  })
  .passthrough();

export const ConversationSchema = ConversationSummarySchema.extend({
  chat_messages: z.array(ChatMessageSchema),
}).passthrough();

export const SearchChunkSchema = z
  .object({
    doc_uuid: z.string(),
    start: z.number(),
    end: z.number(),
    name: z.string(),
    text: z.string(),
    extras: z
      .object({
        conversation_uuid: z.string(),
        conversation_title: z.string().optional(),
        doc_type: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const SearchResponseSchema = z.object({
  chunks: z.array(SearchChunkSchema),
});

export const ArtifactFileMetadataSchema = z
  .object({
    path: z.string(),
    size: z.number(),
    content_type: z.string(),
    created_at: z.string(),
    custom_metadata: z
      .object({
        filename: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export const ArtifactListResponseSchema = z.object({
  success: z.boolean(),
  files: z.array(z.string()),
  files_metadata: z.array(ArtifactFileMetadataSchema),
});

export const ProjectSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    description: z.string().optional(),
    is_private: z.boolean().optional(),
    docs_count: z.number().nullable().optional(),
    files_count: z.number().nullable().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const ProjectDocSchema = z
  .object({
    uuid: z.string(),
    file_name: z.string(),
    content: z.string(),
  })
  .passthrough();
