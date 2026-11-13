import type { ClaudeSyncClient } from "../client/client.js";
import { buildUrl } from "../client/endpoints.js";
import { ClaudeSyncError } from "../client/errors.js";
import { buildDuetHeaders, DUET_ENDPOINTS } from "./endpoints.js";
import {
  DuetChannelsResponseSchema,
  DuetMessageSchema,
  DuetProjectSchema,
  DuetSendResponseSchema,
  DuetTaskSchema,
  DuetTasksResponseSchema,
  DuetTaskWriteResponseSchema,
  DuetTimelineResponseSchema,
} from "./schemas.js";
import type {
  DuetChannel,
  DuetListValidation,
  DuetProject,
  DuetProjectLookup,
  DuetSendResponse,
  DuetTaskPatch,
  DuetTasksResponse,
  DuetTaskWriteResponse,
  DuetTimelineResponse,
} from "./types.js";

/** Construction-time options for {@link DuetClient}. */
export interface DuetClientOptions {
  /**
   * Headers that replace or extend the defaults from
   * {@link DUET_DEFAULT_HEADERS} (plus `x-organization-uuid`). Matching is
   * case-insensitive; a `null` value removes a header. Lets a header fix ship as
   * configuration instead of a release, because which headers the server
   * enforces is not known.
   */
  headers?: Readonly<Record<string, string | null>>;
}

/** Options for {@link DuetClient.sendMessage}. */
export interface DuetSendMessageInput {
  /** Message text, markdown. Must contain a non-whitespace character. */
  body: string;
  /** Id of the message to reply to; omit to post a new top-level message. */
  replyToMessageId?: string;
  /**
   * Client-generated dedupe id. The server deduplicates on it, so a retry with
   * the same id cannot post twice. Defaults to a fresh `crypto.randomUUID()`.
   */
  clientMessageId?: string;
}

/** Options for the read calls that take a result cap. */
export interface DuetLimitOptions {
  /** Maximum entries to request. The API exposes no pagination cursor. */
  limit?: number;
}

/** Options for {@link DuetClient.createTask}. */
export interface DuetCreateTaskOptions {
  /**
   * Explicit task id. Defaults to `t` plus a dash-less UUID, 33 characters,
   * matching the length observed in the capture. The server-side id format rule
   * is unknown.
   */
  taskId?: string;
}

/** Prefix that marks a string as a channel id rather than a channel name. */
const CHANNEL_ID_PREFIX = "chan_";

/**
 * Validate a list response entry by entry, so one malformed entry is dropped and
 * counted instead of failing the whole list. The API is young and undocumented,
 * and a single message with an unexpected shape would otherwise fail its
 * channel on every run.
 *
 * @param schema - Schema of the whole response; it validates the kept entries
 * a second time, which also types them.
 * @param data - The decoded, unvalidated response body.
 * @param key - Name of the list field, such as `data` or `tasks`.
 * @param item - Schema of one entry.
 * @returns The validated response holding only the valid entries, with
 * `invalidItems` set when any were dropped (and absent otherwise, so a clean
 * response is unchanged).
 * @throws {@link Error} (a Zod error) when the envelope itself is invalid, for
 * example when the list field is missing.
 */
function parseList<T extends object>(
  schema: { parse(value: unknown): T },
  data: unknown,
  key: string,
  item: { safeParse(value: unknown): { success: boolean } }
): T & DuetListValidation {
  const list =
    data !== null && typeof data === "object"
      ? (data as Record<string, unknown>)[key]
      : undefined;
  if (!Array.isArray(list)) {
    return schema.parse(data);
  }
  const kept = list.filter((entry) => item.safeParse(entry).success);
  const parsed = schema.parse({ ...(data as Record<string, unknown>), [key]: kept });
  const invalid = list.length - kept.length;
  return invalid > 0 ? { ...parsed, invalidItems: invalid } : parsed;
}

/**
 * Typed client for the Claude Duet API (`/v1/code/...`, wire name `aibo`).
 *
 * Composes a {@link ClaudeSyncClient} through its public `requestJson` method,
 * so the session cookie, request pacing, 429 handling and error types are the
 * same ones the rest of ClaudeSync uses. Adds the Duet header set and Zod
 * validation of each response. Built from a captured browser session and not
 * yet verified against the live API.
 */
export class DuetClient {
  /** Duet request headers, built once from the org id and the caller's overrides. */
  private readonly headers: Record<string, string>;

  /**
   * @param client - Transport that owns auth, pacing and error mapping.
   * @param orgId - Organization UUID, sent as `x-organization-uuid`.
   * @param options - Optional header overrides; see {@link DuetClientOptions}.
   */
  constructor(
    private readonly client: ClaudeSyncClient,
    orgId: string,
    options?: DuetClientOptions
  ) {
    this.headers = buildDuetHeaders(orgId, options?.headers);
  }

