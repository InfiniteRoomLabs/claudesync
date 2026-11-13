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

import { RateLimitError } from "../client/errors.js";
import { writeTreeWithPreserve } from "../sync/tree.js";
import type { DuetClient } from "./client.js";
import { buildDayState, buildDayStore, countReplies, planDays } from "./days.js";
import {
  channelSlug,
  dayTitle,
  normalizeTimeZone,
  renderDayLog,
  renderDayReadme,
  renderTasks,
} from "./render.js";
import {
  CONVERSATION_FILENAME,
  hasDayStore,
  loadDayStores,
  MESSAGES_FILENAME,
  readTaskStore,
  readTextIfExists,
  toJsonText,
  writeFileIfChanged,
} from "./store.js";
import type { DuetChannel, DuetMessage, DuetProject, DuetStoredTask } from "./types.js";

/**
 * The slice of {@link DuetClient} that sync needs. Typing the sync against this
 * instead of the class lets tests pass plain fakes with no `fetch` stubbing.
 */
export type DuetSource = Pick<
  DuetClient,
  "lookupProject" | "listChannels" | "getTimeline" | "getThread" | "listTasks"
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
  /**
   * Emitted when one channel, thread or the task list failed, or when the API
   * returned malformed entries that were skipped. The run continues.
   */
  | {
      type: "error";
      /** What it concerns, such as `channel Home`, `thread <id> in Home` or `tasks`. */
      scope: string;
      /** The raw error text. It may span lines; flatten it to print it on one. */
      message: string;
    };

/** Tally returned by {@link runDuetSync} once the run completes (or aborts). */
export interface RunDuetSyncResult {
  /**
   * False when there is nothing to sync: the project lookup was refused, or the
   * project has no channel. Nothing was written in that case.
   */
  available: boolean;
  /**
   * HTTP status (403 or 404) of a refused project lookup. Set only when
   * `available` is false because of the refusal. The status cannot tell "no
   * Duet on this account" from a rejected request, so callers should say both.
   */
  refusedStatus?: number;
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
  /**
   * Malformed messages and tasks the API returned that were skipped. Each list
   * that had any is also reported as one `error` event.
   */
  invalid: number;
  /** Failures and skipped malformed entries, each reported as an `error` event. */
  errors: number;
}

/**
 * Outcome of {@link runDuetSyncGuarded}. Never carries an exception: a failure
 * is data, so a caller such as `export-all` cannot be derailed by Duet.
 */
export type RunDuetSyncOutcome =
  /** The sync ran; the tally may still contain per-channel `errors`. */
  | { status: "synced"; result: RunDuetSyncResult }
  /**
   * Nothing to sync: no Duet on the account, or the project lookup was refused
   * (`result.refusedStatus` then holds the HTTP status). Not an error.
   */
  | { status: "unavailable"; result: RunDuetSyncResult }
  /**
   * The sync could not run at all, or a rate limit ended it. `message` is the
   * raw error text and may span lines; flatten it to print it on one.
   */
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
 * Turn any thrown value into its message text (which may span lines).
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
 * Record list entries the client dropped as malformed: add them to the
 * `invalid` tally and report them as one `error` event.
 *
 * @param ctx - The run context.
 * @param scope - The list they came from, such as `channel Home` or `tasks`.
 * @param count - The response's `invalidItems`; nothing happens when absent or 0.
 */
function noteInvalid(ctx: SyncContext, scope: string, count: number | undefined): void {
  if (!count) return;
  ctx.result.invalid += count;
  fail(ctx, scope, `skipped ${count} malformed ${count === 1 ? "entry" : "entries"} the API returned`);
}

/**
 * Sync one channel: fetch its timeline, complete incomplete threads, upsert the
 * result into the per-day stores and rewrite the days whose output changed.
 *
 * Thread completion fetches a thread when its root reports more replies than are
 * known (fetched now or stored earlier), or when a reply's root is unknown, so a
 * new reply is filed under its root's day rather than its own. A failed thread
 * fetch is reported and skipped; the reply is then filed under its own day, and
 * stays there for good once stored (see {@link planDays}).
 *
 * @param duet - API source.
 * @param channel - The channel to sync.
 * @param ctx - The run context.
 * @returns Counts for the `channel-done` event.
 * @throws {@link RateLimitError} from a timeline or thread request, so the run
 * ends instead of waiting out the shared limiter's pause.
 * @throws {@link Error} on any other timeline failure or an unreadable stored
 * day; the caller reports it and moves to the next channel.
 */
