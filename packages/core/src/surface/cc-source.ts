/**
 * `cc://` source surface -- the local Claude Code session cache
 * (`~/.claude/projects/**\/*.jsonl`) expressed as a {@link SourceSurface}
 * (PRD 001 Phase 1). Read-only, no network.
 *
 * `list` plans output paths from peeked session metadata; `read` parses +
 * renders a session into a pre-rendered tree. The same builders back the
 * `claude-code` subcommand, so `cc://` -> `FileSink` is byte-identical to it.
 */

import os from "node:os";
import path from "node:path";

import {
  planSessions,
  buildSessionTree,
  type PlannedSession,
  type BuildSessionTreeOptions,
} from "../claude-code/build.js";
import type {
  CanonicalItem,
  ItemRef,
  ParsedUri,
  Selector,
  SourceSurface,
  SurfaceCaps,
} from "./types.js";

export interface CcSourceOptions extends BuildSessionTreeOptions {
  /** Claude Code home dir. Default: $CLAUDE_CODE_HOME, else ~/.claude. */
  ccHome?: string;
}

export class CcSource implements SourceSurface {
  readonly uri: ParsedUri;
  readonly caps: SurfaceCaps = {
    read: true,
    write: false,
    delete: false,
    list: true,
  };

  private readonly ccHome: string;
  private readonly byId = new Map<string, PlannedSession>();
  private planned?: PlannedSession[];

  constructor(private readonly options: CcSourceOptions = {}, uri?: ParsedUri) {
    this.ccHome =
      options.ccHome ??
      process.env.CLAUDE_CODE_HOME ??
      path.join(os.homedir(), ".claude");
    this.uri = uri ?? { scheme: "cc", host: "local", path: "/projects", query: {} };
  }

  static fromUri(uri: ParsedUri, options: CcSourceOptions = {}): CcSource {
    return new CcSource(options, uri);
  }

  async *list(selector?: Selector): AsyncIterable<ItemRef> {
    for (const p of this.all()) {
      if (selector?.conversationId && p.sessionId !== selector.conversationId) continue;
      yield this.toRef(p);
    }
  }

  async read(ref: ItemRef): Promise<CanonicalItem> {
    let p = this.byId.get(ref.id);
    if (!p) {
      this.all();
      p = this.byId.get(ref.id);
    }
    if (!p) throw new Error(`Claude Code session not found: ${ref.id}`);
    return { ref, tree: buildSessionTree(p, this.options) };
  }

  /** Cached plan -- shared across `list`/`read` so a sync peeks sessions once. */
  private all(): PlannedSession[] {
    if (!this.planned) {
      this.planned = planSessions(this.ccHome);
      for (const p of this.planned) this.byId.set(p.sessionId, p);
    }
    return this.planned;
  }

  private toRef(p: PlannedSession): ItemRef {
    return {
      id: p.sessionId,
      kind: "session",
      name: p.title ?? p.sessionId,
      updatedAt: p.updatedAt,
      currentLeafUuid: p.leafUuid,
      relPath: p.relPath,
    };
  }
}
