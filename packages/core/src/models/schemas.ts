import { z } from "zod";

/**
 * Validates an organization (workspace/team) record from the claude.ai web API.
 *
 * `capabilities` and `active_flags` default to empty arrays so callers can read
 * them unconditionally even when the API omits them. `.passthrough()` keeps any
 * unrecognized fields the API adds later rather than stripping them.
 */
export const OrganizationSchema = z
  .object({
    /** Stable organization identifier; the org segment of every API path. */
    uuid: z.string(),
    /** Human-facing organization name. */
    name: z.string(),
    /** Feature flags the org is entitled to (e.g. "chat", "api"). */
    capabilities: z.array(z.string()).default([]),
    /** Active rollout/experiment flags set on the org. */
    active_flags: z.array(z.string()).default([]),
    /** ISO-8601 creation timestamp. */
    created_at: z.string(),
    /** ISO-8601 last-modified timestamp. */
    updated_at: z.string(),
  })
  .passthrough();

/**
 * Validates the `settings` blob attached to a conversation.
 *
 * `.passthrough()` is load-bearing here: most fields are unstable internal
 * codenames (bananagrams, sourdough, foccacia) that Anthropic renames without
 * notice, so only the two stable, useful flags are typed explicitly and the
 * rest are preserved untyped.
 */
export const ConversationSettingsSchema = z
  .object({
    /** Whether web search was enabled for the conversation. */
    enabled_web_search: z.boolean().nullable().optional(),
    /** Map of MCP tool name -> enabled flag for the conversation. */
    enabled_mcp_tools: z.record(z.string(), z.boolean()).nullable().optional(),
  })
  .passthrough();

/**
 * Validates a file attached to a chat message. `file_size` is a union because
 * the API has been observed returning it as both a string and a number.
 */
export const AttachmentSchema = z
  .object({
    /** Original filename of the attachment. */
    file_name: z.string(),
    /** Byte size; the API is inconsistent and may send a string or a number. */
    file_size: z.union([z.string(), z.number()]),
    /** MIME type or API-specific type label. */
    file_type: z.string(),
  })
  .passthrough();

/**
 * Validates a single message within a conversation.
 *
 * Messages form a tree rather than a flat list: {@link ChatMessageSchema}'s
 * `parent_message_uuid` links each message to its parent, and a conversation's
 * `current_leaf_message_uuid` marks the active branch tip. `parent_message_uuid`
 * defaults to "" (the root has no parent).
 */
export const ChatMessageSchema = z
  .object({
    /** Stable message identifier. */
    uuid: z.string(),
    /** Rendered message text. */
    text: z.string(),
    /** Who authored the message. */
    sender: z.enum(["human", "assistant"]),
    /** Ordinal position assigned by the API within the conversation. */
    index: z.number(),
    /** ISO-8601 creation timestamp. */
    created_at: z.string(),
    /** ISO-8601 last-modified timestamp. */
    updated_at: z.string(),
    /** Parent message in the tree; "" for the root message. */
    parent_message_uuid: z.string().optional().default(""),
    /** User-uploaded attachments on this message. */
    attachments: z.array(AttachmentSchema).default([]),
    /** Newer attachment payloads; shape varies, kept untyped. */
    files_v2: z.array(z.unknown()).default([]),
    /** External sync source records; shape varies, kept untyped. */
    sync_sources: z.array(z.unknown()).default([]),
    /** True when the message text was truncated by the API. */
    truncated: z.boolean().optional(),
    /** Reason generation stopped (e.g. "stop_sequence", "max_tokens"). */
    stop_reason: z.string().optional(),
    /** Input mode codename for the turn. */
    input_mode: z.string().optional(),
  })
  .passthrough();

/**
 * Validates a conversation's metadata WITHOUT its messages -- the shape returned
 * by list endpoints. {@link ConversationSchema} extends this with the full
 * message array. `model` defaults to null because older conversations omit it.
 */
export const ConversationSummarySchema = z
  .object({
    /** Stable conversation identifier. */
    uuid: z.string(),
    /** Conversation title. */
    name: z.string(),
    /** Model that produced the conversation; null when unknown/legacy. */
    model: z.string().nullable().optional().default(null),
    /** ISO-8601 creation timestamp. */
    created_at: z.string(),
    /** ISO-8601 last-modified timestamp. */
    updated_at: z.string(),
    /** UUID of the active branch tip; the leaf of the message tree to render. */
    current_leaf_message_uuid: z.string().nullable().optional(),
    /** Per-conversation settings blob. */
    settings: ConversationSettingsSchema.optional(),
    /** Whether the user starred the conversation. */
    is_starred: z.boolean().optional(),
    /** Whether this is an ephemeral/temporary conversation. */
    is_temporary: z.boolean().optional(),
    /** Owning project UUID, or null when not filed under a project. */
    project_uuid: z.string().nullable().optional(),
    /** API-generated summary text, when present. */
    summary: z.string().optional(),
  })
  .passthrough();

