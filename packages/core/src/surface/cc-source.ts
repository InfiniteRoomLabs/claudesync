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

/**
 * Construction options for {@link CcSource}. Extends {@link BuildSessionTreeOptions}
 * so the same fidelity/truncation/subagent knobs that drive `buildSessionTree`
 * can be passed straight through.
 */
export interface CcSourceOptions extends BuildSessionTreeOptions {
  /** Claude Code home dir. Default: $CLAUDE_CODE_HOME, else ~/.claude. */
  ccHome?: string;
}

/**
 * Read-only {@link SourceSurface} over the local Claude Code session cache
 * (`<ccHome>/projects/**\/*.jsonl`).
 *
 * Each emitted {@link ItemRef} is a session (`kind: "session"`); {@link CcSource.read}
 * returns a {@link CanonicalItem} carrying a pre-rendered `tree`, never a `bundle`.
 * Layout planning and session-to-tree rendering are delegated to the shared
 * `planSessions` / `buildSessionTree` builders, so a `cc://` -> {@link SinkSurface}
 * sync is byte-identical to the standalone `claude-code` subcommand.
 */
export class CcSource implements SourceSurface {
  /** This source's address; defaults to `cc://local/projects` when none is supplied. */
  readonly uri: ParsedUri;
  /** Read + list only -- the local cache is never written or deleted through this surface. */
  readonly caps: SurfaceCaps = {
    read: true,
    write: false,
    delete: false,
    list: true,
  };

  /** Resolved Claude Code home directory the sessions are discovered under. */
  private readonly ccHome: string;
  /** Session id -> planned session, populated lazily by {@link CcSource.all}. */
  private readonly byId = new Map<string, PlannedSession>();
  /** Memoized plan from a single `planSessions` peek; undefined until first access. */
  private planned?: PlannedSession[];

  /**
   * @param options - Home-dir override plus tree-build knobs forwarded to `buildSessionTree`.
   * @param uri - Optional pre-parsed address; the default `cc://local/projects` is used otherwise.
   */
  constructor(private readonly options: CcSourceOptions = {}, uri?: ParsedUri) {
    this.ccHome =
      options.ccHome ??
      process.env.CLAUDE_CODE_HOME ??
      path.join(os.homedir(), ".claude");
    this.uri = uri ?? { scheme: "cc", host: "local", path: "/projects", query: {} };
  }

  /**
   * Construct a {@link CcSource} bound to an already-parsed address.
   *
   * @param uri - The `cc://` location this source represents.
   * @param options - Home-dir override plus tree-build knobs.
   * @returns A source surface reading sessions under `options.ccHome`.
   */
  static fromUri(uri: ParsedUri, options: CcSourceOptions = {}): CcSource {
    return new CcSource(options, uri);
  }

  /**
   * Enumerate every discovered session as an {@link ItemRef}.
   *
   * @param selector - When `conversationId` is set, only the matching session id is yielded.
   * @returns Session references, each carrying its planned `relPath` for sink nesting.
   */
  async *list(selector?: Selector): AsyncIterable<ItemRef> {
    for (const p of this.all()) {
      if (selector?.conversationId && p.sessionId !== selector.conversationId) continue;
      yield this.toRef(p);
    }
  }

  /**
   * Parse and render the session for `ref` into a pre-rendered tree.
   *
   * @param ref - A reference (typically from {@link CcSource.list}) identifying the session.
   * @returns A {@link CanonicalItem} whose `tree` holds the rendered session files.
   * @throws Error if no planned session matches `ref.id`.
   */
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

  /** Project a planned session into the surface-neutral {@link ItemRef} shape. */
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
