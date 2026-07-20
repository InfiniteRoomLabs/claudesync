/**
 * `claude://` source surface -- the claude.ai web API expressed as a
 * {@link SourceSurface}. `list` wraps the conversation listing; `read` wraps
 * `fetchAndBuild` (fetch tree + artifacts -> GitBundle). Read-only.
 */

import type { ClaudeSyncClient } from "../client/client.js";
import { fetchAndBuild, type FetchAndBuildResult } from "../sync/fetch.js";
import type { ConversationSummary } from "../models/types.js";
import type {
  CanonicalItem,
  ItemRef,
  ParsedUri,
  Selector,
  SourceSurface,
  SurfaceCaps,
} from "./types.js";

/**
 * Construction options for {@link ClaudeSource}, forwarded into `fetchAndBuild`.
 */
export interface ClaudeSourceOptions {
  /** Commit author name stamped onto the built git history. */
  authorName: string;
  /** Commit author email stamped onto the built git history. */
  authorEmail: string;
  /** Skip the per-conversation artifact list/download pass when set. */
  skipArtifacts?: boolean;
  /**
   * When true (the default), {@link ClaudeSource.read} runs `fetchAndBuild`'s
   * `detectEmpty` check immediately after hydration and before any artifact
   * I/O: a conversation with zero human messages across its full branched
   * tree short-circuits into the {@link CanonicalItem.isEmpty} shape (see
   * {@link ClaudeSource.read}) instead of a normal bundle. Set `false` to
   * bypass this entirely -- `read` then behaves exactly as it did before this
   * option existed, always resolving to a full bundle.
   */
  skipEmpty?: boolean;
}

/**
 * Read-only {@link SourceSurface} over the claude.ai web API for one organization.
 *
 * {@link ClaudeSource.list} wraps the conversation listing; {@link ClaudeSource.read}
 * wraps `fetchAndBuild` (fetch the message tree + artifacts, assemble a `GitBundle`),
 * so every emitted {@link CanonicalItem} carries a `bundle` (plus the raw conversation,
 * artifacts, and list summary an incremental sink needs) -- unless the conversation is
 * empty and {@link ClaudeSourceOptions.skipEmpty} is in effect, in which case the item
 * carries {@link CanonicalItem.isEmpty} plus `conversation`/`summary` only. Never a
 * pre-rendered `tree` (that shape is for `cc://` and other Class D local sources).
 */
export class ClaudeSource implements SourceSurface {
  /** This source's address; defaults to `claude://me/org/<orgId>` when none is supplied. */
  readonly uri: ParsedUri;
  /** Read + list only -- claude.ai is never mutated through this surface. */
  readonly caps: SurfaceCaps = {
    read: true,
    write: false,
    delete: false,
    list: true,
  };

  /** Conversation uuid -> list summary, populated lazily by {@link ClaudeSource.all}. */
  private readonly summaries = new Map<string, ConversationSummary>();
  /** Memoized result of a single `listConversationsAll`; undefined until first access. */
  private allCache?: ConversationSummary[];

  /**
   * @param client - Authenticated claude.ai API client.
   * @param orgId - Organization whose conversations this source exposes.
   * @param options - Commit-author identity and artifact toggle for the build step.
   * @param uri - Optional pre-parsed address; the default `claude://me/org/<orgId>` is used otherwise.
   */
  constructor(
    private readonly client: ClaudeSyncClient,
    private readonly orgId: string,
    private readonly options: ClaudeSourceOptions,
    uri?: ParsedUri
  ) {
    this.uri = uri ?? {
      scheme: "claude",
      host: "me",
      path: `/org/${orgId}`,
      query: {},
    };
  }

  /**
   * Enumerate the org's conversations as {@link ItemRef}s.
   *
   * @param selector - When `conversationId` is set, only the matching conversation is yielded.
   * @returns Conversation references derived from the list endpoint.
   */
  async *list(selector?: Selector): AsyncIterable<ItemRef> {
    const all = await this.all();
    for (const s of all) {
      if (selector?.conversationId && s.uuid !== selector.conversationId) continue;
      yield this.toRef(s);
    }
  }

  /**
   * Fetch the conversation tree + artifacts for `ref` and assemble its bundle.
   *
   * Unless {@link ClaudeSourceOptions.skipEmpty} is `false`, this runs
   * `fetchAndBuild`'s `detectEmpty` check right after hydration. A
   * zero-human-message conversation short-circuits into the
   * {@link CanonicalItem.isEmpty} shape -- `conversation` and `summary` set,
   * `bundle`/`artifacts` absent -- before any artifact listing or download.
   *
   * @param ref - A reference (typically from {@link ClaudeSource.list}) identifying the conversation.
   * @returns A {@link CanonicalItem} with either `bundle`/`conversation`/`artifacts`/`summary`
   * populated (the normal case), or `isEmpty: true` plus `conversation`/`summary` only.
   * @throws Error if no list summary matches `ref.id`.
   */
  async read(ref: ItemRef): Promise<CanonicalItem> {
    let summary = this.summaries.get(ref.id);
    if (!summary) {
      await this.all();
      summary = this.summaries.get(ref.id);
    }
    if (!summary) throw new Error(`Conversation not found: ${ref.id}`);

    const baseOptions = {
      authorName: this.options.authorName,
      authorEmail: this.options.authorEmail,
      skipArtifacts: this.options.skipArtifacts,
      multiBranch: true,
    };

    if (this.options.skipEmpty ?? true) {
      const built = await fetchAndBuild(this.client, this.orgId, summary, {
        ...baseOptions,
        detectEmpty: true,
      });
      if ("empty" in built) {
        return { ref, isEmpty: true, conversation: built.conversation, summary };
      }
      return this.toCanonicalItem(ref, summary, built);
    }

    // skipEmpty: false bypasses empty detection entirely -- byte-identical to
    // the pre-existing fetch call (no detectEmpty key at all).
    const built = await fetchAndBuild(this.client, this.orgId, summary, baseOptions);
    return this.toCanonicalItem(ref, summary, built);
  }

  /** Project a full `fetchAndBuild` result into the {@link CanonicalItem} bundle shape. */
  private toCanonicalItem(
    ref: ItemRef,
    summary: ConversationSummary,
    built: FetchAndBuildResult
  ): CanonicalItem {
    return {
      ref,
      bundle: built.bundle,
      conversation: built.conversation,
      artifacts: built.artifacts,
      summary,
    };
  }

  /** Cached `listConversationsAll` -- shared across `list`/`read` so a single
   *  export performs one list call. */
  private async all(): Promise<ConversationSummary[]> {
    if (!this.allCache) {
      this.allCache = await this.client.listConversationsAll(this.orgId);
      for (const s of this.allCache) this.summaries.set(s.uuid, s);
    }
    return this.allCache;
  }

  /** Project a list summary into the surface-neutral {@link ItemRef} shape. */
  private toRef(s: ConversationSummary): ItemRef {
    return {
      id: s.uuid,
      kind: "conversation",
      name: s.name,
      updatedAt: s.updated_at,
      currentLeafUuid: s.current_leaf_message_uuid ?? null,
    };
  }
}