  /**
   * Send one Duet request through the shared transport.
   *
   * @param path - Root-relative path from {@link DUET_ENDPOINTS}.
   * @param init - Optional method and body; headers are always the Duet set.
   * @returns The decoded, still unvalidated JSON body.
   * @throws {@link RateLimitError} on HTTP 429.
   * @throws {@link ClaudeSyncError} on any other non-2xx response.
   */
  private call(path: string, init?: RequestInit): Promise<unknown> {
    return this.client.requestJson(buildUrl(path), {
      ...init,
      headers: this.headers,
    });
  }

  /**
   * Look up the account's Duet project without creating one, keeping the HTTP
   * status of a refusal so the caller can report it.
   *
   * The request carries `find_only: true`, yet the response has a `created`
   * field. A response with `created === true` means the server made a project
   * for a request that only asked to find one; that is treated as an anomaly
   * and refused, so a read such as `export-all` can never quietly be the thing
   * that created a Duet.
   *
   * @returns `{ project }`, or `{ project: null, status }` when the server
   * answers 404 or 403. Either status can mean the account has no Duet or that
   * the request was refused (for example over a header).
   * @throws {@link ClaudeSyncError} when the server reports it created a project.
   * @throws {@link ClaudeSyncError} on any other failure or a schema mismatch.
   */
  async lookupProject(): Promise<DuetProjectLookup> {
    let data: unknown;
    try {
      data = await this.call(DUET_ENDPOINTS.project, {
        method: "POST",
        body: JSON.stringify({ find_only: true }),
      });
    } catch (err) {
      if (
        err instanceof ClaudeSyncError &&
        (err.statusCode === 404 || err.statusCode === 403)
      ) {
        return { project: null, status: err.statusCode };
      }
      throw err;
    }
    const project = DuetProjectSchema.parse(data);
    if (project.created === true) {
      throw new ClaudeSyncError(
        "Duet anomaly: the server created a Duet project in response to a find-only request, " +
          "so nothing was synced or sent. Check the account in the Duet app."
      );
    }
    return { project };
  }

  /**
   * Look up the account's Duet project without creating one. Same as
   * {@link DuetClient.lookupProject}, minus the refusal status.
   *
   * @returns The project, or `null` when the server answers 404 or 403.
   * @throws {@link ClaudeSyncError} when the server reports it created a project.
   * @throws {@link ClaudeSyncError} on any other failure or a schema mismatch.
   */
  async findProject(): Promise<DuetProject | null> {
    return (await this.lookupProject()).project;
  }

  /**
   * List the channels the account has joined.
   *
   * @param options - Optional result cap; see {@link DuetLimitOptions}.
   * @returns The validated channels.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async listChannels(options?: DuetLimitOptions): Promise<DuetChannel[]> {
    const data = await this.call(DUET_ENDPOINTS.channels(options?.limit));
    return DuetChannelsResponseSchema.parse(data).data;
  }

  /**
   * Fetch the newest messages of a channel, replies included.
   *
   * @param channelId - Channel id (`chan_...`).
   * @param options - Optional result cap; defaults to 200, the observed maximum.
   * @returns The validated messages and linked sessions. Malformed messages are
   * dropped and counted in `invalidItems`.
   * @throws {@link ClaudeSyncError} on request failure.
   * @throws {@link Error} (a Zod error) when the response envelope is invalid.
   */
  async getTimeline(
    channelId: string,
    options?: DuetLimitOptions
  ): Promise<DuetTimelineResponse> {
    const data = await this.call(DUET_ENDPOINTS.timeline(channelId, options?.limit));
    return parseList(DuetTimelineResponseSchema, data, "data", DuetMessageSchema);
  }

  /**
   * Fetch one thread: the root message and its replies.
   *
   * @param channelId - Channel id (`chan_...`).
   * @param messageId - Id of the thread root message.
   * @param options - Optional result cap; defaults to 200.
   * @returns The validated messages and linked sessions. Malformed messages are
   * dropped and counted in `invalidItems`.
   * @throws {@link ClaudeSyncError} on request failure.
   * @throws {@link Error} (a Zod error) when the response envelope is invalid.
   */
  async getThread(
    channelId: string,
    messageId: string,
    options?: DuetLimitOptions
  ): Promise<DuetTimelineResponse> {
    const data = await this.call(
      DUET_ENDPOINTS.thread(channelId, messageId, options?.limit)
    );
    return parseList(DuetTimelineResponseSchema, data, "data", DuetMessageSchema);
  }

