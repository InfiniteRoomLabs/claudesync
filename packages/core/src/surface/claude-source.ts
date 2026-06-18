/**
 * `claude://` source surface -- the claude.ai web API expressed as a
 * {@link SourceSurface}. `list` wraps the conversation listing; `read` wraps
 * `fetchAndBuild` (fetch tree + artifacts -> GitBundle). Read-only.
 */

import type { ClaudeSyncClient } from "../client/client.js";
import { fetchAndBuild } from "../sync/fetch.js";
import type { ConversationSummary } from "../models/types.js";
import type {
  CanonicalItem,
  ItemRef,
  ParsedUri,
  Selector,
  SourceSurface,
  SurfaceCaps,
} from "./types.js";

export interface ClaudeSourceOptions {
  authorName: string;
  authorEmail: string;
  skipArtifacts?: boolean;
}

export class ClaudeSource implements SourceSurface {
  readonly uri: ParsedUri;
  readonly caps: SurfaceCaps = {
    read: true,
    write: false,
    delete: false,
    list: true,
  };

  private readonly summaries = new Map<string, ConversationSummary>();
  private allCache?: ConversationSummary[];

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

  async *list(selector?: Selector): AsyncIterable<ItemRef> {
    const all = await this.all();
    for (const s of all) {
      if (selector?.conversationId && s.uuid !== selector.conversationId) continue;
      yield this.toRef(s);
    }
  }

  async read(ref: ItemRef): Promise<CanonicalItem> {
    let summary = this.summaries.get(ref.id);
    if (!summary) {
      await this.all();
      summary = this.summaries.get(ref.id);
    }
    if (!summary) throw new Error(`Conversation not found: ${ref.id}`);
    const built = await fetchAndBuild(this.client, this.orgId, summary, {
      authorName: this.options.authorName,
      authorEmail: this.options.authorEmail,
      skipArtifacts: this.options.skipArtifacts,
      multiBranch: true,
    });
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
