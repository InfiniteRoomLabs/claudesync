import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

/**
 * Sidecar filename written into a project's `memory/` directory. Leading dot
 * keeps it out of casual listings; it holds only hashes and metadata, never
 * memory or edit text.
 */
export const MEMORY_STATE_FILENAME = ".claudesync-memory-state.json";

/**
 * Persisted merge base for a project's memory pull. `controls_base` is the
 * ordered list of per-entry SHA-256 hashes of the last-synced `controls`, so
 * Phase 2's three-way merge can tell local from remote edit changes without
 * storing instruction text. `remote_snapshot_sha256` fingerprints the whole
 * observed state for the idempotency no-op check.
 */
export const MemoryStateSchema = z.object({
  /** State format version; bumped only on backward-incompatible changes. */
  schema_version: z.literal(1),
  /** Project UUID this state belongs to (the `project_uuid` value). */
  project_uuid: z.string(),
  /** sha256 of the account identifier; a mismatch fails closed on the next run. */
  principal_fingerprint: z.string(),
  /** sha256 of the canonicalized memory doc at last pull. */
  memory_content_sha256: z.string(),
  /** Ordered per-entry sha256 of the `controls` array at last pull. */
  controls_base: z.array(z.string()),
  /** sha256 of the canonical snapshot (memory hash + ordered control hashes). */
  remote_snapshot_sha256: z.string(),
  /** Wall-clock time of the last pull (ISO 8601). */
  last_pull_at: z.string(),
  /** Server `updated_at` seen at last pull; null if the project had no memory. */
  remote_updated_at: z.string().nullable(),
});

/** Parsed, validated memory sidecar. Inferred from {@link MemoryStateSchema}. */
export type MemoryState = z.infer<typeof MemoryStateSchema>;

/**
 * Read and validate the memory sidecar from a `memory/` directory.
 *
 * @param dir - The `memory/` directory containing {@link MEMORY_STATE_FILENAME}.
 * @returns The parsed state, or undefined if no sidecar exists (first pull).
 * @throws If the file exists but is not valid JSON or fails schema validation --
 * corruption is surfaced, not silently reset.
 */
export function readMemoryState(dir: string): MemoryState | undefined {
  const filePath = path.join(dir, MEMORY_STATE_FILENAME);
  if (!fs.existsSync(filePath)) return undefined;
  const raw = fs.readFileSync(filePath, "utf-8");
  return MemoryStateSchema.parse(JSON.parse(raw));
}

/**
 * Write the memory sidecar atomically (tmp file + rename) with owner-only
 * permissions. If the process dies mid-write the previous sidecar is left
 * intact. Creates `dir` recursively if needed.
 *
 * @param dir - The `memory/` directory to write {@link MEMORY_STATE_FILENAME} into.
 * @param state - State to persist as pretty-printed JSON.
 */
export function writeMemoryState(dir: string, state: MemoryState): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const filePath = path.join(dir, MEMORY_STATE_FILENAME);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}
