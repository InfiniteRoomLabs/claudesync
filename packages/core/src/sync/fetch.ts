import type { ClaudeSyncClient } from "../client/client.js";
import type {
  ArtifactListResponse,
  Conversation,
  ConversationSummary,
} from "../models/types.js";
import { buildGitBundle } from "../export/bundle-builder.js";
import type { GitBundle } from "../export/types.js";
import { safeSlug, displayName } from "../util/naming.js";

/** Options controlling a {@link fetchAndBuild} call. */
export interface FetchAndBuildOptions {
  /** Git author name stamped onto the generated commits. */
  authorName: string;
  /** Git author email stamped onto the generated commits. */
  authorEmail: string;
  /** Don't fetch artifacts (faster). */
  skipArtifacts?: boolean;
  /** Pass-through to buildGitBundle. Default true so all sync paths preserve
   *  branches uniformly. */
  multiBranch?: boolean;
}

/** Everything {@link fetchAndBuild} produces: raw fetched data plus the built bundle and labels. */
export interface FetchAndBuildResult {
  /** The conversation fetched with its full message tree. */
  conversation: Conversation;
  /** Artifact list metadata; empty when artifacts were skipped or unsupported. */
  artifacts: ArtifactListResponse;
  /** Downloaded artifact bytes keyed by wiggle path; entries that failed to download are omitted. */
  artifactContents: Map<string, string | Uint8Array>;
  /** The assembled git bundle ready for the caller to persist. */
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
 *
 * Artifact fetching is best-effort: a failure listing artifacts (some
 * conversations have no wiggle filesystem) or downloading any single artifact
 * is swallowed so the bundle is still built from whatever succeeded.
 *
 * @param client - Authenticated claude.ai API client.
 * @param orgId - Organization uuid that owns the conversation.
 * @param summary - Conversation summary providing its uuid and name.
 * @param options - Author identity and fetch/build toggles.
 * @returns The fetched conversation, artifacts, built bundle, and derived labels.
 * @throws If fetching the conversation itself fails (this is not swallowed).
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
