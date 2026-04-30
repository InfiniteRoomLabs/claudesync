import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

export const STATE_FILENAME = ".claudesync-state.json";

export const SyncStateLeafSchema = z.object({
  uuid: z.string(),
  last_message_index: z.number(),
});

export const SyncStateArtifactSchema = z.object({
  path: z.string(),
  size: z.number(),
  created_at: z.string(),
});

export const SyncStateSchema = z.object({
  schema_version: z.literal(1),
  conversation_uuid: z.string(),
  conversation_name: z.string(),
  updated_at: z.string(),
  current_leaf_message_uuid: z.string().nullable(),
  leaves: z.array(SyncStateLeafSchema),
  artifacts: z.array(SyncStateArtifactSchema),
  last_sync_at: z.string(),
  last_sync_action: z.enum(["full", "incremental", "skipped"]),
});

export type SyncState = z.infer<typeof SyncStateSchema>;
export type SyncStateLeaf = z.infer<typeof SyncStateLeafSchema>;
export type SyncStateArtifact = z.infer<typeof SyncStateArtifactSchema>;

/**
 * Reads the sync state file from a conversation directory.
 * Returns undefined if the file does not exist (bootstrap case).
 * Throws on parse failure (corrupted state should not silently fall back to
 * full re-sync without the user noticing).
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
 * Writes the sync state file atomically (write to .tmp, then rename).
 * Survives interruption: if the process dies mid-write, the original file
 * (if any) is left intact.
 */
export function writeSyncState(dir: string, state: SyncState): void {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, STATE_FILENAME);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}
