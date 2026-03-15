const BASE_URL = "https://claude.ai";

export const ENDPOINTS = {
  // Bootstrap & Account
  bootstrap: "/api/bootstrap",
  account: "/api/account",
  organizations: "/api/organizations",

  // Conversations
  conversations: (orgId: string) =>
    `/api/organizations/${orgId}/chat_conversations`,
  conversation: (orgId: string, chatId: string) =>
    `/api/organizations/${orgId}/chat_conversations/${chatId}`,
  search: (orgId: string, query: string, limit: number) =>
    `/api/organizations/${orgId}/conversation/search?query=${encodeURIComponent(query)}&n=${limit}`,

  // Projects
  projects: (orgId: string) =>
    `/api/organizations/${orgId}/projects`,
  project: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/projects/${projectId}`,
  projectDocs: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/projects/${projectId}/docs`,
  projectFiles: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/projects/${projectId}/files`,
  projectConversations: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/projects/${projectId}/conversations`,

  // Artifacts (wiggle filesystem)
  artifactListFiles: (orgId: string, conversationId: string) =>
    `/api/organizations/${orgId}/conversations/${conversationId}/wiggle/list-files`,
  artifactDownloadFile: (
    orgId: string,
    conversationId: string,
    path: string
  ) =>
    `/api/organizations/${orgId}/conversations/${conversationId}/wiggle/download-file?path=${encodeURIComponent(path)}`,
  artifactStorageInfo: (orgId: string, artifactId: string) =>
    `/api/organizations/${orgId}/artifacts/wiggle_artifact/${artifactId}/manage/storage/info`,
} as const;

export function buildUrl(path: string): string {
  return `${BASE_URL}${path}`;
}
