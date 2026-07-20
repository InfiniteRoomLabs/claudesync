import { z } from "zod";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OnBecameEmpty } from "../sync/empty.js";

/**
 * Concurrency / backpressure configuration for parallel org sync. Validated with
 * zod and `.passthrough()` so unknown keys in a user's config file are tolerated
 * (forward-compat with future options). Every group has an object-level
 * `.default({})` so a partial or absent config still parses to fully-populated
 * defaults.
 */
export const ConcurrencyConfigSchema = z
  .object({
    /** Worker-pool bounds for the adaptive sync scheduler. */
    pool: z
      .object({
        /** Floor on concurrent workers; the pool never shrinks below this. */
        min: z.number().int().min(1).default(1),
        /** Ceiling on concurrent workers; the pool never grows past this. */
        max: z.number().int().min(1).default(8),
        /** Initial worker count before ramp-up adjusts it. */
        start: z.number().int().min(1).default(2),
      })
      .default({}),
    /** Optional per-project concurrency cap (fairness). Unset = no cap. */
    projectConcurrency: z.number().int().min(1).optional(),
    /** How the scheduler grows and shrinks the pool under load. */
    ramp: z
      .object({
        /** Consecutive successes before adding a worker. */
        increaseAfter: z.number().int().min(1).default(5),
        /** Multiplier applied to the pool size on backoff (0.1-0.99). */
        decreaseFactor: z.number().min(0.1).max(0.99).default(0.5),
      })
      .default({}),
    /** Per-request pacing and retry policy. */
    request: z
      .object({
        /** Minimum delay between successive requests, in milliseconds. */
        minGapMs: z.number().int().min(0).default(150),
        /** Maximum retry attempts per request before giving up. */
        maxRetries: z.number().int().min(0).default(5),
      })
      .default({}),
  })
  .passthrough();

/** Validated, fully-defaulted concurrency config; inferred from {@link ConcurrencyConfigSchema}. */
export type ConcurrencyConfig = z.infer<typeof ConcurrencyConfigSchema>;

/** Name of the JSON config file looked up in cwd then the home directory. */
export const CONFIG_FILENAME = ".claudesyncrc.json";

/**
 * Read the first {@link CONFIG_FILENAME} found: cwd first, then home directory.
 * Returns the raw parsed object (UNVALIDATED) or `{}` when none exists or the
 * file is unreadable/malformed. Validation is deferred to
 * {@link resolveConcurrencyConfig} so a broken config degrades to defaults
 * rather than crashing the CLI.
 *
 * @param cwd - Directory checked first; defaults to the process cwd.
 * @param home - Fallback directory; defaults to the OS home directory.
 * @returns The parsed JSON object, or `{}` if absent/invalid.
 */
export function loadConfigFile(
  cwd: string = process.cwd(),
  home: string = homedir()
): Record<string, unknown> {
  for (const dir of [cwd, home]) {
    const path = join(dir, CONFIG_FILENAME);
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        if (parsed && typeof parsed === "object") {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed config -> ignore, fall through to defaults.
      }
    }
  }
  return {};
}

/**
 * CLI flag values (already parsed to numbers by commander) that override config
 * file and env values in {@link resolveConcurrencyConfig}.
 */
export interface ConcurrencyFlags {
  /** Overrides `pool.max`. */
  workers?: number;
  /** Overrides `pool.min`. */
  minWorkers?: number;
  /** Overrides `pool.start`. */
  startWorkers?: number;
  /** Overrides `projectConcurrency`. */
  projectWorkers?: number;
  /** When true, forces fully sequential sync (pool collapses to 1/1/1). */
  noParallel?: boolean;
}

/**
 * Parse an environment variable as a finite number.
 *
 * @param env - Environment map to read from.
 * @param key - Variable name to look up.
 * @returns The parsed number, or undefined when unset, empty, or non-numeric.
 */