  /**
   * Post a message into a channel, optionally as a reply.
   *
   * The server deduplicates on `clientMessageId`, so a caller that wants a safe
   * retry must supply its own id and reuse it; a generated id is not returned.
   * The text is validated before any request is made.
   *
   * @param channelId - Channel id (`chan_...`).
   * @param input - Text, optional reply target and optional dedupe id.
   * @returns The validated send response, including the new message id.
   * @throws {@link Error} if `input.body` is empty or whitespace-only. Thrown
   * before any network call.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async sendMessage(
    channelId: string,
    input: DuetSendMessageInput
  ): Promise<DuetSendResponse> {
    if (input.body.trim() === "") {
      throw new Error("sendMessage: body must be non-empty after trimming whitespace");
    }
    const payload: Record<string, string> = {
      body: input.body,
      client_message_id: input.clientMessageId ?? crypto.randomUUID(),
    };
    if (input.replyToMessageId !== undefined) {
      payload.reply_to_message_id = input.replyToMessageId;
    }
    const data = await this.call(DUET_ENDPOINTS.messages(channelId), {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return DuetSendResponseSchema.parse(data);
  }

  /**
   * List a channel's tasks, adopted suggestions included.
   *
   * @param channelId - Channel id (`chan_...`).
   * @param options - Optional result cap; defaults to 200.
   * @returns The validated tasks and backing artifact id. Malformed tasks (one
   * with no title, say) are dropped and counted in `invalidItems`.
   * @throws {@link ClaudeSyncError} on request failure.
   * @throws {@link Error} (a Zod error) when the response envelope is invalid.
   */
  async listTasks(
    channelId: string,
    options?: DuetLimitOptions
  ): Promise<DuetTasksResponse> {
    const data = await this.call(DUET_ENDPOINTS.tasks(channelId, options?.limit));
    return parseList(DuetTasksResponseSchema, data, "tasks", DuetTaskSchema);
  }

  /**
   * Create a task. The id is generated client-side, as the Duet UI does.
   *
   * @param channelId - Channel id (`chan_...`).
   * @param title - Task title.
   * @param options - Optional explicit task id; see {@link DuetCreateTaskOptions}.
   * @returns The created task and any tasks the server re-spaced.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async createTask(
    channelId: string,
    title: string,
    options?: DuetCreateTaskOptions
  ): Promise<DuetTaskWriteResponse> {
    const taskId = options?.taskId ?? `t${crypto.randomUUID().replaceAll("-", "")}`;
    const data = await this.call(DUET_ENDPOINTS.taskCollection(channelId), {
      method: "POST",
      body: JSON.stringify({ task_id: taskId, title }),
    });
    return DuetTaskWriteResponseSchema.parse(data);
  }

  /**
   * Rename a task or set its completion state.
   *
   * @param channelId - Channel id (`chan_...`).
   * @param taskId - Id of the task to change.
   * @param patch - Either `{ title }` or `{ done }`; see {@link DuetTaskPatch}.
   * @returns The updated task and any tasks the server re-spaced.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async updateTask(
    channelId: string,
    taskId: string,
    patch: DuetTaskPatch
  ): Promise<DuetTaskWriteResponse> {
    const data = await this.call(DUET_ENDPOINTS.task(channelId, taskId), {
      method: "POST",
      body: JSON.stringify(patch),
    });
    return DuetTaskWriteResponseSchema.parse(data);
  }

  /**
   * Turn a user-supplied channel reference into a channel id.
   *
   * With no reference this is the Duet project's own channel. A reference that
   * starts with `chan_` is used as is, with no request. Anything else is matched
   * against the joined channels, first by exact id and then by name,
   * case-insensitively.
   *
   * @param ref - Channel name or id, or undefined for the project channel.
   * @returns The channel id.
   * @throws {@link Error} when the account has no Duet project, the name matches
   * no channel, or the name is ambiguous. The unknown-name message lists the
   * channel names that do exist.
   * @throws {@link ClaudeSyncError} on request failure.
   */
  async resolveChannelId(ref?: string): Promise<string> {
    if (ref === undefined) {
      const project = await this.findProject();
      const id = project?.channel?.id;
      if (!id) {
        throw new Error("This account has no Duet project (or it has no channel).");
      }
      return id;
    }
    if (ref.startsWith(CHANNEL_ID_PREFIX)) {
      return ref;
    }
    const channels = await this.listChannels();
    const byId = channels.find((c) => c.id === ref);
    if (byId) {
      return byId.id;
    }
    const wanted = ref.trim().toLowerCase();
    const matches = channels.filter((c) => (c.name ?? "").trim().toLowerCase() === wanted);
    if (matches.length === 1) {
      return matches[0].id;
    }
    if (matches.length > 1) {
      throw new Error(
        `Channel name "${ref}" is ambiguous (${matches.length} matches); use the channel id.`
      );
    }
    const known = channels.map((c) => c.name ?? c.id).join(", ");
    throw new Error(`No channel matches "${ref}". Known channels: ${known || "none"}.`);
  }
}
