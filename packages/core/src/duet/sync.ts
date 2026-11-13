/**
 * Orchestrate a one-shot, read-only sync of Claude Duet into the corpus under
 * `<outputRoot>/duet/`, shaped as the tree `claudesync-index` consumes:
 *
 * ```
 * duet/duet.json                 project snapshot (no member lists)
 * duet/tasks.json                canonical task store
 * duet/knowledge/TASKS.md        rendered task list
 * duet/conversations/<date>-<channel-slug>/
 *   conversation.md  messages.json  README.md  .claudesync-state.json
 * ```
 *
 * `messages.json` is the canonical store of a day and channel. Every sync
 * upserts what the API returned into it by message id, then re-renders, so
 * history survives the API's 200-entry window. Days outside the fetched window
 * are never touched, and a day directory is rewritten only when its rendered
 * output would change. Built from a captured session; not yet verified live.
 */

import path from "node:path";

import { writeTreeWithPreserve } from "../sync/tree.js";
import type { SyncState } from "../sync/state.js";
import type { DuetClient } from "./client.js";
import {
  channelSlug,
  compareSeq,
  dayDirName,
  localDate,
  normalizeTimeZone,
  renderDayLog,
  renderDayReadme,
  renderTasks,
} from "./render.js";
import {
  CONVERSATION_FILENAME,
  loadDayStores,
  MESSAGES_FILENAME,
  readTaskStore,
  readTextIfExists,
  toJsonText,
  writeFileIfChanged,
} from "./store.js";
import type {
  DuetChannel,
  DuetDayStore,
  DuetMessage,
  DuetProject,
  DuetStoredTask,
} from "./types.js";

/**
 * The slice of {@link DuetClient} that sync needs. Typing the sync against this
 * instead of the class lets tests pass plain fakes with no `fetch` stubbing.
 */
export type DuetSource = Pick<
  DuetClient,
  "findProject" | "listChannels" | "getTimeline" | "getThread" | "listTasks"
>;

/** Options for {@link runDuetSync}. Only `outputRoot` is required. */
export interface RunDuetSyncOptions {
  /** Corpus root. Content is written under `<outputRoot>/duet/`. */
  outputRoot: string;
  /**
   * Globs of locally-added files to keep across day rewrites, relative to each
   * day directory. `INDEX.md` and `CHANGELOG.md` are always kept.
   */
  preserve?: string[];
  /** Entries to request per timeline, thread and task list. Default 200. */
  timelineLimit?: number;
  /** Cooperative cancellation; checked between channels and threads. */
  signal?: AbortSignal;
  /** Progress sink invoked as the run proceeds; see {@link DuetProgressEvent}. */
  onProgress?: (e: DuetProgressEvent) => void;
  /** Clock, injectable so tests get predictable timestamps. Default `new Date()`. */
  now?: () => Date;
}

/** Progress events emitted by {@link runDuetSync} via `onProgress`. */
export type DuetProgressEvent =
  /** Emitted once after the project is found, before any channel is synced. */
  | { type: "start"; channels: number }
  /** Emitted once per channel that finished without error. */
  | {
      type: "channel-done";
      channel: string;
      written: number;
      unchanged: number;
      messages: number;
    }
  /** Emitted once after the task list was synced. */
  | { type: "tasks-done"; tasks: number }
  /** Emitted when one channel, thread or the task list failed. The run continues. */
  | { type: "error"; scope: string; message: string };

/** Tally returned by {@link runDuetSync} once the run completes (or aborts). */
export interface RunDuetSyncResult {
  /** False when the account has no Duet; nothing was written in that case. */
  available: boolean;
  /** Channels planned for sync. */
  channels: number;
  /** Day directories written because their content changed. */
  daysWritten: number;
  /** Day directories left alone because nothing changed. */
  daysUnchanged: number;
  /** Distinct messages fetched from the API (timelines plus extra thread fetches). */
  messages: number;
  /** Tasks the API returned. */
  tasks: number;
  /** Channel, thread or task-list failures that were reported and skipped. */
  errors: number;
}

/**
 * Outcome of {@link runDuetSyncGuarded}. Never carries an exception: a failure
 * is data, so a caller such as `export-all` cannot be derailed by Duet.
 */
export type RunDuetSyncOutcome =
  /** The sync ran; the tally may still contain per-channel `errors`. */
  | { status: "synced"; result: RunDuetSyncResult }
  /** The account has no Duet. Not an error. */
  | { status: "unavailable"; result: RunDuetSyncResult }
  /** The sync could not run at all. `message` is safe to print on one line. */
  | { status: "failed"; message: string };

