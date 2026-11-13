import { slugify } from "../util/naming.js";
import type { DuetMessage, DuetStoredTask, DuetTask } from "./types.js";

/** Time zone used whenever the Duet settings supply none, or an invalid one. */
const FALLBACK_TIME_ZONE = "UTC";

/** Text shown for a timestamp that cannot be parsed into a date. */
const UNKNOWN_DATE = "unknown-date";

/** Cache of `Intl.DateTimeFormat` instances by zone; constructing one is costly. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Return a formatter that splits an instant into zone-local date and time
 * parts. `hourCycle: "h23"` keeps midnight at `00` instead of `24`.
 *
 * @param timeZone - A valid IANA zone, already passed through {@link normalizeTimeZone}.
 * @returns A cached formatter for the zone.
 */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Validate an IANA time zone name.
 *
 * @param timeZone - Zone from the Duet settings; may be missing or invalid.
 * @returns The zone when `Intl` accepts it, otherwise `"UTC"`.
 */
export function normalizeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) {
    return FALLBACK_TIME_ZONE;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/**
 * Split an ISO timestamp into zone-local date and time strings.
 *
 * @param iso - ISO 8601 timestamp.
 * @param timeZone - Zone to express it in; normalized via {@link normalizeTimeZone}.
 * @returns `{ date: "YYYY-MM-DD", time: "HH:MM" }`, or `undefined` when `iso`
 * is not a parseable instant.
 */
function zonedParts(
  iso: string,
  timeZone: string | null | undefined
): { date: string; time: string } | undefined {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    return undefined;
  }
  const parts: Record<string, string> = {};
  for (const part of formatterFor(normalizeTimeZone(timeZone)).formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
  };
}

/**
 * Local calendar date of an instant.
 *
 * Used to bucket messages into day directories. An unparseable timestamp falls
 * back to its leading `YYYY-MM-DD` text, or to `unknown-date`, so a malformed
 * message is still stored rather than aborting the sync.
 *
 * @param iso - ISO 8601 timestamp.
 * @param timeZone - IANA zone; missing or invalid falls back to UTC.
 * @returns The date as `YYYY-MM-DD`.
 */
export function localDate(iso: string, timeZone?: string | null): string {
  const parts = zonedParts(iso, timeZone);
  if (parts) {
    return parts.date;
  }
  const lead = /^\d{4}-\d{2}-\d{2}/.exec(iso);
  return lead ? lead[0] : UNKNOWN_DATE;
}

/**
 * Local wall-clock time of an instant, for message headings.
 *
 * @param iso - ISO 8601 timestamp.
 * @param timeZone - IANA zone; missing or invalid falls back to UTC.
 * @returns The time as `HH:MM`, or `00:00` for an unparseable timestamp.
 */
export function localTime(iso: string, timeZone?: string | null): string {
  return zonedParts(iso, timeZone)?.time ?? "00:00";
}

/**
 * Filesystem-safe channel slug: the slugified name plus the last 6 characters
 * of the channel id, so renames and duplicate names cannot collide.
 *
 * @param name - Channel name; null, empty or all-symbol names become `channel`.
 * @param id - Channel id. Its tail is kept verbatim except that any character
 * outside `A-Za-z0-9_-` becomes `-`.
 * @returns A slug such as `home-000000`.
 */
export function channelSlug(name: string | null | undefined, id: string): string {
  const tail = id.slice(-6).replace(/[^A-Za-z0-9_-]/g, "-");
  return `${slugify(name) || "channel"}-${tail}`;
}

/**
 * Name of a day directory under `duet/conversations/`.
 *
 * @param date - Local date, `YYYY-MM-DD`.
 * @param slug - Channel slug from {@link channelSlug}.
 * @returns `<date>-<slug>`.
 */
export function dayDirName(date: string, slug: string): string {
  return `${date}-${slug}`;
}

/**
 * Order two `seq` values numerically. Sequence numbers are decimal strings of
 * unknown width, so they are compared as digit strings (length, then
 * lexicographic, after stripping leading zeros) instead of through `Number`,
 * which would lose precision on large values. Non-numeric values sort after
 * numeric ones, then lexicographically, so the order is always total.
 *
 * @param a - First sequence value.
 * @param b - Second sequence value.
 * @returns Negative, zero or positive, usable directly with `Array.prototype.sort`.
 */
