import fs from "node:fs";
import path from "node:path";
import { channelIdTail, UNKNOWN_DATE } from "./render.js";
import { DuetDayStoreSchema, DuetStoredTaskSchema, DuetTaskStoreSchema } from "./schemas.js";
import type { DuetDayStore, DuetStoredTask } from "./types.js";

/** Name of a day directory's canonical message store. */
export const MESSAGES_FILENAME = "messages.json";

/** Name of a day directory's rendered log. */
export const CONVERSATION_FILENAME = "conversation.md";

/**
 * Read a text file, or `undefined` when it does not exist.
 *
 * @param file - Absolute path.
 * @returns The UTF-8 text, or `undefined` if the file is missing.
 */
export function readTextIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/**
 * Write a file only when its content would change.
 *
 * Creates parent directories. The write goes to a sibling `.tmp` file that is
 * then renamed over the target, so a crash cannot leave a half-written file.
 *
 * @param file - Absolute destination path.
 * @param content - Full new text.
 * @returns True when the file was written, false when it already held `content`.
 */
export function writeFileIfChanged(file: string, content: string): boolean {
  if (readTextIfExists(file) === content) {
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, file);
  return true;
}

/**
 * Serialize a JSON document the way every Duet store file is written: two-space
 * indent and a trailing newline. A single serializer keeps "did it change"
 * comparisons exact.
 *
 * @param value - Any JSON-serializable value.
 * @returns The text to write.
 */
export function toJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Parse a store file's text with a schema, naming the file in any error.
 *
 * @param file - Absolute path, used in the error message.
 * @param text - The file's UTF-8 text.
 * @param schema - Anything with a Zod-style `parse`; structural so no Zod
 * generics are needed.
 * @returns The parsed value.
 * @throws {@link Error} `Cannot read <file>: <reason>` when the text is not
 * JSON or does not match the schema.
 */