/** Everything the per-channel and per-task helpers need, resolved once per run. */
interface SyncContext {
  /** Absolute path of `<outputRoot>/duet`. */
  duetRoot: string;
  /** Absolute path of `<outputRoot>/duet/conversations`. */
  conversationsDir: string;
  /** Name of the Duet agent, for log headings and author labels. */
  agentName: string;
  /** Validated IANA zone used for day bucketing. */
  timeZone: string;
  /** Per-request entry cap. */
  limit: number;
  /** Preserve globs passed to the tree writer, with `INDEX.md` already added. */
  preserve: string[];
  /** Clock. */
  now: () => Date;
  /** Abort signal, if any. */
  signal?: AbortSignal;
  /** Progress sink. */
  onProgress: (e: DuetProgressEvent) => void;
  /** The running tally, mutated in place. */
  result: RunDuetSyncResult;
}

/** Default entries requested per list call; the observed API maximum. */
const DEFAULT_LIMIT = 200;

/**
 * Turn any thrown value into a one-line message.
 *
 * @param err - The caught value.
 * @returns The error message, or the value stringified.
 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Record a non-fatal failure: bump the tally and emit an `error` event.
 *
 * @param ctx - The run context.
 * @param scope - What failed, such as `channel Home`.
 * @param err - The caught value.
 */
function fail(ctx: SyncContext, scope: string, err: unknown): void {
  ctx.result.errors++;
  ctx.onProgress({ type: "error", scope, message: messageOf(err) });
}

/**
 * Order messages by numeric `seq`, then by id so the order is total.
 *
 * @param a - First message.
 * @param b - Second message.
 * @returns A comparator result for `Array.prototype.sort`.
 */
function bySeqThenId(a: DuetMessage, b: DuetMessage): number {
  return compareSeq(a.seq, b.seq) || a.id.localeCompare(b.id);
}

/**
 * Count, per thread root, how many replies are present in a message set.
 *
 * @param messages - Messages from the API and from earlier syncs.
 * @returns Map from root id to the number of non-root messages pointing at it.
 */