export function compareSeq(a: string | number, b: string | number): number {
  const left = String(a);
  const right = String(b);
  const numeric = /^\d+$/;
  const leftNumeric = numeric.test(left);
  const rightNumeric = numeric.test(right);
  if (leftNumeric && rightNumeric) {
    const l = left.replace(/^0+(?=\d)/, "");
    const r = right.replace(/^0+(?=\d)/, "");
    if (l.length !== r.length) {
      return l.length - r.length;
    }
    return l < r ? -1 : l > r ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Human label for a message's author.
 *
 * @param message - The message.
 * @param agentName - Name of the Duet agent, used for agent-authored messages.
 * @returns `display_name` when present, else `You` for the account, the agent
 * name for the agent, `Routine` for a routine, or `Unknown`.
 */
export function authorLabel(message: DuetMessage, agentName: string): string {
  if (message.display_name) {
    return message.display_name;
  }
  if (message.author_account_id) {
    return "You";
  }
  if (message.author_agent_id) {
    return agentName;
  }
  if (message.author_routine_id) {
    return "Routine";
  }
  return "Unknown";
}

/** Input shared by {@link renderDayLog} and {@link renderDayReadme}. */
export interface DuetDayRenderInput {
  /** Name of the Duet agent; labels its messages and heads the log. */
  agentName: string;
  /** Channel name shown in the heading. */
  channelName: string;
  /** Local date of the day, `YYYY-MM-DD`. */
  date: string;
  /** IANA zone the message times are shown in. */
  timeZone: string;
  /** Every message of the day, in any order. */
  messages: readonly DuetMessage[];
}

/** A root message with the replies that belong under it, both sorted by `seq`. */
interface DuetThreadGroup {
  /** The thread root, or a reply whose root is not in this day's store. */
  root: DuetMessage;
  /** Replies to `root`, oldest first. */
  replies: DuetMessage[];
}

/**
 * Group a day's messages into threads.
 *
 * A message is a root when it is its own thread root, has no thread root, or
 * its root is not among `messages` (an orphan reply is shown as a root rather
 * than dropped). Roots and replies are each sorted by {@link compareSeq}.
 *
 * @param messages - A day's messages, in any order.
 * @returns Thread groups, oldest root first.
 */
function groupThreads(messages: readonly DuetMessage[]): DuetThreadGroup[] {
  const ids = new Set(messages.map((m) => m.id));
  const bySeq = (a: DuetMessage, b: DuetMessage) => compareSeq(a.seq, b.seq);
  const groups = new Map<string, DuetThreadGroup>();
  const replies: DuetMessage[] = [];
  for (const m of messages) {
    const rootId = m.thread_root_id ?? m.id;
    if (rootId === m.id || !ids.has(rootId)) {
      groups.set(m.id, { root: m, replies: [] });
    } else {
      replies.push(m);
    }
  }
  for (const reply of [...replies].sort(bySeq)) {
    const group = groups.get(reply.thread_root_id as string);
    if (group) {
      group.replies.push(reply);
    } else {
      // Its "root" is itself a reply (threads are expected to be flat); show it
      // as a root rather than dropping it from the log.
      groups.set(reply.id, { root: reply, replies: [] });
    }
  }
  return [...groups.values()].sort((a, b) => bySeq(a.root, b.root));
}

/**
 * Render a day's messages as the `conversation.md` log.
 *
 * Starts with `# <agent> -- <channel> -- <date>`, then each root as
 * `## <HH:MM> <author>` and each reply as `### <HH:MM> <author>` under its
 * root. Bodies are written verbatim. The output is a pure function of its
 * input, which is what lets a re-sync detect "nothing changed".
 *
 * @param input - Names, date, zone and messages; see {@link DuetDayRenderInput}.
 * @returns Markdown ending in a single newline.
 */
export function renderDayLog(input: DuetDayRenderInput): string {
  const blocks = [`# ${input.agentName} -- ${input.channelName} -- ${input.date}`];
  const entry = (level: string, m: DuetMessage): void => {
    blocks.push(
      `${level} ${localTime(m.created_at, input.timeZone)} ${authorLabel(m, input.agentName)}`,
      m.body
    );
  };
  for (const group of groupThreads(input.messages)) {
    entry("##", group.root);
    for (const reply of group.replies) {
      entry("###", reply);
    }
  }
  return blocks.join("\n\n") + "\n";
}

/**
 * Render the one-paragraph `README.md` header of a day directory.
 *
 * @param input - Names, date, zone and messages; see {@link DuetDayRenderInput}.
 * @returns Markdown naming the channel and date, with message counts.
 */
export function renderDayReadme(input: DuetDayRenderInput): string {
  const groups = groupThreads(input.messages);
  const total = input.messages.length;
  const roots = groups.length;
  const replies = total - roots;
  return [
    `# ${input.channelName} -- ${input.date}`,
    "",
    `Claude Duet log of the channel "${input.channelName}" for ${input.date} ` +
      `(time zone ${input.timeZone}). Messages: ${total} (${roots} top-level, ` +
      `${replies} ${replies === 1 ? "reply" : "replies"}). ` +
      `Read conversation.md; the canonical messages are in messages.json.`,
    "",
  ].join("\n");
}

/**
 * Whether a task is an open suggestion the agent surfaced from a connector.
 *
 * A suggestion has a `found` block and is not done. The capture did not show
 * how an adopted suggestion is marked, so an adopted task that keeps its
 * `found` block still reads as a suggestion until it is done.
 *
 * @param task - The task.
 * @returns True for an open task with a `found` block.
 */
export function isSuggestion(task: DuetTask): boolean {
  return Boolean(task.data.found) && !task.data.done;
}

/**
 * Sort key for ordering open and suggested tasks: creation time, falling back
 * to the first sync that saw the task.
 *
 * @param entry - A stored task.
 * @returns An ISO timestamp string.
 */
function createdKey(entry: DuetStoredTask): string {
  return entry.task.data.createdAt ?? entry.first_seen_at;
}

/**
 * Sort key for ordering done tasks: completion time, then last update, then the
 * last sync that saw the task.
 *
 * @param entry - A stored task.
 * @returns An ISO timestamp string.
 */
function doneKey(entry: DuetStoredTask): string {
  return entry.task.data.doneAt ?? entry.task.data.updatedAt ?? entry.last_seen_at;
}

/**
 * Render one task as a markdown checklist item with optional detail lines.
 *
 * @param entry - A stored task.
 * @returns Markdown lines for the item, without a trailing newline.
 */
function renderTaskItem(entry: DuetStoredTask): string {
  const { data } = entry.task;
  const box = data.done ? "[x]" : "[ ]";
  const title = data.title.replace(/\s*\n\s*/g, " ").trim();
  const stale = entry.present ? "" : " _(not in the latest sync)_";
  const lines = [`- ${box} ${title}${stale}`];
  if (data.found) {
    if (data.found.why) lines.push(`  - Why: ${data.found.why}`);
    if (data.found.connector) lines.push(`  - Source: ${data.found.connector}`);
    if (data.found.summary) lines.push(`  - Summary: ${data.found.summary}`);
  }
  if (data.note) {
    lines.push(`  - Note: ${data.note.replace(/\s*\n\s*/g, " ").trim()}`);
  }
  return lines.join("\n");
}

/**
 * Render the task store as `knowledge/TASKS.md`: Open, Suggested, then Done
 * (newest first). Ordering is fully determined by the data, so the output does
 * not depend on the order of `entries`. Tasks that dropped out of the API
 * result stay listed, marked as absent from the latest sync.
 *
 * @param entries - Every stored task.
 * @returns Markdown ending in a single newline.
 */
export function renderTasks(entries: readonly DuetStoredTask[]): string {
  const byCreated = (a: DuetStoredTask, b: DuetStoredTask) =>
    createdKey(a).localeCompare(createdKey(b)) || a.task.id.localeCompare(b.task.id);
  const byDoneDesc = (a: DuetStoredTask, b: DuetStoredTask) =>
    doneKey(b).localeCompare(doneKey(a)) || a.task.id.localeCompare(b.task.id);

  const open = entries.filter((e) => !e.task.data.done && !isSuggestion(e.task)).sort(byCreated);
  const suggested = entries.filter((e) => isSuggestion(e.task)).sort(byCreated);
  const done = entries.filter((e) => e.task.data.done).sort(byDoneDesc);

  const section = (heading: string, items: DuetStoredTask[]): string[] => [
    `## ${heading}`,
    items.length > 0 ? items.map(renderTaskItem).join("\n") : "_None._",
  ];
  return (
    [
      "# Duet tasks",
      ...section("Open", open),
      ...section("Suggested", suggested),
      ...section("Done", done),
    ].join("\n\n") + "\n"
  );
}
