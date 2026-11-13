import { z } from "zod";

/*
 * Zod schemas for the Claude Duet API, shaped from a browser capture. Every
 * object uses `.passthrough()` so fields added server-side survive a round trip
 * (the stored `messages.json` keeps them), and only the fields the code reads
 * are required: the API is undocumented and young, so drift is expected.
 */

/**
 * A Duet channel. Only `id` is required. `members` is allowed through but the
 * export deliberately never stores it.
 */
export const DuetChannelSchema = z
  .object({
    /** Channel id (`chan_...`). Opaque; never parse it. */
    id: z.string(),
    /** Human-readable channel name. May be absent or null for unnamed channels. */
    name: z.string().nullable().optional(),
  })
  .passthrough();

/** Duet project settings as returned by the find-project call. */
export const DuetSettingsSchema = z
  .object({
    /** Display name of the agent, used to label its messages. */
    agent_name: z.string().nullable().optional(),
    /** IANA time zone used to bucket messages into local days. */
    time_zone: z.string().nullable().optional(),
    /** Preferred language. */
    language: z.string().nullable().optional(),
    /** Free-text statement of what the agent is for. */
    purpose: z.string().nullable().optional(),
    /** Quiet-hours configuration; shape not captured, so left untyped. */
    quiet_hours: z.unknown().optional(),
  })
  .passthrough();

/** The Duet project: its own channel, settings and routine switches. */
export const DuetProjectSchema = z
  .object({
    /** The project's own channel. Absent means there is nothing to sync. */
    channel: DuetChannelSchema.nullable().optional(),
    /** Agent settings. */
    settings: DuetSettingsSchema.nullable().optional(),
    /** Per-routine on/off switches; shape not captured, so left untyped. */
    routine_switches: z.unknown().optional(),
    /** Whether routines are globally paused. */
    routines_paused: z.boolean().nullable().optional(),
    /** Whether this call created the project (it is called with `find_only`). */
    created: z.boolean().nullable().optional(),
  })
  .passthrough();

/**
 * A chat message. Exactly one `author_*` field is expected to be present;
 * none is required because the schema must not reject a future author kind.
 */
export const DuetMessageSchema = z
  .object({
    /** Message id (`cmsg_...`). The upsert key of the stored day files. */
    id: z.string(),
    /** Monotonic sequence number, a decimal string on the wire. */
    seq: z.union([z.string(), z.number()]),
    /** Channel the message belongs to. */
    channel_id: z.string().nullable().optional(),
    /** Id of the thread root. Equal to `id` for a root; absent means root. */
    thread_root_id: z.string().nullable().optional(),
    /** Creation time, ISO 8601 with a `Z` suffix. */
    created_at: z.string(),
    /** Message body, markdown. Written verbatim into the export. */
    body: z.string(),
    /** Number of replies the server holds for this message. */
    reply_count: z.number().nullable().optional(),
    /** Set when a person wrote the message. */
    author_account_id: z.string().nullable().optional(),
    /** Set when the agent wrote the message. */
    author_agent_id: z.string().nullable().optional(),
    /** Set when a routine wrote the message. */
    author_routine_id: z.string().nullable().optional(),
    /** Display name of the author, when the server supplies one. */
    display_name: z.string().nullable().optional(),
    /** Client-generated dedupe id of messages sent through the API. */
    client_message_id: z.string().nullable().optional(),
    /** Thread status, when the thread has one. */
    thread_status: z.string().nullable().optional(),
  })
  .passthrough();

/** Response of the channel list call. */
export const DuetChannelsResponseSchema = z
  .object({
    /** The channels. */
    data: z.array(DuetChannelSchema),
  })
  .passthrough();