async function syncChannel(
  duet: DuetSource,
  channel: DuetChannel,
  ctx: SyncContext
): Promise<{ written: number; unchanged: number; messages: number }> {
  const channelName = channel.name || channel.id;
  const stored = loadDayStores(ctx.conversationsDir, channel.id);

  /** Messages the API returned during this run, by id. */
  const fetched = new Map<string, DuetMessage>();
  const timeline = await duet.getTimeline(channel.id, { limit: ctx.limit });
  noteInvalid(ctx, `channel ${channelName}`, timeline.invalidItems);
  for (const m of timeline.data) fetched.set(m.id, m);

  /** Stored plus fetched, fetched winning; used to find roots and reply counts. */
  const known = new Map<string, DuetMessage>();
  for (const day of stored.values()) {
    for (const m of day.messages) known.set(m.id, m);
  }
  for (const m of fetched.values()) known.set(m.id, m);
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
    const scope = `thread ${rootId} in ${channelName}`;
    try {
      const thread = await duet.getThread(channel.id, rootId, { limit: ctx.limit });
      noteInvalid(ctx, scope, thread.invalidItems);
      for (const m of thread.data) {
        fetched.set(m.id, m);
        known.set(m.id, m);
      }
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      fail(ctx, scope, err);
    }
  }

  const plans = planDays(
    stored,
    fetched.values(),
    known,
    channelSlug(channel.name, channel.id),
    ctx.timeZone
  );
  let written = 0;
  let unchanged = 0;
  for (const dirName of [...plans.keys()].sort()) {
    const plan = plans.get(dirName);
    if (!plan) continue;
    const dir = path.join(ctx.conversationsDir, dirName);
    if (!plan.prior && hasDayStore(dir)) {
      // Another channel with the same name slug and id tail owns this name.
      fail(
        ctx,
        `channel ${channelName}`,
        `${dirName} already holds another channel's messages; not overwriting it`
      );
      continue;
    }
    const store = buildDayStore(channel.id, plan);
    const render = {
      agentName: ctx.agentName,
      channelName,
      date: store.date,
      timeZone: store.time_zone,
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
        // messages.json first: if a crash cuts the write short, the store lands
        // before the files rendered from it.
        files: new Map([
          [MESSAGES_FILENAME, messagesText],
          [CONVERSATION_FILENAME, logText],
          ["README.md", renderDayReadme(render)],
        ]),
        state: buildDayState(channel, store, dayTitle(render), plan.prior !== undefined, ctx.now()),
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
 * longer returns are kept with `present: false`. An entry's `last_seen_at`
 * moves only when the sync changes the entry (a new task, a new version of it,
 * or a flip of `present`), so unchanged data rewrites nothing. Entries are
 * written in id order so the files are deterministic, and are kept in a Map so
 * an id such as `__proto__` is an ordinary key.
 *
 * @param duet - API source.
 * @param channelId - The project's own channel.
 * @param ctx - The run context.
 * @returns How many tasks the API returned (malformed ones excluded).
 * @throws {@link Error} on a request failure or an unreadable `tasks.json`.
 */
async function syncTasks(
  duet: DuetSource,
  channelId: string,
  ctx: SyncContext
): Promise<number> {
  const response = await duet.listTasks(channelId, { limit: ctx.limit });
  noteInvalid(ctx, "tasks", response.invalidItems);
  const file = path.join(ctx.duetRoot, "tasks.json");
  const prior = readTaskStore(file);
  const nowIso = ctx.now().toISOString();

  const next = new Map<string, DuetStoredTask>();
  for (const t of response.tasks) {
    const before = prior.get(t.id);
    const same = before?.present === true && toJsonText(before.task) === toJsonText(t);
    next.set(t.id, {
      task: t,
      first_seen_at: before?.first_seen_at ?? nowIso,
      last_seen_at: same && before ? before.last_seen_at : nowIso,
      present: true,
    });
  }
  for (const [id, entry] of prior) {
    if (!next.has(id)) {
      next.set(id, entry.present ? { ...entry, last_seen_at: nowIso, present: false } : entry);
    }
  }
  const sorted = [...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  writeFileIfChanged(file, toJsonText({ tasks: Object.fromEntries(sorted) }));
  writeFileIfChanged(
    path.join(ctx.duetRoot, "knowledge", "TASKS.md"),
    renderTasks(sorted.map(([, entry]) => entry))
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
 * Finds the project first. A refused lookup (404/403 from the API, whose
 * status is kept in `refusedStatus`) or a project with no channel means there
 * is nothing to sync, and the function returns `available: false` having
 * written nothing. Otherwise it snapshots the project, syncs every joined
 * channel (plus the project channel if the list omitted it), then the task
 * list. A failure in one channel, thread or the task list is reported through
 * `onProgress`, counted in `errors`, and does not stop the rest. A rate limit
 * is the exception: it ends the run, because every later request would only
 * wait out the shared limiter's pause.
 *
 * @param duet - API source, normally a {@link DuetClient}.
 * @param opts - Output root plus preserve, limit, abort, progress and clock options.
 * @returns The run tally (returned early, partially filled, if `opts.signal` aborts).
 * @throws {@link RateLimitError} when a timeline or thread request is rate limited.
 * @throws {@link Error} when the project lookup itself fails (including the
 * server creating a project on a find-only request) or the output cannot be
 * written. Use {@link runDuetSyncGuarded} to turn any of these into a value.
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
    invalid: 0,
    errors: 0,
  };

  const lookup = await duet.lookupProject();
  if (lookup.project === null) {
    result.refusedStatus = lookup.status;
    return result;
  }
  const project = lookup.project;
  const projectChannel = project.channel;
  if (!projectChannel?.id) {
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
      if (err instanceof RateLimitError) throw err;
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
 * @returns `synced`, `unavailable` (no Duet on the account, or a refused
 * lookup), or `failed` with the error's message.
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
