import type { ClaudeSyncClient } from "../client/client.js";
import type {
  ArtifactListResponse,
  Conversation,
  ConversationSummary,
} from "../models/types.js";
import { buildGitBundle } from "../export/bundle-builder.js";
import type { GitBundle } from "../export/types.js";
import { safeSlug, displayName } from "../util/naming.js";
import { isEmptyConversation } from "./empty.js";

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
  /**
   * When true, run {@link isEmptyConversation} on the conversation immediately
   * after `getConversation` hydrates it -- before any artifact listing or
   * download, and before the bundle is built. If the conversation has zero
   * human messages across its full branched tree, the call short-circuits
   * into a {@link FetchAndBuildEmpty} result instead of proceeding.
   *
   * Defaults to `false`/unset, which keeps behavior byte-identical to before
   * this option existed: every call always resolves to a full
   * {@link FetchAndBuildResult}. Pass the literal `true` (not a variable typed
   * merely as `boolean`) to get the widened return-type overload below.
   */
  detectEmpty?: boolean;
}

/**
 * Early-exit result from {@link fetchAndBuild} when `options.detectEmpty` is
 * set and {@link isEmptyConversation} found a zero-human-message conversation.
 *
 * @remarks
 * Hydration via `getConversation` already happened -- {@link conversation} is
 * the real fetched tree -- but no artifacts were listed or downloaded and no
 * {@link GitBundle} was built. Callers distinguish this shape from a normal
 * {@link FetchAndBuildResult} either by the `empty: true` discriminant or via
 * `"empty" in result`, since `FetchAndBuildResult` never declares an `empty`
 * property at all.
 */
export interface FetchAndBuildEmpty {
  /** Discriminant: always `true` on this shape. */
  empty: true;
  /** The hydrated conversation that was found to have zero human messages. */
  conversation: Conversation;
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
 * Overload selected when {@link FetchAndBuildOptions.detectEmpty} is the
 * literal `true`. The call may short-circuit into a {@link FetchAndBuildEmpty}
 * early exit before any artifact I/O, so the return type reflects both
 * possible outcomes; narrow with `"empty" in result`.
 *
 * @param client - Authenticated claude.ai API client.
 * @param orgId - Organization uuid that owns the conversation.
 * @param summary - Conversation summary providing its uuid and name.
 * @param options - Author identity and fetch/build toggles, with `detectEmpty: true`.
 * @returns Either the early-exit {@link FetchAndBuildEmpty} shape, or a full
 * {@link FetchAndBuildResult} when the conversation was not empty.
 * @throws If fetching the conversation itself fails (this is not swallowed).
 */
export async function fetchAndBuild(
  client: ClaudeSyncClient,
  orgId: string,
  summary: ConversationSummary,
  options: FetchAndBuildOptions & { detectEmpty: true }
): Promise<FetchAndBuildResult | FetchAndBuildEmpty>;
/**
 * Overload selected whenever {@link FetchAndBuildOptions.detectEmpty} is
 * omitted or not the literal `true`. Byte-identical to this function's
 * behavior before `detectEmpty` existed: always resolves to a full
 * {@link FetchAndBuildResult}, never short-circuits.
 *
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
): Promise<FetchAndBuildResult>;
/**
 * Implementation shared by both overloads above; see their doc comments for
 * the observable contract each guarantees.
 *
 * @param client - Authenticated claude.ai API client.
 * @param orgId - Organization uuid that owns the conversation.
 * @param summary - Conversation summary providing its uuid and name.
 * @param options - Author identity and fetch/build toggles.
 * @returns A {@link FetchAndBuildEmpty} early exit when `detectEmpty` is true
 * and the conversation is empty, otherwise a full {@link FetchAndBuildResult}.
 * @throws If fetching the conversation itself fails (this is not swallowed).
 */
export async function fetchAndBuild(
  client: ClaudeSyncClient,
  orgId: string,
  summary: ConversationSummary,
  options: FetchAndBuildOptions
): Promise<FetchAndBuildResult | FetchAndBuildEmpty> {
  const conversation = await client.getConversation(orgId, summary.uuid, {
    tree: true,
  });

  if (options.detectEmpty && isEmptyConversation(conversation)) {
    return { empty: true, conversation };
  }

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
