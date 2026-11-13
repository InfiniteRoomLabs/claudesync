/**
 * Day-store planning for the Duet sync: which day directory each fetched
 * message is written to, and what that directory's store and sync state become.
 * Pure functions over stores already loaded from disk; `sync.ts` does the I/O.
 *
 * The invariant these helpers keep: a message id is stored in exactly one day
 * directory, forever. A stored id never moves. Only ids never seen before are
 * assigned a day, and stored days were matched to their channel by channel id
 * (see `loadDayStores`), not by name, so a rename, a time-zone change or an
 * orphan reply whose root turns up later cannot file an id twice.
 */

import type { SyncState } from "../sync/state.js";
import { compareSeq, dayDirName, localDate, UNKNOWN_DATE } from "./render.js";
import type { DuetChannel, DuetDayStore, DuetMessage } from "./types.js";

/** What one day directory receives in this run. */
export interface DayPlan {
  /** Local date of the day, `YYYY-MM-DD`; for an existing day, its stored date. */
  date: string;
  /** Zone the date was computed in; for an existing day, its stored zone. */
  timeZone: string;
  /** The day's store from earlier syncs, when the directory already has one. */
  prior?: DuetDayStore;
  /** Fetched messages to upsert into the day. */
  incoming: DuetMessage[];
}

/**
 * Order messages by numeric `seq`, then by id so the order is total.
 *
 * @param a - First message.
 * @param b - Second message.
 * @returns A comparator result for `Array.prototype.sort`.
 */
export function bySeqThenId(a: DuetMessage, b: DuetMessage): number {
  return compareSeq(a.seq, b.seq) || a.id.localeCompare(b.id);
}

/**
 * Count, per thread root, how many replies are present in a message set.
 *
 * @param messages - Messages from the API and from earlier syncs.
 * @returns Map from root id to the number of non-root messages pointing at it.
 */
export function countReplies(messages: Iterable<DuetMessage>): Map<string, number> {
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
 * Decide which day directory each fetched message goes to.
 *
 * - An id already stored is upserted in place, into every directory that
 *   already holds it. It never moves, whatever its thread root or the zone now
 *   say.
 * - A new reply whose root is stored joins the root's directory, so a late
 *   reply lands in its root's day even after a zone change.
 * - Any other new id is assigned the local date (in `timeZone`) of its thread
 *   root, or of itself when the root is unknown. The date's existing directory
 *   is reused when there is one, so a renamed channel keeps writing old dates
 *   to the old slug; only a date with no directory yet gets `<date>-<slug>`.
 *
 * @param stored - This channel's stored days, keyed by directory name.
 * @param fetched - Messages fetched in this run.
 * @param known - Stored and fetched messages by id, used to find thread roots.
 * @param slug - The channel's current slug, used only for new directories.
 * @param timeZone - Current zone, used only to date new ids and new days.
 * @returns A plan per directory that receives at least one message.
 */
export function planDays(
  stored: ReadonlyMap<string, DuetDayStore>,
  fetched: Iterable<DuetMessage>,
  known: ReadonlyMap<string, DuetMessage>,
  slug: string,
  timeZone: string
): Map<string, DayPlan> {
  /** Directories that already hold each stored id, in name order. */
  const homes = new Map<string, string[]>();
  /** The existing directory of each stored date, the first by name. */
  const dirOfDate = new Map<string, string>();
  for (const dir of [...stored.keys()].sort()) {
    const day = stored.get(dir);
    if (!day) continue;
    if (!dirOfDate.has(day.date)) dirOfDate.set(day.date, dir);
    for (const m of day.messages) {
      homes.set(m.id, [...(homes.get(m.id) ?? []), dir]);
    }
  }

  const plans = new Map<string, DayPlan>();
  const add = (dir: string, m: DuetMessage, newDate?: string): void => {
    let plan = plans.get(dir);
    if (!plan) {
      const prior = stored.get(dir);
      plan = prior
        ? { date: prior.date, timeZone: prior.time_zone, prior, incoming: [] }
        : { date: newDate ?? UNKNOWN_DATE, timeZone, incoming: [] };
      plans.set(dir, plan);
    }
    plan.incoming.push(m);
  };

  for (const m of fetched) {
    const held = homes.get(m.id);
    if (held) {
      for (const dir of held) add(dir, m);
      continue;
    }
    const rootId = m.thread_root_id ?? m.id;
    const rootHome = rootId === m.id ? undefined : homes.get(rootId)?.[0];
    if (rootHome) {
      add(rootHome, m);
      continue;
    }
    const date = localDate((known.get(rootId) ?? m).created_at, timeZone);
    add(dirOfDate.get(date) ?? dayDirName(date, slug), m, date);
  }
  return plans;
}

/**
 * The store a day directory holds after this run: its prior messages with the
 * incoming ones upserted by id (a fetched copy replaces the stored one), sorted
 * by `seq`. Nothing is ever removed.
 *
 * @param channelId - The channel the day belongs to.
 * @param plan - The day's plan from {@link planDays}.
 * @returns The new canonical store for `messages.json`.
 */
export function buildDayStore(channelId: string, plan: DayPlan): DuetDayStore {
  const merged = new Map((plan.prior?.messages ?? []).map((m) => [m.id, m]));
  for (const m of plan.incoming) merged.set(m.id, m);
  return {
    channel_id: channelId,
    date: plan.date,
    time_zone: plan.timeZone,
    messages: [...merged.values()].sort(bySeqThenId),
  };
}

/**
 * Build the `.claudesync-state.json` content for a day directory, so the
 * indexer's standard sidecar handling works on Duet days unchanged. The day is
 * modeled as a conversation whose leaf is its newest message.
 *
 * @param channel - The channel of the day.
 * @param store - The day's full store, messages sorted by `seq`.
 * @param name - Display name from `dayTitle`, so it matches the log's H1.
 * @param existed - Whether the day directory already existed.
 * @param now - Time of this sync.
 * @returns The sync state to persist.
 */
export function buildDayState(
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
