import { hashContent } from "./hash.js";
import { parseEdits, serializeEdits } from "./edits.js";

/**
 * The outcome of a three-way merge of `edits.md` control entries: the merged
 * array ready to `PUT` to the remote, plus content-free counts describing how
 * it was assembled. The counts exist so a CLI can print a plan (`+2 -1`)
 * without ever holding or logging entry text.
 */
export interface ControlsMergeResult {
  /**
   * The merged, ordered control entries -- kept-by-both and remote adds in
   * remote order, followed by local adds in local order. This is the exact
   * array to serialize and `PUT` back to the remote.
   */
  controls: string[];

  /**
   * Count of normalized local entries that were not present in the base
   * (by {@link hashContent} of the normalized entry) and survived
   * deduplication. Each one is a control the local `edits.md` introduced
   * since the last pull.
   */
  localAdds: number;

  /**
   * Count of base entries that are still present in the remote's live
   * controls but were removed from the local `edits.md`. Local deletion
   * wins over a remote entry that is otherwise unchanged since the base.
   */
  localDeletes: number;

  /**
   * Count of normalized remote entries that were not present in the base
   * (by {@link hashContent} of the normalized entry) and survived
   * deduplication. Each one is a control someone added on claude.ai since
   * the last pull.
   */
  remoteAdds: number;

  /**
   * Count of base entries that are still present in the local `edits.md`
   * but are no longer present in the remote's live controls. Remote
   * deletion wins over a stale local copy of that entry.
   */
  remoteDeletes: number;

  /**
   * Count of entries dropped because their exact normalized text had
   * already been emitted into {@link ControlsMergeResult.controls} --
   * covers both sides adding identical text and duplicate occurrences
   * within a single input array.
   */
  deduplicated: number;
}

/**
 * Normalize a raw array of control entries to the canonical on-disk form:
 * each entry trimmed, empty entries dropped, by round-tripping through
 * {@link serializeEdits} and {@link parseEdits}. Two entries that differ only
 * in surrounding whitespace or line-ending style normalize to the same
 * string and therefore the same {@link hashContent} hash.
 *
 * @param entries - Raw control entries, as read from `edits.md` or a live
 *   remote controls list.
 * @returns The normalized entries, in the same relative order.
 */
function normalizeEntries(entries: readonly string[]): string[] {
  return parseEdits(serializeEdits(Array.from(entries)));
}

/**
 * Pure three-way merge of project memory controls: no I/O, no network, safe
 * to call repeatedly with the same inputs (idempotent, per
 * {@link ControlsMergeResult}'s deterministic ordering).
 *
 * All three inputs are normalized independently before merging (see
 * {@link normalizeEntries}); `baseHashes` are assumed to already be
 * {@link hashContent} hashes of normalized entries, as produced by the pull
 * sidecar.
 *
 * Algorithm (remote order is authoritative for survivors of the base;
 * local adds are appended after, in local order; delete wins over an
 * unrelated edit to the same entry):
 *
 * 1. Walk the normalized remote entries in order. Drop an entry whose hash
 *    is a base hash but is absent from the normalized local entries --
 *    the local side deleted that base entry, and delete wins. Otherwise
 *    emit the entry (skipping it if its exact text was already emitted).
 * 2. Walk the normalized local entries in order. Skip any entry whose hash
 *    is a base hash -- it was already handled in step 1, either because it
 *    survives (kept-by-both) or because the remote no longer has it
 *    (remote deleted it, and delete wins). Otherwise emit the entry
 *    (skipping it if its exact text was already emitted) -- this is a
 *    genuine local add.
 *
 * @param baseHashes - {@link hashContent} hashes of the normalized base
 *   entries, from the pull sidecar's per-entry hash list.
 * @param local - The current local `edits.md` entries (raw, pre-normalize).
 * @param remote - The live remote controls, as just fetched (raw,
 *   pre-normalize).
 * @returns The merge result: the array to `PUT`, plus advisory counts.
 */
export function mergeProjectMemoryControls(
  baseHashes: readonly string[],
  local: readonly string[],
  remote: readonly string[],
): ControlsMergeResult {
  const base = new Set(baseHashes);
  const normalizedLocal = normalizeEntries(local);
  const normalizedRemote = normalizeEntries(remote);
  const localHashes = new Set(normalizedLocal.map(hashContent));
  const remoteHashes = new Set(normalizedRemote.map(hashContent));

  const controls: string[] = [];
  const seen = new Set<string>();
  let localAdds = 0;
  let localDeletes = 0;
  let remoteAdds = 0;
  let remoteDeletes = 0;
  let deduplicated = 0;

  for (const entry of normalizedRemote) {
    const hash = hashContent(entry);
    if (base.has(hash) && !localHashes.has(hash)) {
      localDeletes += 1;
      continue;
    }
    if (seen.has(entry)) {
      deduplicated += 1;
      continue;
    }
    controls.push(entry);
    seen.add(entry);
    if (!base.has(hash)) {
      remoteAdds += 1;
    }
  }

  for (const entry of normalizedLocal) {
    const hash = hashContent(entry);
    if (base.has(hash)) {
      if (!remoteHashes.has(hash)) {
        remoteDeletes += 1;
      }
      continue;
    }
    if (seen.has(entry)) {
      deduplicated += 1;
      continue;
    }
    controls.push(entry);
    seen.add(entry);
    localAdds += 1;
  }

  return { controls, localAdds, localDeletes, remoteAdds, remoteDeletes, deduplicated };
}

/**
 * Guard a set of raw local control entries before they enter a merge: throw
 * if any entry contains a line exactly equal to `---`, the `edits.md`
 * delimiter. Such an entry cannot round-trip through
 * {@link serializeEdits}/{@link parseEdits} -- it would be split into
 * multiple entries on the next parse.
 *
 * The thrown error names the problem structurally (which index) and never
 * includes the offending entry's text, so this is safe to call on
 * privacy-sensitive memory content.
 *
 * @param controls - Raw control entries to validate, e.g. the local
 *   `edits.md` array before merging.
 * @throws Error if any entry contains a line exactly equal to `---`.
 */
export function assertNoDelimiterEntries(controls: readonly string[]): void {
  const delimiterLine = /^---$/m;
  controls.forEach((entry, index) => {
    if (delimiterLine.test(entry)) {
      throw new Error(
        `Control entry at index ${index} contains a line equal to the "---" delimiter and cannot round-trip edits.md.`,
      );
    }
  });
}
