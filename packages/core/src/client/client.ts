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
} from "../models/schemas.js";
import type {
  Organization,
  ConversationSummary,
  Conversation,
  SearchResponse,
  ArtifactListResponse,
  Project,
  ProjectDoc,
} from "../models/types.js";
import { z } from "zod";
import { basename } from "node:path";
import { FixedGapLimiter, type RequestLimiter } from "../concurrency/limiter.js";

export interface ClientOptions {
  /**
   * Delay in milliseconds between API requests, used by the default fixed-gap
   * limiter when no `limiter` is supplied. Default: 300ms.
   */
  rateLimitDelayMs?: number;
  /**
   * Rate limiter consulted before every request. When omitted, a
   * {@link FixedGapLimiter} reproduces the legacy fixed-delay behavior. Pass a
   * shared {@link AdaptiveController} to participate in parallel-sync
   * backpressure (pacing + AIMD + pause-on-throttle).
   */
  limiter?: RequestLimiter;
}

/** Expected path prefix for wiggle artifact files */
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

export class ClaudeSyncClient {
  private readonly limiter: RequestLimiter;

  constructor(
    private readonly auth: AuthProvider,
    options?: ClientOptions
  ) {
    this.limiter =
      options?.limiter ?? new FixedGapLimiter(options?.rateLimitDelayMs ?? 300);
  }

  private parseRateLimit(body: unknown): RateLimitError {
    const resetsAt =
      (body as { error?: { resets_at?: number } } | null)?.error?.resets_at ??
      Math.floor(Date.now() / 1000) + 60;
    this.limiter.onThrottle(resetsAt);
    return new RateLimitError(resetsAt);
  }

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

  async listOrganizations(): Promise<Organization[]> {
    const data = await this.request(buildUrl(ENDPOINTS.organizations));
    return z.array(OrganizationSchema).parse(data);
  }

  // --- Conversations ---

  /**
   * List conversations as an async iterable.
   * Currently the API returns all conversations in one response (no pagination),
   * but this interface is forward-compatible with future pagination.
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
   * Convenience method that collects all conversations into an array.
   * Use listConversations() for streaming/lazy processing of large lists.
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
   * Search conversations. Handles double-JSON-encoded responses defensively:
   * the API sometimes returns a JSON string containing another JSON string.
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

  async listProjects(orgId: string): Promise<Project[]> {
    const data = await this.request(
      buildUrl(ENDPOINTS.projects(orgId))
    );
    return z.array(ProjectSchema).parse(data);
  }

  async getProjectDocs(
    orgId: string,
    projectId: string
  ): Promise<ProjectDoc[]> {
    const data = await this.request(
      buildUrl(ENDPOINTS.projectDocs(orgId, projectId))
    );
    return z.array(ProjectDocSchema).parse(data);
  }

  async getProjectConversations(
    orgId: string,
    projectId: string
  ): Promise<ConversationSummary[]> {
    const data = await this.request(
      buildUrl(ENDPOINTS.projectConversations(orgId, projectId))
    );
    return z.array(ConversationSummarySchema).parse(data);
  }

  // --- Artifacts (wiggle filesystem) ---

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
   * Download an artifact file from the wiggle filesystem.
   * Returns string for text content, Uint8Array for binary content.
   *
   * The wiggle `download-file` endpoint serves text files (e.g. `.md`, `.json`)
   * with `application/octet-stream`, so a content-type prefix check alone
   * mislabels UTF-8 text as binary. We decide text vs binary by: an explicitly
   * textual content-type, OR a known text file extension, OR (for ambiguous
   * types like octet-stream) a successful strict UTF-8 decode. Only genuinely
   * binary content (images, archives, or bytes that fail strict UTF-8) is
   * returned as a Uint8Array.
   *
   * Security: validates that the path matches the expected artifact path prefix
   * to prevent path traversal attacks.
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
   * Get the safe local filename for an artifact path.
   * Uses path.basename() to prevent path traversal on local writes.
   */
  static safeFilename(artifactPath: string): string {
    return basename(artifactPath);
  }
}