function envNum(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve the effective concurrency config by merging all sources by
 * precedence: CLI flag > env var > config file > built-in default. Pool sizes
 * are clamped so that `1 <= min <= start <= max`, and `--no-parallel` collapses
 * the pool to fully sequential (1/1/1). The result is re-parsed through
 * {@link ConcurrencyConfigSchema}, so it is always valid and fully populated.
 *
 * @param flags - CLI flags (highest precedence); defaults to none.
 * @param env - Environment map read for `CLAUDESYNC_*` overrides; defaults to
 *   `process.env`.
 * @param file - Raw parsed config object; defaults to {@link loadConfigFile}.
 * @returns A validated, clamped {@link ConcurrencyConfig}.
 */
export function resolveConcurrencyConfig(
  flags: ConcurrencyFlags = {},
  env: NodeJS.ProcessEnv = process.env,
  file: Record<string, unknown> = loadConfigFile()
): ConcurrencyConfig {
  // Validate the file (fills inner defaults) before layering env/flags on top.
  const base = ConcurrencyConfigSchema.parse(file);

  let max = flags.workers ?? envNum(env, "CLAUDESYNC_WORKERS") ?? base.pool.max;
  let min =
    flags.minWorkers ?? envNum(env, "CLAUDESYNC_MIN_WORKERS") ?? base.pool.min;
  let start =
    flags.startWorkers ??
    envNum(env, "CLAUDESYNC_START_WORKERS") ??
    base.pool.start;
  const projectConcurrency =
    flags.projectWorkers ??
    envNum(env, "CLAUDESYNC_PROJECT_WORKERS") ??
    base.projectConcurrency;

  if (flags.noParallel) {
    min = 1;
    max = 1;
    start = 1;
  }

  // Clamp: 1 <= min <= start <= max.
  max = Math.max(1, Math.floor(max));
  min = Math.min(Math.max(1, Math.floor(min)), max);
  start = Math.min(Math.max(min, Math.floor(start)), max);

  return ConcurrencyConfigSchema.parse({
    pool: { min, max, start },
    projectConcurrency,
    ramp: {
      increaseAfter:
        envNum(env, "CLAUDESYNC_RAMP_AFTER") ?? base.ramp.increaseAfter,
      decreaseFactor:
        envNum(env, "CLAUDESYNC_DECREASE_FACTOR") ?? base.ramp.decreaseFactor,
    },
    request: {
      minGapMs: envNum(env, "CLAUDESYNC_MIN_GAP_MS") ?? base.request.minGapMs,
      maxRetries:
        envNum(env, "CLAUDESYNC_MAX_RETRIES") ?? base.request.maxRetries,
    },
  });
}

/**
 * Behavior settings for how the sync engine treats empty conversations (no
 * human turns). Validated with zod and `.passthrough()` so unknown keys in a
 * user's config file are tolerated (forward-compat with future options).
 */
export const BehaviorConfigSchema = z
  .object({
    /** When true, conversations with zero human turns are skipped on list-scan
     * rather than fetched and materialized. */
    skipEmptyConversations: z.boolean().default(true),
    /** Policy applied to a previously-exported conversation that has since
     * become empty; see {@link OnBecameEmpty} for the meaning of each value. */
    onBecameEmpty: z.enum(["sync", "retain", "clean"]).default("sync"),
  })
  .passthrough();

/** Validated, fully-defaulted behavior config; inferred from {@link BehaviorConfigSchema}. */
export type BehaviorConfig = z.infer<typeof BehaviorConfigSchema>;

/**
 * CLI flag values that override config file and env values in
 * {@link resolveBehaviorConfig}. Both fields are optional so an unset flag
 * falls through to the next precedence tier instead of overriding it; an
 * explicit `false`/value is preserved because the merge uses `??`, not a
 * truthiness check.
 */
export interface BehaviorFlags {
  /** Overrides `skipEmptyConversations`. */
  skipEmptyConversations?: boolean;
  /** Overrides `onBecameEmpty`. */
  onBecameEmpty?: OnBecameEmpty;
}

/**
 * Parse a boolean environment variable with a tolerant, case-insensitive
 * spelling set.
 *
 * @param env - Environment map to read from.
 * @param key - Variable name to look up.
 * @returns `true` for `"1"`, `"true"`, or `"yes"`; `false` for `"0"`,
 *   `"false"`, or `"no"` (case-insensitive); `undefined` when the variable is
 *   unset or empty.
 * @throws {Error} When the variable is set to a value outside the accepted
 *   spellings -- invalid values fail loudly rather than silently defaulting.
 */
export function envBool(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const raw = env[key];
  if (raw == null || raw === "") return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  throw new Error(
    `Invalid boolean value for ${key}: "${raw}" (expected one of 1/true/yes or 0/false/no)`
  );
}

/**
 * Resolve the effective behavior config by merging all sources by
 * precedence: CLI flag > env var > config file > built-in default. Each
 * field is resolved independently via a `??` chain, so an explicit `false`
 * (flag or env) beats a `true` from a lower-precedence source, while an
 * absent (`undefined`) flag falls through without overriding env or file.
 * The merged result is re-parsed through {@link BehaviorConfigSchema}, so an
 * invalid `onBecameEmpty` value from any source (file, env, or flag) throws
 * rather than silently coercing to a default.
 *
 * @param flags - CLI flags (highest precedence); defaults to none.
 * @param env - Environment map read for `CLAUDESYNC_*` overrides; defaults to
 *   `process.env`.
 * @param file - Raw parsed config object; defaults to {@link loadConfigFile}.
 * @returns A validated, fully-populated {@link BehaviorConfig}.
 * @throws {Error} When `envBool` rejects `CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS`,
 *   or when the resolved `onBecameEmpty` value is not one of `"sync"`,
 *   `"retain"`, or `"clean"`.
 */
export function resolveBehaviorConfig(
  flags: BehaviorFlags = {},
  env: NodeJS.ProcessEnv = process.env,
  file: Record<string, unknown> = loadConfigFile()
): BehaviorConfig {
  // Validate the file (fills defaults, throws on an invalid onBecameEmpty)
  // before layering env/flags on top.
  const base = BehaviorConfigSchema.parse(file);

  const skipEmptyConversations =
    flags.skipEmptyConversations ??
    envBool(env, "CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS") ??
    base.skipEmptyConversations;

  const onBecameEmpty =
    flags.onBecameEmpty ?? env["CLAUDESYNC_ON_BECAME_EMPTY"] ?? base.onBecameEmpty;

  // Re-parse so an invalid onBecameEmpty from env or flags throws here too.
  return BehaviorConfigSchema.parse({ skipEmptyConversations, onBecameEmpty });
}
