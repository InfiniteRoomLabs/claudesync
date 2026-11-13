import fs from "node:fs";
import path from "node:path";
import { DuetDayStoreSchema, DuetTaskStoreSchema } from "./schemas.js";
import type { DuetDayStore, DuetTaskStore } from "./types.js";

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
 * Load every stored day of one channel from `duet/conversations/`.
 *
 * A directory belongs to the channel when its name is a date (or the
 * `unknown-date` placeholder) followed by `-<slug>`. Directories without a
 * readable `messages.json`, such as one an indexer created first, are skipped.
 *
 * @param conversationsDir - Absolute path of `duet/conversations/`.
 * @param slug - Channel slug from `channelSlug`.
 * @returns Stored days keyed by directory name.
 * @throws {@link Error} naming the file when a `messages.json` exists but is not
 * valid. Failing loudly beats overwriting history with a partial store.
 */
export function loadDayStores(
  conversationsDir: string,
  slug: string
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
  const suffix = `-${slug}`;
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    if (!/^(\d{4}-\d{2}-\d{2}|unknown-date)$/.test(name.slice(0, -suffix.length))) continue;
    const file = path.join(conversationsDir, name, MESSAGES_FILENAME);
    const text = readTextIfExists(file);
    if (text === undefined) continue;
    try {
      out.set(name, DuetDayStoreSchema.parse(JSON.parse(text)));
    } catch (err) {
      throw new Error(
        `Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return out;
}

/**
 * Read the canonical task store, `tasks.json`.
 *
 * @param file - Absolute path of `tasks.json`.
 * @returns The stored tasks, or an empty store when the file does not exist.
 * @throws {@link Error} naming the file when it exists but is not valid.
 */
export function readTaskStore(file: string): DuetTaskStore {
  const text = readTextIfExists(file);
  if (text === undefined) {
    return { tasks: {} };
  }
  try {
    return DuetTaskStoreSchema.parse(JSON.parse(text));
  } catch (err) {
    throw new Error(
      `Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