function countReplies(messages: Iterable<DuetMessage>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of messages) {
    const rootId = m.thread_root_id ?? m.id;
    if (rootId !== m.id) {
      counts.set(rootId, (counts.get(rootId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Build the `.claudesync-state.json` content for a day directory, so the
 * indexer's standard sidecar handling works on Duet days unchanged. The day is
 * modeled as a conversation whose leaf is its newest message.
 *
 * @param channel - The channel of the day.
 * @param store - The day's full store, messages sorted by `seq`.
 * @param name - Display name, matching the log's H1.
 * @param existed - Whether the day directory already existed.
 * @param now - Time of this sync.
 * @returns The sync state to persist.
 */
function buildDayState(
  channel: DuetChannel,
  store: DuetDayStore,
  name: string,
  existed: boolean,
  now: Date
): SyncState {
  const last = store.messages[store.messages.length - 1];
  const newest = store.messages.reduce(
    (max, m) => (m.created_at > max ? m.created_at : max),
    store.messages[0]?.created_at ?? ""
  );
  return {
    schema_version: 1,
    conversation_uuid: `${channel.id}:${store.date}`,
    conversation_name: name,
    model: null,
    updated_at: newest,
    current_leaf_message_uuid: last?.id ?? null,
    leaves: last ? [{ uuid: last.id, last_message_index: store.messages.length - 1 }] : [],
    artifacts: [],
    last_sync_at: now.toISOString(),
    last_sync_action: existed ? "incremental" : "full",
  };
}

/**
 * Sync one channel: fetch its timeline, complete incomplete threads, upsert the
 * result into the per-day stores and rewrite the days whose output changed.
 *
 * Thread completion fetches a thread when its root reports more replies than are
 * known (fetched now or stored earlier), or when a reply's root is unknown, so a
 * reply is filed under its root's day rather than its own. A failed thread fetch
 * is reported and skipped; the reply is then filed under its own day.
 *
 * @param duet - API source.
 * @param channel - The channel to sync.
 * @param ctx - The run context.
 * @returns Counts for the `channel-done` event.
 * @throws {@link Error} on a timeline failure or an unreadable stored day; the
 * caller reports it and moves to the next channel.
 */
async function syncChannel(
  duet: DuetSource,
  channel: DuetChannel,
  ctx: SyncContext
): Promise<{ written: number; unchanged: number; messages: number }> {
  const slug = channelSlug(channel.name, channel.id);
  const channelName = channel.name || channel.id;
  const stored = loadDayStores(ctx.conversationsDir, slug);

  /** Every message stored by earlier syncs, by id. */
  const index = new Map<string, DuetMessage>();
  for (const day of stored.values()) {
    for (const m of day.messages) index.set(m.id, m);
  }

  /** Messages the API returned during this run, by id. */
  const fetched = new Map<string, DuetMessage>();
  for (const m of (await duet.getTimeline(channel.id, { limit: ctx.limit })).data) {
    fetched.set(m.id, m);
  }

  /** Stored plus fetched, fetched winning; used to find roots and reply counts. */
  const known = new Map([...index, ...fetched]);
  const replyCounts = countReplies(known.values());
  const threadsToFetch = new Set<string>();
  for (const m of fetched.values()) {
    const rootId = m.thread_root_id ?? m.id;
    if (rootId !== m.id) {
      if (!known.has(rootId)) threadsToFetch.add(rootId);
    } else if ((m.reply_count ?? 0) > (replyCounts.get(m.id) ?? 0)) {
      threadsToFetch.add(m.id);
    }
  }
  for (const rootId of threadsToFetch) {
    if (ctx.signal?.aborted) break;
    try {
      for (const m of (await duet.getThread(channel.id, rootId, { limit: ctx.limit })).data) {
        fetched.set(m.id, m);
        known.set(m.id, m);
      }
    } catch (err) {
      fail(ctx, `thread ${rootId} in ${channelName}`, err);
    }
  }

  /** Fetched messages grouped by the local date of their thread root. */
  const byDate = new Map<string, DuetMessage[]>();
  for (const m of fetched.values()) {
    const root = known.get(m.thread_root_id ?? m.id) ?? m;
    const date = localDate(root.created_at, ctx.timeZone);
    byDate.set(date, [...(byDate.get(date) ?? []), m]);
  }

  let written = 0;
  let unchanged = 0;
  for (const date of [...byDate.keys()].sort()) {
    const dirName = dayDirName(date, slug);
    const dir = path.join(ctx.conversationsDir, dirName);
    const prior = stored.get(dirName);

    const merged = new Map((prior?.messages ?? []).map((m) => [m.id, m]));
    for (const m of byDate.get(date) ?? []) merged.set(m.id, m);
    const store: DuetDayStore = {
      channel_id: channel.id,
      date,
      time_zone: ctx.timeZone,
      messages: [...merged.values()].sort(bySeqThenId),
    };

    const render = {
      agentName: ctx.agentName,
      channelName,
      date,
      timeZone: ctx.timeZone,
      messages: store.messages,
    };
    const messagesText = toJsonText(store);
    const logText = renderDayLog(render);
    if (
      readTextIfExists(path.join(dir, MESSAGES_FILENAME)) === messagesText &&
      readTextIfExists(path.join(dir, CONVERSATION_FILENAME)) === logText
    ) {
      unchanged++;
      continue;
    }

    await writeTreeWithPreserve(
      dir,
      {
        files: new Map([
          [CONVERSATION_FILENAME, logText],
          [MESSAGES_FILENAME, messagesText],
          ["README.md", renderDayReadme(render)],
        ]),
        state: buildDayState(
          channel,
          store,
          `${ctx.agentName} -- ${channelName} -- ${date}`,
          prior !== undefined,
          ctx.now()
        ),
      },
      ctx.preserve
    );
    written++;
  }
  return { written, unchanged, messages: fetched.size };
}

/**
 * Sync the project channel's tasks into `tasks.json` and `knowledge/TASKS.md`.
 *
 * Every returned task is upserted with `present: true`; stored tasks the API no
 * longer returns are kept with `present: false`. Entries are written in id
 * order so the files are deterministic.
 *
 * @param duet - API source.
 * @param channelId - The project's own channel.
 * @param ctx - The run context.
 * @returns How many tasks the API returned.
 * @throws {@link Error} on a request failure or an unreadable `tasks.json`.
 */
async function syncTasks(
  duet: DuetSource,
  channelId: string,
  ctx: SyncContext
): Promise<number> {
  const response = await duet.listTasks(channelId, { limit: ctx.limit });
  const file = path.join(ctx.duetRoot, "tasks.json");
  const prior = readTaskStore(file).tasks;
  const nowIso = ctx.now().toISOString();

  const next: Record<string, DuetStoredTask> = {};
  const returned = new Set<string>();
  for (const t of response.tasks) {
    returned.add(t.id);
    next[t.id] = {
      task: t,
      first_seen_at: prior[t.id]?.first_seen_at ?? nowIso,
      last_seen_at: nowIso,
      present: true,
    };
  }
  for (const [id, entry] of Object.entries(prior)) {
    if (!returned.has(id)) next[id] = { ...entry, present: false };
  }
  const sorted = Object.fromEntries(
    Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );

  writeFileIfChanged(file, toJsonText({ tasks: sorted }));
  writeFileIfChanged(
    path.join(ctx.duetRoot, "knowledge", "TASKS.md"),
    renderTasks(Object.values(sorted))
  );
  return response.tasks.length;
}

/**
 * Build the `duet.json` project snapshot: agent settings, routine state and the
 * channel list. Channels are reduced to id and name, so member lists and other
 * account identifiers never reach the corpus. Contains no timestamps, so it is
 * rewritten only when the project actually changes.
 *
 * @param project - The Duet project.
 * @param channels - Channels being synced.
 * @returns The JSON-serializable snapshot.
 */
function buildProjectSnapshot(
  project: DuetProject,
  channels: readonly DuetChannel[]
): Record<string, unknown> {
  const s = project.settings;
  return {
    agent_name: s?.agent_name ?? null,
    purpose: s?.purpose ?? null,
    time_zone: s?.time_zone ?? null,
    language: s?.language ?? null,
    quiet_hours: s?.quiet_hours ?? null,
    routine_switches: project.routine_switches ?? null,
    routines_paused: project.routines_paused ?? null,
    project_channel_id: project.channel?.id ?? null,
    channels: channels.map((c) => ({ id: c.id, name: c.name ?? null })),
  };
}

/**
 * Sync Claude Duet into the corpus. Read-only against Duet; never edits or
 * deletes anything there.
 *
 * Finds the project first. A missing project (404/403 from the API, or no
 * channel) means the account has no Duet, and the function returns
 * `available: false` having written nothing. Otherwise it snapshots the project,
 * syncs every joined channel (plus the project channel if the list omitted it),
 * then the task list. A failure in one channel, thread or the task list is
 * reported through `onProgress`, counted in `errors`, and does not stop the rest.
 *
 * @param duet - API source, normally a {@link DuetClient}.
 * @param opts - Output root plus preserve, limit, abort, progress and clock options.
 * @returns The run tally (returned early, partially filled, if `opts.signal` aborts).
 * @throws {@link Error} when the project lookup itself fails or the output
 * cannot be written. Use {@link runDuetSyncGuarded} to turn that into a value.
 */
export async function runDuetSync(
  duet: DuetSource,
  opts: RunDuetSyncOptions
): Promise<RunDuetSyncResult> {
  const result: RunDuetSyncResult = {
    available: false,
    channels: 0,
    daysWritten: 0,
    daysUnchanged: 0,
    messages: 0,
    tasks: 0,
    errors: 0,
  };

  const project = await duet.findProject();
  const projectChannel = project?.channel;
  if (!project || !projectChannel?.id) {
    return result;
  }
  result.available = true;

  const channels = [...(await duet.listChannels())];
  if (!channels.some((c) => c.id === projectChannel.id)) {
    channels.unshift(projectChannel);
  }
  result.channels = channels.length;

  const duetRoot = path.join(opts.outputRoot, "duet");
  const ctx: SyncContext = {
    duetRoot,
    conversationsDir: path.join(duetRoot, "conversations"),
    agentName: project.settings?.agent_name || "Duet",
    timeZone: normalizeTimeZone(project.settings?.time_zone),
    limit: opts.timelineLimit ?? DEFAULT_LIMIT,
    preserve: [...(opts.preserve ?? []), "INDEX.md"],
    now: opts.now ?? (() => new Date()),
    signal: opts.signal,
    onProgress: opts.onProgress ?? (() => {}),
    result,
  };

  writeFileIfChanged(
    path.join(duetRoot, "duet.json"),
    toJsonText(buildProjectSnapshot(project, channels))
  );
  ctx.onProgress({ type: "start", channels: channels.length });

  for (const channel of channels) {
    if (ctx.signal?.aborted) return result;
    try {
      const done = await syncChannel(duet, channel, ctx);
      result.daysWritten += done.written;
      result.daysUnchanged += done.unchanged;
      result.messages += done.messages;
      ctx.onProgress({ type: "channel-done", channel: channel.name || channel.id, ...done });
    } catch (err) {
      fail(ctx, `channel ${channel.name || channel.id}`, err);
    }
  }

  if (ctx.signal?.aborted) return result;
  try {
    result.tasks = await syncTasks(duet, projectChannel.id, ctx);
    ctx.onProgress({ type: "tasks-done", tasks: result.tasks });
  } catch (err) {
    fail(ctx, "tasks", err);
  }
  return result;
}

/**
 * {@link runDuetSync} that never throws.
 *
 * This is what `export-all` calls: Duet is an add-on to the export, so no Duet
 * problem (a changed API, a rejected header, a rate limit, a disk error) may
 * fail or stop the conversation export around it.
 *
 * @param duet - API source, normally a {@link DuetClient}.
 * @param opts - Options forwarded to {@link runDuetSync}.
 * @returns `synced`, `unavailable` (no Duet on the account), or `failed` with a
 * one-line message.
 */
export async function runDuetSyncGuarded(
  duet: DuetSource,
  opts: RunDuetSyncOptions
): Promise<RunDuetSyncOutcome> {
  try {
    const result = await runDuetSync(duet, opts);
    return { status: result.available ? "synced" : "unavailable", result };
  } catch (err) {
    return { status: "failed", message: messageOf(err) };
  }
}
