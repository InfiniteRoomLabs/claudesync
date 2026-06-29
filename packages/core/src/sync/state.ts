import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

/**
 * Name of the per-conversation state sidecar written into each exported
 * conversation directory. Leading dot keeps it out of casual file listings;
 * {@link writeTreeWithPreserve} treats it as an always-drop file so it is
 * always rewritten fresh on re-sync.
 */
export const STATE_FILENAME = ".claudesync-state.json";

/**
 * One branch leaf recorded from a prior sync: the leaf message uuid plus how
 * far the branch had progressed. {@link diffConversation} compares these
 * against the freshly fetched tree to tell new branches from extended ones.
 */
export const SyncStateLeafSchema = z.object({
  /** Leaf message uuid that terminated this branch at the time of the sync. */
  uuid: z.string(),
  /** Position (ChatMessage.index) of that leaf in root->leaf order. */
  last_message_index: z.number(),
});

/** One artifact's identity recorded from a prior sync, used for change detection. */
export const SyncStateArtifactSchema = z.object({
  /** Wiggle filesystem path of the artifact. */
  path: z.string(),
  /** Byte size at last sync; a size change flags the artifact as updated. */
  size: z.number(),
  /** Server-reported creation timestamp; a change also flags an update. */
  created_at: z.string(),
});

/**
 * Persisted snapshot of a conversation's last successful sync. Stored as
 * {@link STATE_FILENAME} beside the exported files and fed back into
 * {@link diffConversation} on the next run to compute an incremental diff.
 * Validated with `.passthrough`-free strict parsing so corruption surfaces
 * loudly (see {@link readSyncState}).
 */
export const SyncStateSchema = z.object({
  /** State format version. Bumped only on backward-incompatible changes. */
  schema_version: z.literal(1),
  /** Conversation uuid this state belongs to. */
  conversation_uuid: z.string(),
  /** Conversation title at last sync; a change drives the "renamed" diff. */
  conversation_name: z.string(),
  /**
   * Conversation model (e.g. "claude-opus-4-7"). Nullable, optional, and
   * defaulting to null so state files written before this field existed still
   * parse; enables the "Model changed" changelog diff across syncs. Adding it
   * is backward compatible, hence no {@link SyncStateSchema.schema_version} bump.
   */
  model: z.string().nullable().optional().default(null),
  /** Conversation's server-side updated_at at last sync. */
  updated_at: z.string(),
  /** Current/main leaf uuid at last sync, or null if none was reported. */
  current_leaf_message_uuid: z.string().nullable(),
  /** All branch leaves seen last sync. */
  leaves: z.array(SyncStateLeafSchema),
  /** All artifacts seen last sync. */
  artifacts: z.array(SyncStateArtifactSchema),
  /** Wall-clock time this sync ran (ISO 8601). */
  last_sync_at: z.string(),
  /** What the last sync did: a full export, an incremental update, or a no-op. */
  last_sync_action: z.enum(["full", "incremental", "skipped"]),
});

/** Parsed, validated sync state. Inferred from {@link SyncStateSchema}. */
export type SyncState = z.infer<typeof SyncStateSchema>;
/** One recorded branch leaf. Inferred from {@link SyncStateLeafSchema}. */
export type SyncStateLeaf = z.infer<typeof SyncStateLeafSchema>;
/** One recorded artifact. Inferred from {@link SyncStateArtifactSchema}. */
export type SyncStateArtifact = z.infer<typeof SyncStateArtifactSchema>;

/**
 * Reads and validates the sync state file from a conversation directory.
 *
 * @param dir - Conversation output directory containing {@link STATE_FILENAME}.
 * @returns The parsed state, or undefined if no state file exists (the
 * first-sync bootstrap case, which {@link diffConversation} treats as initial).
 * @throws If the file exists but is not valid JSON or fails schema validation.
 * Corrupted state is surfaced rather than silently triggering a full re-sync
 * the user did not ask for.
 */
export function readSyncState(dir: string): SyncState | undefined {
  const filePath = path.join(dir, STATE_FILENAME);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  return SyncStateSchema.parse(parsed);
}

/**
 * Writes the sync state file atomically: serialize to a sibling `.tmp` file,
 * then rename over the target. If the process dies mid-write, the previous
 * state file (if any) is left intact rather than half-written. Creates `dir`
 * (recursively) if it does not exist.
 *
 * @param dir - Conversation output directory to write {@link STATE_FILENAME} into.
 * @param state - State to persist; serialized as pretty-printed JSON.
 */
export function writeSyncState(dir: string, state: SyncState): void {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, STATE_FILENAME);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}