/** Response shared by the timeline and thread calls. */
export const DuetTimelineResponseSchema = z
  .object({
    /** Messages in the window. */
    data: z.array(DuetMessageSchema),
    /** Sessions linked to the messages; shape not captured, so left untyped. */
    linked_sessions: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** Response of the send-message call. */
export const DuetSendResponseSchema = z
  .object({
    /** Id the server assigned to the new message. */
    message_id: z.string(),
    /** Sequence number of the new message. */
    seq: z.union([z.string(), z.number()]).optional(),
    /** Thread root of the new message. */
    thread_root_id: z.string().nullable().optional(),
    /** Creation time of the new message. */
    created_at: z.string().optional(),
    /** True when the server recognised the `client_message_id` and did not create a duplicate. */
    deduplicated: z.boolean().optional(),
  })
  .passthrough();

/**
 * The `found` block of a task the agent surfaced from a connector. Every
 * field is optional because only its presence is read.
 */
export const DuetTaskFoundSchema = z
  .object({
    /** Connector the suggestion came from. */
    connector: z.string().nullable().optional(),
    /** Why the agent surfaced it. */
    why: z.string().nullable().optional(),
    /** Short summary of the source item. */
    summary: z.string().nullable().optional(),
    /** When the agent found it. */
    foundAt: z.string().nullable().optional(),
    /** When the suggestion expires. */
    expiresAt: z.string().nullable().optional(),
  })
  .passthrough();

/** The user-visible payload of a task. */
export const DuetTaskDataSchema = z
  .object({
    /** Task title. */
    title: z.string(),
    /** Whether the task is done. */
    done: z.boolean().nullable().optional(),
    /** When the task was completed. */
    doneAt: z.string().nullable().optional(),
    /** List section; only `"now"` was observed. */
    section: z.string().nullable().optional(),
    /** Who created the task: `agent` or `user`. */
    createdBy: z.string().nullable().optional(),
    /** Creation time. */
    createdAt: z.string().nullable().optional(),
    /** Last update time. */
    updatedAt: z.string().nullable().optional(),
    /** Present when the task is a suggestion surfaced from a connector. */
    found: DuetTaskFoundSchema.nullable().optional(),
    /** Thread the task relates to. */
    threadRootId: z.string().nullable().optional(),
    /** Optional look-by time. */
    lookBy: z.string().nullable().optional(),
    /** Free-text note. */
    note: z.string().nullable().optional(),
  })
  .passthrough();

/** A task: identity and version envelope around {@link DuetTaskDataSchema}. */
export const DuetTaskSchema = z
  .object({
    /** Task id. Client-generated on create. */
    id: z.string(),
    /** Server-side version counter. */
    version: z.number().nullable().optional(),
    /** Last server-side update time. */
    updated_at: z.string().nullable().optional(),
    /** The task payload. */
    data: DuetTaskDataSchema,
  })
  .passthrough();

/** Response of the list-tasks call. */
export const DuetTasksResponseSchema = z
  .object({
    /** The tasks. */
    tasks: z.array(DuetTaskSchema),
    /** Id of the artifact backing the task list. */
    artifact_id: z.string().nullable().optional(),
  })
  .passthrough();

/** Response of the create-task and update-task calls. */
export const DuetTaskWriteResponseSchema = z
  .object({
    /** The task as stored after the write. */
    task: DuetTaskSchema,
    /** Tasks whose ordering the server adjusted as a side effect. */
    respaced_tasks: z.array(DuetTaskSchema).optional(),
  })
  .passthrough();

/**
 * On-disk shape of a day's canonical message store, `messages.json`. Messages
 * keep every field the API returned, including ones this version does not know.
 */
export const DuetDayStoreSchema = z
  .object({
    /** Channel the day belongs to. */
    channel_id: z.string(),
    /** Local calendar date, `YYYY-MM-DD`, in {@link DuetDayStoreSchema.time_zone}. */
    date: z.string(),
    /** IANA time zone the date was computed in. */
    time_zone: z.string(),
    /** Every message ever synced for this day and channel, sorted by `seq`. */
    messages: z.array(DuetMessageSchema),
  })
  .passthrough();

/** One task's entry in the canonical task store, `tasks.json`. */
export const DuetStoredTaskSchema = z
  .object({
    /** The task as last returned by the API. */
    task: DuetTaskSchema,
    /** Time of the first sync that saw the task (ISO 8601). */
    first_seen_at: z.string(),
    /** Time of the latest sync that saw the task (ISO 8601). */
    last_seen_at: z.string(),
    /** False once a sync no longer returns the task. The entry is kept. */
    present: z.boolean(),
  })
  .passthrough();

/** On-disk shape of `tasks.json`: stored tasks keyed by task id. */
export const DuetTaskStoreSchema = z
  .object({
    /** Stored tasks keyed by task id. */
    tasks: z.record(DuetStoredTaskSchema),
  })
  .passthrough();
