import type { AuthProvider } from "../auth/types.js";
import { buildUrl, ENDPOINTS } from "./endpoints.js";
import { ClaudeSyncError, RateLimitError } from "./errors.js";
import {
  OrganizationSchema,
  ConversationSummarySchema,
  ConversationSchema,
  SearchResponseSchema,
  ArtifactListResponseSchema,
  ProjectSchema,
  ProjectDocSchema,
  ProjectMemorySchema,
} from "../models/schemas.js";
import type {
  Organization,
  ConversationSummary,
  Conversation,
  SearchResponse,
  ArtifactListResponse,
  Project,
  ProjectDoc,
  ProjectMemory,
} from "../models/types.js";
import { z } from "zod";
import { basename } from "node:path";
import { FixedGapLimiter, type RequestLimiter } from "../concurrency/limiter.js";

/** Construction-time options for {@link ClaudeSyncClient}. */
export interface ClientOptions {
  /**
   * Delay in milliseconds between API requests, used by the default fixed-gap
   * limiter when no `limiter` is supplied.
   * @defaultValue 300
   */
  rateLimitDelayMs?: number;
  /**
   * Rate limiter consulted before every request. When omitted, a
   * {@link FixedGapLimiter} reproduces the legacy fixed-delay behavior. Pass a
   * shared adaptive controller to participate in parallel-sync backpressure
   * (pacing + AIMD + pause-on-throttle).
   */
  limiter?: RequestLimiter;
}

/**
 * Required prefix for wiggle artifact paths. {@link ClaudeSyncClient.downloadArtifact}
 * rejects any path not starting with this value as a path-traversal guard.
 */
const ARTIFACT_PATH_PREFIX = "/mnt/user-data/";

/** Content types that are textual despite not starting with `text/`. */
const TEXT_APP_CONTENT_TYPE =
  /^application\/(json|xml|javascript|x-ndjson|x-yaml|yaml)\b|^application\/[\w.+-]+\+(json|xml)\b/;
/** Unambiguously binary content types. `octet-stream` is intentionally excluded
 *  -- the wiggle endpoint serves text files with it, so it falls through to the
 *  extension / strict-UTF-8 checks. */
const BINARY_CONTENT_TYPE =
  /^(image|audio|video)\/|^application\/(pdf|zip|gzip|x-tar|x-7z-compressed|x-bzip2|wasm)\b/;
/** File extensions treated as UTF-8 text when the content type is ambiguous. */
const TEXT_FILE_EXTENSION =
  /\.(md|markdown|txt|json|jsonl|ndjson|csv|tsv|xml|ya?ml|toml|ini|cfg|conf|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|php|swift|sh|bash|zsh|fish|sql|svg|patch|diff|log)$/i;

/**
 * Typed client over the undocumented claude.ai web API.
 *
 * Wraps every endpoint in {@link ENDPOINTS} with auth-header injection, a shared
 * {@link RequestLimiter} for rate-limit pacing, and Zod validation of responses.
 * All read methods funnel through {@link ClaudeSyncClient.request} (JSON) or
 * {@link ClaudeSyncClient.requestRaw} (binary artifact bodies), so throttling,
 * 429 handling, and error wrapping are uniform across the surface.
 */
export class ClaudeSyncClient {
  /** Rate limiter consulted before each request; either the caller's or a {@link FixedGapLimiter}. */
  private readonly limiter: RequestLimiter;

  /**
   * @param auth - Supplies the session cookie / browser-like headers for every
   * request. The origin of the cookie is abstracted behind {@link AuthProvider}.
   * @param options - Optional limiter and pacing configuration; see {@link ClientOptions}.
   */
  constructor(
    private readonly auth: AuthProvider,
    options?: ClientOptions
  ) {
    this.limiter =
      options?.limiter ?? new FixedGapLimiter(options?.rateLimitDelayMs ?? 300);
  }

  /**
   * Build a {@link RateLimitError} from a 429 body and notify the limiter to
   * back off. Falls back to a reset of now + 60s when the body omits
   * `error.resets_at`.
   *
   * @param body - Parsed JSON body of the 429 response, or null if unparseable.
   * @returns The error to throw to the caller.
   */
  private parseRateLimit(body: unknown): RateLimitError {
    const resetsAt =
      (body as { error?: { resets_at?: number } } | null)?.error?.resets_at ??
      Math.floor(Date.now() / 1000) + 60;
    this.limiter.onThrottle(resetsAt);
    return new RateLimitError(resetsAt);
  }

