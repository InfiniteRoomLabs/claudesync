import type { ClaudeSyncClient } from "../client/client.js";
import type {
  ArtifactListResponse,
  Conversation,
  ConversationSummary,
} from "../models/types.js";
import { buildGitBundle } from "../export/bundle-builder.js";
import type { GitBundle } from "../export/types.js";
import { safeSlug, displayName } from "../util/naming.js";

export interface FetchAndBuildOptions {
  authorName: string;
  authorEmail: string;
  /** Don't fetch artifacts (faster). */
  skipArtifacts?: boolean;
  /** Pass-through to buildGitBundle. Default true so all sync paths preserve
   *  branches uniformly. */
  multiBranch?: boolean;
}

export interface FetchAndBuildResult {
  conversation: Conversation;
  artifacts: ArtifactListResponse;
  artifactContents: Map<string, string | Uint8Array>;
  bundle: GitBundle;
  /** Human-readable label for log lines. Falls back to `<unnamed <uuid>>`. */
  displayName: string;
  /** Filesystem-safe slug. Falls back to `unnamed-<uuid>`. */
  slug: string;
}

/**
 * Single source of truth for "fetch a conversation, fetch its artifacts, and
 * build the bundle". Both the standalone-conversation orchestrator and the
 * project-export loop go through this so name/slug fallbacks, tree fetching,
 * and artifact handling stay consistent.
 *
 * This function does no I/O against the local filesystem -- it is a pure
 * fetch+build. Persistence (state file, changelog, swap, ref management) is
 * the caller's job.
 */
export async function fetchAndBuild(
  client: ClaudeSyncClient,
  orgId: string,
  summary: ConversationSummary,
  options: FetchAndBuildOptions
): Promise<FetchAndBuildResult> {
  const conversation = await client.getConversation(orgId, summary.uuid, {
    tree: true,
  });

  const empty: ArtifactListResponse = {
    success: true,
    files: [],
    files_metadata: [],
  };
  let artifacts: ArtifactListResponse = empty;
  const artifactContents = new Map<string, string | Uint8Array>();

  if (!options.skipArtifacts) {
    try {
      artifacts = await client.listArtifacts(orgId, summary.uuid);
      for (const meta of artifacts.files_metadata) {
        try {
          const content = await client.downloadArtifact(
            orgId,
            summary.uuid,
            meta.path
          );
          artifactContents.set(meta.path, content);
        } catch {
          // Per-artifact failure is non-fatal: keep going with what we have.
        }
      }
    } catch {
      // Some conversations don't support the wiggle filesystem at all.
    }
  }

  const bundle = buildGitBundle(conversation, artifacts, artifactContents, {
    authorName: options.authorName,
    authorEmail: options.authorEmail,
    multiBranch: options.multiBranch ?? true,
  });

  return {
    conversation,
    artifacts,
    artifactContents,
    bundle,
    displayName: displayName(summary.name, summary.uuid),
    slug: safeSlug(summary.name, summary.uuid),
  };
}
