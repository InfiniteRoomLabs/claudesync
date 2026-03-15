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

export interface ClientOptions {
  /**
   * Delay in milliseconds between API requests to avoid rate limiting.
   * Default: 300ms.
   */
  rateLimitDelayMs?: number;
}

/** Expected path prefix for wiggle artifact files */
const ARTIFACT_PATH_PREFIX = "/mnt/user-data/";

export class ClaudeSyncClient {
  private readonly rateLimitDelayMs: number;
  private lastRequestTime = 0;

  constructor(
    private readonly auth: AuthProvider,
    options?: ClientOptions
  ) {
    this.rateLimitDelayMs = options?.rateLimitDelayMs ?? 300;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.rateLimitDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.rateLimitDelayMs - elapsed)
      );
    }
    this.lastRequestTime = Date.now();
  }

  private async request(url: string): Promise<unknown> {
    await this.throttle();

    const headers = await this.auth.getHeaders();
    const response = await fetch(url, { headers });

    if (response.status === 429) {
      const body = await response.json().catch(() => null);
      const resetsAt =
        body?.error?.resets_at ??
        Math.floor(Date.now() / 1000) + 60;
      throw new RateLimitError(resetsAt);
    }

    if (!response.ok) {
      throw new ClaudeSyncError(
        `API request failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    return response.json();
  }

  private async requestRaw(url: string): Promise<Response> {
    await this.throttle();

    const headers = await this.auth.getHeaders();
    const response = await fetch(url, { headers });

    if (response.status === 429) {
      const body = await response.json().catch(() => null);
      const resetsAt =
        body?.error?.resets_at ??
        Math.floor(Date.now() / 1000) + 60;
      throw new RateLimitError(resetsAt);
    }

    if (!response.ok) {
      throw new ClaudeSyncError(
        `API request failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

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
    chatId: string
  ): Promise<Conversation> {
    const data = await this.request(
      buildUrl(ENDPOINTS.conversation(orgId, chatId))
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

    const contentType =
      response.headers.get("content-type") ?? "text/plain";
    if (contentType.startsWith("text/")) {
      return response.text();
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Get the safe local filename for an artifact path.
   * Uses path.basename() to prevent path traversal on local writes.
   */
  static safeFilename(artifactPath: string): string {
    return basename(artifactPath);
  }
}