function parseStoreFile<T>(
  file: string,
  text: string,
  schema: { parse(value: unknown): T }
): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch (err) {
    throw new Error(
      `Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Suffix of the stash a day directory is renamed to while it is rewritten (see
 * `replaceWithPreserve`). A crash mid-rewrite can leave the day only there.
 */
const STASH_SUFFIX = ".prev";

/**
 * Whether a directory name has the shape of one of a channel's day
 * directories: `<YYYY-MM-DD or unknown-date>-<name slug>-<id tail>`. The name
 * slug is ignored, because a rename changes it.
 *
 * @param name - A directory name under `duet/conversations/`.
 * @param tail - The channel's id tail from `channelIdTail`.
 * @returns True when `name` is a day directory ending in `tail`.
 */
function isDayDirOf(name: string, tail: string): boolean {
  let rest: string;
  if (/^\d{4}-\d{2}-\d{2}-/.test(name)) {
    rest = name.slice(11);
  } else if (name.startsWith(`${UNKNOWN_DATE}-`)) {
    rest = name.slice(UNKNOWN_DATE.length + 1);
  } else {
    return false;
  }
  return rest.length > tail.length + 1 && rest.endsWith(`-${tail}`);
}

/**
 * Read the `messages.json` of one directory.
 *
 * @param dir - Absolute path of a day directory or its stash.
 * @returns The store, or `undefined` when the file does not exist.
 * @throws {@link Error} naming the file when it exists but is not valid.
 */
function readDayStore(dir: string): DuetDayStore | undefined {
  const file = path.join(dir, MESSAGES_FILENAME);
  const text = readTextIfExists(file);
  return text === undefined ? undefined : parseStoreFile(file, text, DuetDayStoreSchema);
}

/**
 * Merge two copies of one day's store by message id, the newer copy winning.
 *
 * @param older - The crash stash's copy.
 * @param newer - The directory's own copy.
 * @returns `newer` with every message only `older` has added.
 */
function mergeDayStores(older: DuetDayStore, newer: DuetDayStore): DuetDayStore {
  const byId = new Map(older.messages.map((m) => [m.id, m]));
  for (const m of newer.messages) byId.set(m.id, m);
  return { ...newer, messages: [...byId.values()] };
}

/**
 * Load every stored day of one channel from `duet/conversations/`.
 *
 * A day is identified by channel id, not by name: its directory name must end
 * in the channel's id tail and its `messages.json` must carry the channel's
 * `channel_id`. A rename therefore cannot orphan stored days, and another
 * channel whose id shares the tail is never mixed in.
 *
 * When a crash left `<dir>.prev` behind (the stash of a rewrite), its
 * `messages.json` is read too: alone when `<dir>/messages.json` is missing,
 * merged under it (the directory's copy winning) when both exist. The stash may
 * be the only copy of messages that have since left the API window.
 * Directories with no store at all, such as one an indexer created first, are
 * skipped.
 *
 * @param conversationsDir - Absolute path of `duet/conversations/`.
 * @param channelId - The channel's id.
 * @returns Stored days keyed by directory name (never the `.prev` name).
 * @throws {@link Error} naming the file when a `messages.json` exists but is not
 * valid. Failing loudly beats overwriting history with a partial store.
 */
export function loadDayStores(
  conversationsDir: string,
  channelId: string
): Map<string, DuetDayStore> {
  const out = new Map<string, DuetDayStore>();
  let names: string[];
  try {
    names = fs.readdirSync(conversationsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return out;
    }
    throw err;
  }
  const tail = channelIdTail(channelId);
  const days = new Set<string>();
  for (const name of names) {
    const day = name.endsWith(STASH_SUFFIX) ? name.slice(0, -STASH_SUFFIX.length) : name;
    if (isDayDirOf(day, tail)) days.add(day);
  }
  for (const name of [...days].sort()) {
    const copies = [
      readDayStore(path.join(conversationsDir, name + STASH_SUFFIX)),
      readDayStore(path.join(conversationsDir, name)),
    ].filter((s): s is DuetDayStore => s !== undefined && s.channel_id === channelId);
    if (copies.length > 0) {
      out.set(name, copies.reduce(mergeDayStores));
    }
  }
  return out;
}

/**
 * Whether a day directory, or the crash stash of one, holds a message store.
 * The sync asks this about a directory where it found no store of its own: a
 * store there belongs to another channel whose name and id tail collide with
 * this one's, and must not be overwritten.
 *
 * @param dir - Absolute path of a day directory.
 * @returns True when `<dir>/messages.json` or `<dir>.prev/messages.json` exists.
 */
export function hasDayStore(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, MESSAGES_FILENAME)) ||
    fs.existsSync(path.join(dir + STASH_SUFFIX, MESSAGES_FILENAME))
  );
}

/**
 * Reads `tasks.json` into a Map keyed by task id. The whole file is validated
 * with {@link DuetTaskStoreSchema}, but the entries are then taken from the raw
 * object and validated one by one, because Zod's record parser silently drops a
 * `__proto__` key and that is a legal task id.
 */
const TASK_STORE_READER = {
  /**
   * @param value - The decoded `tasks.json`.
   * @returns Stored tasks keyed by task id.
   * @throws {@link Error} (a Zod error) when the file does not match the schema.
   */
  parse(value: unknown): Map<string, DuetStoredTask> {
    DuetTaskStoreSchema.parse(value);
    const tasks = (value as { tasks: Record<string, unknown> }).tasks;
    return new Map(
      Object.entries(tasks).map(([id, entry]) => [id, DuetStoredTaskSchema.parse(entry)])
    );
  },
};

/**
 * Read the canonical task store, `tasks.json`.
 *
 * @param file - Absolute path of `tasks.json`.
 * @returns The stored tasks keyed by task id, or an empty map when the file
 * does not exist. A Map, so any id (even `__proto__`) is an ordinary key.
 * @throws {@link Error} naming the file when it exists but is not valid.
 */
export function readTaskStore(file: string): Map<string, DuetStoredTask> {
  const text = readTextIfExists(file);
  if (text === undefined) {
    return new Map();
  }
  return parseStoreFile(file, text, TASK_STORE_READER);
}
