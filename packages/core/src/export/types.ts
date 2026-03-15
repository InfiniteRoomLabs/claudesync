/**
 * GitBundle -- JSON intermediate representation for git export.
 *
 * This format is designed for environments without git (browser extension).
 * It describes what commits should be created so a CLI or Node.js consumer
 * can replay them into an actual git repository via isomorphic-git.
 */
export interface GitBundle {
  metadata: {
    conversationId: string;
    conversationName: string;
    model: string | null;
    createdAt: string;
    exportedAt: string;
  };
  commits: GitBundleCommit[];
}

export interface GitBundleCommit {
  message: string;
  timestamp: string;
  author: { name: string; email: string };
  files: Record<string, string | Uint8Array>; // path -> content
}
