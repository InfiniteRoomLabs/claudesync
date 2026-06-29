/**
 * opencode datastore adapter (PRD 001 Phase 1.5).
 *
 * opencode stores everything in one SQLite DB: `~/.local/share/opencode/opencode.db`
 * (verified against a real ~13MB store). Relevant tables:
 *   - project(id, worktree, ...)                  -- worktree = the repo path
 *   - session(id "ses_..", project_id, slug, title, model JSON, time_created, time_updated)
 *   - message(id "msg_..", session_id, data JSON{role, ...}, time_created)
 *   - part(id "prt_..", message_id, session_id, data JSON, time_created)
 *       part.data.type: text | reasoning | tool | step-start | step-finish | file | patch | ...
 *       tool: { type:"tool", tool, callID, state:{status, input, output} }
 *
 * The DB may be live (WAL); we copy it (+ -wal/-shm) to a temp file and
 * checkpoint that disposable copy before reading, per the repo's
 * "copy the DB before querying" guidance.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AdapterListItem,
  DatastoreAdapter,
  NormalizedBlock,
  NormalizedSession,
  NormalizedTurn,
} from "../surface/datastore.js";

/** Default opencode SQLite store path: `~/.local/share/opencode/opencode.db`. */
export function defaultOpencodeDb(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

/** One joined `session` + `project` row (see {@link sessionRows}). */
interface SessionRow {
  /** Session id (`ses_...`). */
  id: string;
  /** URL-safe slug; used as a title fallback. */
  slug: string | null;
  /** Human title, or null. */
  title: string | null;
  /** Model column: a JSON blob decoded by {@link modelId}. */
  model: string | null;
  /** Creation time, epoch milliseconds. */
  time_created: number | null;
  /** Last-update time, epoch milliseconds. */
  time_updated: number | null;
  /** The project's repo path (`project.worktree`); the session's project. */
  worktree: string | null;
}
/** One `message` row; `data` is a JSON blob carrying at least `{ role }`. */
interface MessageRow {
  /** Message id (`msg_...`). */
  id: string;
  /** JSON message payload, or null. */
  data: string | null;
  /** Creation time, epoch milliseconds. */
  time_created: number | null;
}
/** One `part` row; `data` is a JSON blob whose `type` selects the block kind. */
interface PartRow {
  /** Part id (`prt_...`). */
  id: string;
  /** JSON part payload (text/reasoning/tool/...), or null. */
  data: string | null;
  /** Creation time, epoch milliseconds. */
  time_created: number | null;
}

/**
 * {@link DatastoreAdapter} for opencode's single SQLite store. Conversations live
 * across `project`/`session`/`message`/`part` tables; each read snapshots the
 * (possibly WAL-live) DB to a temp copy first via {@link OpencodeAdapter.withDb}.
 * See {@link AdapterListItem}, {@link NormalizedSession}.
 */
export class OpencodeAdapter implements DatastoreAdapter {
  /** URI scheme this adapter answers for. */
  readonly scheme = "opencode";

  /**
   * @param dbPath - Path to `opencode.db`. Defaults to {@link defaultOpencodeDb}.
   */
  constructor(private readonly dbPath: string = defaultOpencodeDb()) {}

  /** Enumerate sessions as cheap list items (one query, no per-session part scan). */
  list(): AdapterListItem[] {
    return this.withDb((db) =>
      sessionRows(db).map((s) => ({
        id: s.id,
        title: s.title ?? s.slug ?? s.id,
        project: s.worktree ?? "global",
        updatedAt: msToIso(s.time_updated ?? s.time_created),
        leafUuid: `t${s.time_updated ?? s.time_created ?? 0}`,
      }))
    );
  }

  /**
   * Load one session and materialize its turns: messages ordered by time, each
   * with its parts projected to {@link NormalizedBlock}s by {@link partBlocks}.
   * Messages that yield no blocks are dropped.
   *
   * @param id - Session id from {@link list}.
   * @returns The fully parsed session.
   * @throws If no session with `id` exists.
   */
  read(id: string): NormalizedSession {
    return this.withDb((db) => {
      const s = sessionRows(db).find((r) => r.id === id);
      if (!s) throw new Error(`opencode session not found: ${id}`);

      const messages = query<MessageRow>(
        db,
        "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created, id",
        [id]
      );

      const turns: NormalizedTurn[] = [];
      for (const m of messages) {
        const data = parseJson(m.data) as { role?: string } | null;
        const role: "human" | "assistant" = data?.role === "assistant" ? "assistant" : "human";
        const blocks = partBlocks(
          query<PartRow>(
            db,
            "SELECT id, data, time_created FROM part WHERE message_id = ? ORDER BY time_created, id",
            [m.id]
          )
        );
        if (blocks.length) {
          turns.push({ role, timestamp: msToIso(m.time_created), blocks });
        }
      }

      return {
        id: s.id,
        title: s.title ?? s.slug ?? s.id,
        model: modelId(s.model),
        createdAt: msToIso(s.time_created),
        updatedAt: msToIso(s.time_updated ?? s.time_created),
        project: s.worktree ?? "global",
        // Must match list()'s leafUuid so the orchestrator's --skip-same works.
        leafUuid: `t${s.time_updated ?? s.time_created ?? 0}`,
        turns,
      };
    });
  }

  /**
   * Run `fn` against a safe handle to the store. The live DB is copied (with any
   * `-wal`/`-shm` sidecars) to a temp file that is WAL-checkpointed before reading,
   * so a concurrently-running opencode is never touched; the temp dir is always
   * removed afterward. A missing store yields an empty in-memory DB so callers
   * behave like an empty source.
   *
   * @param fn - Receives the opened database; its return value is passed through.
   * @returns Whatever `fn` returns.
   * @typeParam T - The query result type.
   */
  private withDb<T>(fn: (db: Database.Database) => T): T {
    if (!fs.existsSync(this.dbPath)) {
      // No store -> behave like an empty source.
      return fn(new Database(":memory:"));
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-db-"));
    const dest = path.join(tmp, "opencode.db");
    try {
      fs.copyFileSync(this.dbPath, dest);
      for (const ext of ["-wal", "-shm"]) {
        if (fs.existsSync(this.dbPath + ext)) fs.copyFileSync(this.dbPath + ext, dest + ext);
      }
      const db = new Database(dest);
      try {
        db.pragma("wal_checkpoint(TRUNCATE)");
        return fn(db);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/** Query all sessions joined to their project's worktree path. */
function sessionRows(db: Database.Database): SessionRow[] {
  return query<SessionRow>(
    db,
    `SELECT s.id AS id, s.slug AS slug, s.title AS title, s.model AS model,
            s.time_created AS time_created, s.time_updated AS time_updated,
            p.worktree AS worktree
     FROM session s LEFT JOIN project p ON s.project_id = p.id`
  );
}

/**
 * Project one message's `part` rows into {@link NormalizedBlock}s. `text` (skipping
 * opencode-synthesized parts) and `reasoning` become text/thinking blocks; `tool`
 * parts become tool blocks carrying input/output and an error flag from
 * `state.status`. Other part types (step-start/-finish, file, patch, compaction)
 * are metadata and skipped.
 *
 * @param parts - Part rows for a single message, in order.
 * @returns The message's content blocks.
 */
function partBlocks(parts: PartRow[]): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = [];
  for (const p of parts) {
    const d = parseJson(p.data) as Record<string, unknown> | null;
    if (!d || typeof d.type !== "string") continue;
    switch (d.type) {
      case "text": {
        if (d.synthetic === true) break; // opencode-generated, not human/assistant authored
        const text = typeof d.text === "string" ? d.text.trim() : "";
        if (text) blocks.push({ kind: "text", text });
        break;
      }
      case "reasoning": {
        const text = typeof d.text === "string" ? d.text.trim() : "";
        if (text) blocks.push({ kind: "thinking", text });
        break;
      }
      case "tool": {
        const state = (d.state ?? {}) as Record<string, unknown>;
        const output = state.output;
        blocks.push({
          kind: "tool",
          name: typeof d.tool === "string" ? d.tool : "tool",
          id: typeof d.callID === "string" ? d.callID : undefined,
          input: state.input,
          output: typeof output === "string" ? output : output === undefined ? undefined : safeStringify(output),
          isError: state.status === "failed" || state.status === "error",
        });
        break;
      }
      // step-start / step-finish / file / patch / compaction: snapshots+metadata, skip.
    }
  }
  return blocks;
}

/**
 * Run a prepared query, returning `[]` on any error so the adapter tolerates schema
 * drift (a missing table or column does not crash the read).
 *
 * @param db - The database handle.
 * @param sql - SQL with `?` placeholders.
 * @param params - Bound parameter values.
 * @returns The rows, cast to `T`, or `[]` on failure.
 * @typeParam T - The expected row shape.
 */
function query<T>(db: Database.Database, sql: string, params: unknown[] = []): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return []; // tolerate schema drift (missing table/column)
  }
}

/** Parse a JSON column, returning null for null/empty input or invalid JSON. */
function parseJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Extract the model identifier from the session's `model` JSON blob (`id` or `modelID`). */
function modelId(model: string | null): string | null {
  const m = parseJson(model) as { id?: string; modelID?: string } | null;
  return m?.id ?? m?.modelID ?? null;
}

/** Convert epoch milliseconds to an ISO string; null/non-finite maps to the epoch. */
function msToIso(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return new Date(0).toISOString();
  return new Date(ms).toISOString();
}

/** Pretty-print a value as 2-space JSON, falling back to `String()` if it cannot serialize. */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
