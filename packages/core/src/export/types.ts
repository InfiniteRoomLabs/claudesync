/**
 * JSON intermediate representation for git export.
 *
 * Designed for environments without git (notably the browser extension): it
 * describes the commits that should be created, so that a CLI or Node.js
 * consumer can replay them into a real repository via isomorphic-git (see
 * {@link "./git-exporter".exportToGit}). The bundle is also the input the
 * exporters partition by branch -- paths under `branches/<label>/` are routed
 * onto alt refs, everything else onto `main`.
 */
export interface GitBundle {
  /** Conversation-level provenance carried alongside the commits. */
  metadata: {
    /** Source conversation UUID (claude.ai). */
    conversationId: string;
    /** Human-readable conversation title at export time. */
    conversationName: string;
    /** Model that produced the conversation, or null if unknown. */
    model: string | null;
    /** Conversation creation timestamp (ISO 8601). */
    createdAt: string;
    /** Time this bundle was generated (ISO 8601). */
    exportedAt: string;
  };
  /** Ordered commits to replay; consumers create them in array order. */
  commits: GitBundleCommit[];
}

/**
 * A single commit to be replayed into a git repository.
 *
 * File paths are relative to the repo root. Paths beginning with
 * `branches/<label>/` are a signal to the git writer to route those files onto
 * a separate `alt-<label>` ref rather than `main`; all other paths land on
 * `main`. A commit may legitimately mix both, in which case the writer splits
 * it (see {@link "./git-exporter".exportToGit}).
 */
export interface GitBundleCommit {
  /** Commit message. */
  message: string;
  /** Author/commit time (ISO 8601); converted to epoch seconds at replay. */
  timestamp: string;
  /** Git author identity for this commit. */
  author: { name: string; email: string };
  /**
   * Files written by this commit, keyed by repo-relative path. String values
   * are written as UTF-8 text; Uint8Array values are written as raw bytes
   * (binary artifacts).
   */
  files: Record<string, string | Uint8Array>; // path -> content
}
