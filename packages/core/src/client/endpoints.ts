/** Origin of the undocumented claude.ai web API that every endpoint path is joined to. */
const BASE_URL = "https://claude.ai";

/**
 * Path builders for the undocumented claude.ai web API, grouped by resource.
 *
 * Each entry is either a literal path or a function that interpolates org/chat/
 * project identifiers into one. Values are root-relative paths only; pass them
 * through {@link buildUrl} to prepend {@link BASE_URL} before calling `fetch`.
 * Declared `as const` so the shape and string literals stay narrowly typed.
 */
export const ENDPOINTS = {
  // Bootstrap & Account

  /** Session bootstrap payload (current account, feature flags, statsig data). */
  bootstrap: "/api/bootstrap",
  /** Current account profile. */
  account: "/api/account",
  /** Organizations the authenticated session belongs to. */
  organizations: "/api/organizations",

  // Conversations

  /**
   * All chat conversations in an org.
   * @param orgId - Organization UUID.
   */
  conversations: (orgId: string) =>
    `/api/organizations/${orgId}/chat_conversations`,
  /**
   * A single conversation. With `tree: true` the API returns messages as a tree
   * keyed by `parent_message_uuid` (`?tree=True`) rather than a flat list.
   * @param orgId - Organization UUID.
   * @param chatId - Conversation UUID.
   * @param options - Set `tree` to request the threaded message tree.
   */
  conversation: (orgId: string, chatId: string, options?: { tree?: boolean }) =>
    `/api/organizations/${orgId}/chat_conversations/${chatId}${options?.tree ? "?tree=True" : ""}`,
  /**
   * Full-text conversation search. `query` is URL-encoded; `n` caps results.
   * @param orgId - Organization UUID.
   * @param query - Raw search string (encoded internally).
   * @param limit - Maximum number of matches to return.
   */
  search: (orgId: string, query: string, limit: number) =>
    `/api/organizations/${orgId}/conversation/search?query=${encodeURIComponent(query)}&n=${limit}`,

  // Projects

  /**
   * All projects in an org.
   * @param orgId - Organization UUID.
   */
  projects: (orgId: string) =>
    `/api/organizations/${orgId}/projects`,
  /**
   * A single project.
   * @param orgId - Organization UUID.
   * @param projectId - Project UUID.
   */
  project: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/projects/${projectId}`,
  /**
   * Knowledge-base documents attached to a project.
   * @param orgId - Organization UUID.
   * @param projectId - Project UUID.
   */
  projectDocs: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/projects/${projectId}/docs`,
  /**
   * Uploaded files attached to a project.
   * @param orgId - Organization UUID.
   * @param projectId - Project UUID.
   */
  projectFiles: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/projects/${projectId}/files`,
  /**
   * Conversations associated with a project.
   * @param orgId - Organization UUID.
   * @param projectId - Project UUID.
   */
  projectConversations: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/projects/${projectId}/conversations`,
  /**
   * A project's memory: the server-generated memory doc plus its `controls`
   * edit list. Only the `project_uuid` query parameter selects the project;
   * other names silently fall back to account-level memory (spike-confirmed).
   * @param orgId - Organization UUID.
   * @param projectId - Project UUID, sent as `project_uuid`.
   */
  memory: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/memory?project_uuid=${projectId}`,

  // Artifacts (wiggle filesystem)

  /**
   * List the artifact files a conversation produced in the wiggle filesystem.
   * @param orgId - Organization UUID.
   * @param conversationId - Conversation UUID.
   */
  artifactListFiles: (orgId: string, conversationId: string) =>
    `/api/organizations/${orgId}/conversations/${conversationId}/wiggle/list-files`,
  /**
   * Download one artifact file by its absolute wiggle path (URL-encoded).
   * The endpoint may serve text files as `application/octet-stream`, so callers
   * cannot rely on the response content-type alone to tell text from binary.
   * @param orgId - Organization UUID.
   * @param conversationId - Conversation UUID.
   * @param path - Absolute wiggle path, e.g. `/mnt/user-data/outputs/foo.md`.
   */
  artifactDownloadFile: (
    orgId: string,
    conversationId: string,
    path: string
  ) =>
    `/api/organizations/${orgId}/conversations/${conversationId}/wiggle/download-file?path=${encodeURIComponent(path)}`,
  /**
   * Storage metadata for a wiggle artifact.
   * @param orgId - Organization UUID.
   * @param artifactId - Wiggle artifact UUID.
   */
  artifactStorageInfo: (orgId: string, artifactId: string) =>
    `/api/organizations/${orgId}/artifacts/wiggle_artifact/${artifactId}/manage/storage/info`,
} as const;

/**
 * Join a root-relative {@link ENDPOINTS} path to {@link BASE_URL} into an
 * absolute URL ready for `fetch`.
 *
 * @param path - Root-relative path beginning with `/`.
 * @returns The fully qualified claude.ai URL.
 */
export function buildUrl(path: string): string {
  return `${BASE_URL}${path}`;
}