  /**
   * Issue a paced GET and return the parsed JSON body.
   *
   * Acquires a limiter slot, attaches auth headers, then maps failures: 429 to a
   * {@link RateLimitError} and any other non-2xx to a {@link ClaudeSyncError}.
   * On success the limiter is told the request succeeded (for adaptive ramp-up).
   *
   * @param url - Absolute URL, typically from {@link buildUrl}.
   * @returns The decoded JSON value (still untyped; callers validate with Zod).
   * @throws {@link RateLimitError} on HTTP 429.
   * @throws {@link ClaudeSyncError} on any other non-2xx response.
   */
  private async request(url: string): Promise<unknown> {
    await this.limiter.acquireRequestSlot();

    const headers = await this.auth.getHeaders();
    const response = await fetch(url, { headers });

    if (response.status === 429) {
      const body = await response.json().catch(() => null);
      throw this.parseRateLimit(body);
    }

    if (!response.ok) {
      throw new ClaudeSyncError(
        `API request failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    this.limiter.onRequestSuccess();
    return response.json();
  }

  /**
   * Like {@link ClaudeSyncClient.request} but returns the raw {@link Response}
   * instead of parsing JSON, so the caller can inspect headers and read the body
   * as bytes. Used for artifact downloads, whose bodies may be binary.
   *
   * @param url - Absolute URL, typically from {@link buildUrl}.
   * @returns The successful (2xx) `fetch` response, body unread.
   * @throws {@link RateLimitError} on HTTP 429.
   * @throws {@link ClaudeSyncError} on any other non-2xx response.
   */
  private async requestRaw(url: string): Promise<Response> {
    await this.limiter.acquireRequestSlot();

    const headers = await this.auth.getHeaders();
    const response = await fetch(url, { headers });

    if (response.status === 429) {
      const body = await response.json().catch(() => null);
      throw this.parseRateLimit(body);
    }

    if (!response.ok) {
      throw new ClaudeSyncError(
        `API request failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    this.limiter.onRequestSuccess();
    return response;
  }

  // --- Organizations ---

  /**
   * List every organization the authenticated session belongs to.
   * @returns Validated organizations.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async listOrganizations(): Promise<Organization[]> {
    const data = await this.request(buildUrl(ENDPOINTS.organizations));
    return z.array(OrganizationSchema).parse(data);
  }

  // --- Conversations ---

  /**
   * Stream an org's conversation summaries as an async iterable.
   *
   * The API currently returns all conversations in one response (no pagination);
   * yielding one at a time keeps the call site forward-compatible with future
   * pagination and lets large lists be processed lazily.
   *
   * @param orgId - Organization UUID.
   * @returns An async iterable of validated conversation summaries.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   * @see {@link ClaudeSyncClient.listConversationsAll} to collect into an array.
   */
  async *listConversations(
    orgId: string
  ): AsyncIterable<ConversationSummary> {
    const data = await this.request(
      buildUrl(ENDPOINTS.conversations(orgId))
    );
    const conversations = z
      .array(ConversationSummarySchema)
      .parse(data);
    for (const conv of conversations) {
      yield conv;
    }
  }

  /**
   * Collect all of an org's conversation summaries into an array.
   *
   * Convenience wrapper over {@link ClaudeSyncClient.listConversations}; prefer
   * the iterable directly for streaming/lazy processing of large lists.
   *
   * @param orgId - Organization UUID.
   * @returns Every conversation summary in the org.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async listConversationsAll(
    orgId: string
  ): Promise<ConversationSummary[]> {
    const results: ConversationSummary[] = [];
    for await (const conv of this.listConversations(orgId)) {
      results.push(conv);
    }
    return results;
  }

  /**
   * Fetch a single conversation, optionally as a threaded message tree.
   *
   * @param orgId - Organization UUID.
   * @param chatId - Conversation UUID.
   * @param options - Set `tree: true` to receive messages linked by
   * `parent_message_uuid` instead of a flat array.
   * @returns The validated conversation.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async getConversation(
    orgId: string,
    chatId: string,
    options?: { tree?: boolean }
  ): Promise<Conversation> {
    const data = await this.request(
      buildUrl(ENDPOINTS.conversation(orgId, chatId, options))
    );
    return ConversationSchema.parse(data);
  }

  /**
   * Full-text search across an org's conversations.
   *
   * Handles double-JSON-encoded responses defensively: the API sometimes returns
   * a JSON string whose contents are themselves JSON, so a string result is
   * parsed a second time before validation.
   *
   * @param orgId - Organization UUID.
   * @param query - Search string.
   * @param limit - Maximum number of matches.
   * @returns The validated search response.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async searchConversations(
    orgId: string,
    query: string,
    limit = 20
  ): Promise<SearchResponse> {
    const data = await this.request(
      buildUrl(ENDPOINTS.search(orgId, query, limit))
    );
    // Defensive double-parse: API returns double-JSON-encoded responses
    const parsed =
      typeof data === "string" ? JSON.parse(data) : data;
    return SearchResponseSchema.parse(parsed);
  }

  // --- Projects ---

  /**
   * List every project in an org.
   * @param orgId - Organization UUID.
   * @returns Validated projects.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async listProjects(orgId: string): Promise<Project[]> {
    const data = await this.request(
      buildUrl(ENDPOINTS.projects(orgId))
    );
    return z.array(ProjectSchema).parse(data);
  }

  /**
   * Fetch the knowledge-base documents attached to a project.
   * @param orgId - Organization UUID.
   * @param projectId - Project UUID.
   * @returns Validated project docs.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async getProjectDocs(
    orgId: string,
    projectId: string
  ): Promise<ProjectDoc[]> {
    const data = await this.request(
      buildUrl(ENDPOINTS.projectDocs(orgId, projectId))
    );
    return z.array(ProjectDocSchema).parse(data);
  }

  /**
   * List the conversations associated with a project.
   * @param orgId - Organization UUID.
   * @param projectId - Project UUID.
   * @returns Validated conversation summaries scoped to the project.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async getProjectConversations(
    orgId: string,
    projectId: string
  ): Promise<ConversationSummary[]> {
    const data = await this.request(
      buildUrl(ENDPOINTS.projectConversations(orgId, projectId))
    );
    return z.array(ConversationSummarySchema).parse(data);
  }

  /**
   * Fetch a project's memory: the generated doc and its `controls` edit list.
   *
   * A project whose memory has never been generated returns
   * `{ memory: "", controls: null, updated_at: null }` -- callers treat that as
   * "no memory yet", not an error.
   *
   * @param orgId - Organization UUID.
   * @param projectId - Project UUID.
   * @returns The validated memory payload.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async getProjectMemory(
    orgId: string,
    projectId: string
  ): Promise<ProjectMemory> {
    const data = await this.request(
      buildUrl(ENDPOINTS.memory(orgId, projectId))
    );
    return ProjectMemorySchema.parse(data);
  }

  // --- Artifacts (wiggle filesystem) ---

  /**
   * List the artifact files a conversation produced in the wiggle filesystem.
   * @param orgId - Organization UUID.
   * @param conversationId - Conversation UUID.
   * @returns The validated file listing.
   * @throws {@link ClaudeSyncError} on request failure or schema mismatch.
   */
  async listArtifacts(
    orgId: string,
    conversationId: string
  ): Promise<ArtifactListResponse> {
    const data = await this.request(
      buildUrl(ENDPOINTS.artifactListFiles(orgId, conversationId))
    );
    return ArtifactListResponseSchema.parse(data);
  }

  /**
   * Download an artifact file from the wiggle filesystem as text or bytes.
   *
   * The wiggle `download-file` endpoint serves text files (e.g. `.md`, `.json`)
   * with `application/octet-stream`, so a content-type prefix check alone
   * mislabels UTF-8 text as binary. Text vs binary is decided by: an explicitly
   * textual content-type, OR a known text file extension, OR (for ambiguous
   * types like octet-stream) a successful strict UTF-8 decode. Only genuinely
   * binary content (images, archives, or bytes that fail strict UTF-8) comes
   * back as a Uint8Array.
   *
   * The path is validated against {@link ARTIFACT_PATH_PREFIX} first to prevent
   * path-traversal attacks via a crafted `path` query parameter.
   *
   * @param orgId - Organization UUID.
   * @param conversationId - Conversation UUID.
   * @param path - Absolute wiggle path under {@link ARTIFACT_PATH_PREFIX}.
   * @returns A string for text content, a Uint8Array for binary content.
   * @throws {@link ClaudeSyncError} if the path is outside the allowed prefix,
   * or on request failure.
   */
  async downloadArtifact(
    orgId: string,
    conversationId: string,
    path: string
  ): Promise<string | Uint8Array> {
    // Security: validate artifact path against expected pattern
    if (!path.startsWith(ARTIFACT_PATH_PREFIX)) {
      throw new ClaudeSyncError(
        `Invalid artifact path: ${path}. Expected path starting with ${ARTIFACT_PATH_PREFIX}`
      );
    }

    const response = await this.requestRaw(
      buildUrl(
        ENDPOINTS.artifactDownloadFile(orgId, conversationId, path)
      )
    );

    const contentType = (
      response.headers.get("content-type") ?? "text/plain"
    ).toLowerCase();
    const bytes = new Uint8Array(await response.arrayBuffer());

    // 1) Explicitly textual content type.
    if (contentType.startsWith("text/") || TEXT_APP_CONTENT_TYPE.test(contentType)) {
      return new TextDecoder("utf-8").decode(bytes);
    }
    // 2) Explicitly binary media (image/audio/video/pdf/archive) stays bytes.
    if (BINARY_CONTENT_TYPE.test(contentType)) {
      return bytes;
    }
    // 3) Ambiguous (e.g. application/octet-stream, which the wiggle endpoint
    //    serves even for markdown): trust a text file extension, else attempt a
    //    strict UTF-8 decode and only keep bytes when the content is truly binary.
    if (TEXT_FILE_EXTENSION.test(path)) {
      return new TextDecoder("utf-8").decode(bytes);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return bytes;
    }
  }

  /**
   * Derive a traversal-safe local filename from an artifact's wiggle path.
   *
   * Strips every directory component via `path.basename`, so a malicious path
   * cannot escape the intended output directory when the file is written locally.
   *
   * @param artifactPath - Absolute wiggle artifact path.
   * @returns The final path segment only.
   */
  static safeFilename(artifactPath: string): string {
    return basename(artifactPath);
  }
}