/**
 * Validates a fully-hydrated conversation: the summary fields plus the complete
 * `chat_messages` tree. Returned by the single-conversation GET endpoint.
 */
export const ConversationSchema = ConversationSummarySchema.extend({
  /** All messages in the conversation, linked into a tree via parent UUIDs. */
  chat_messages: z.array(ChatMessageSchema),
}).passthrough();

/**
 * Validates one hit from the conversation search endpoint. A chunk is a slice of
 * a source document with byte offsets and the conversation it belongs to.
 */
export const SearchChunkSchema = z
  .object({
    /** UUID of the source document the chunk came from. */
    doc_uuid: z.string(),
    /** Start byte offset of the chunk within the source document. */
    start: z.number(),
    /** End byte offset of the chunk within the source document. */
    end: z.number(),
    /** Display name of the source document. */
    name: z.string(),
    /** The matched text slice. */
    text: z.string(),
    /** Provenance fields needed to navigate back to the conversation. */
    extras: z
      .object({
        /** UUID of the conversation containing the match. */
        conversation_uuid: z.string(),
        /** Title of that conversation, when available. */
        conversation_title: z.string().optional(),
        /** Document type label (e.g. "message", "artifact"). */
        doc_type: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** Validates the search endpoint response: a flat list of matched chunks. */
export const SearchResponseSchema = z.object({
  /** Ranked search hits. */
  chunks: z.array(SearchChunkSchema),
});

/**
 * Validates metadata for one file in the artifact "wiggle" filesystem. Artifacts
 * are stored as separate files (not inline XML), so each carries its own path,
 * size, and content type.
 */
export const ArtifactFileMetadataSchema = z
  .object({
    /** Path of the file within the artifact filesystem. */
    path: z.string(),
    /** File size in bytes. */
    size: z.number(),
    /** MIME content type of the file. */
    content_type: z.string(),
    /** ISO-8601 creation timestamp. */
    created_at: z.string(),
    /** Wiggle custom metadata; carries the user-facing filename. */
    custom_metadata: z
      .object({
        /** Display filename for the artifact file. */
        filename: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Validates the artifact-listing response. `files` is the bare path list;
 * `files_metadata` carries the per-file detail. These come back as parallel
 * arrays from the wiggle list API.
 */
export const ArtifactListResponseSchema = z.object({
  /** Whether the list call succeeded. */
  success: z.boolean(),
  /** Bare artifact file paths. */
  files: z.array(z.string()),
  /** Detailed metadata, one entry per listed file. */
  files_metadata: z.array(ArtifactFileMetadataSchema),
});

/**
 * Validates a project (a claude.ai Project that groups conversations and docs).
 * Count fields are nullable because the API omits them when not computed.
 */
export const ProjectSchema = z
  .object({
    /** Stable project identifier. */
    uuid: z.string(),
    /** Project name. */
    name: z.string(),
    /** Project description, when set. */
    description: z.string().optional(),
    /** Whether the project is private to its owner. */
    is_private: z.boolean().optional(),
    /** Number of knowledge docs; null when not computed. */
    docs_count: z.number().nullable().optional(),
    /** Number of files; null when not computed. */
    files_count: z.number().nullable().optional(),
    /** ISO-8601 creation timestamp. */
    created_at: z.string(),
    /** ISO-8601 last-modified timestamp. */
    updated_at: z.string(),
  })
  .passthrough();

/** Validates a single project knowledge document, including its full content. */
export const ProjectDocSchema = z
  .object({
    /** Stable document identifier. */
    uuid: z.string(),
    /** Document filename. */
    file_name: z.string(),
    /** Full document text. */
    content: z.string(),
  })
  .passthrough();

/**
 * A project's memory payload from `GET .../memory?project_uuid=`. `controls` is
 * the ordered edit-instruction list (plain strings, no server IDs); it is
 * `null` for a project whose memory has never been generated. `memory` is the
 * generated markdown doc ("" when ungenerated). `.passthrough()` keeps unknown
 * fields for forward compatibility.
 */
export const ProjectMemorySchema = z
  .object({
    /** Server-generated markdown memory document; "" if never generated. */
    memory: z.string(),
    /** Ordered edit-instruction list; null if memory was never generated. */
    controls: z.array(z.string()).nullable(),
    /** ISO 8601 last-generation timestamp; null if never generated. */
    updated_at: z.string().nullable(),
  })
  .passthrough();
