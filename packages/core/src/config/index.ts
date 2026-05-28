import { z } from "zod";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Concurrency / backpressure configuration for parallel org sync. Validated with
 * zod and `.passthrough()` so unknown keys in a user's config file are tolerated
 * (forward-compat with future options).
 */
export const ConcurrencyConfigSchema = z
  .object({
    pool: z
      .object({
        min: z.number().int().min(1).default(1),
        max: z.number().int().min(1).default(8),
        start: z.number().int().min(1).default(2),
      })
      .default({}),
    /** Optional per-project concurrency cap (fairness). Unset = no cap. */
    projectConcurrency: z.number().int().min(1).optional(),
    ramp: z
      .object({
        increaseAfter: z.number().int().min(1).default(5),
        decreaseFactor: z.number().min(0.1).max(0.99).default(0.5),
      })
      .default({}),
    request: z
      .object({
        minGapMs: z.number().int().min(0).default(150),
        maxRetries: z.number().int().min(0).default(5),
      })
      .default({}),
  })
  .passthrough();

export type ConcurrencyConfig = z.infer<typeof ConcurrencyConfigSchema>;

export const CONFIG_FILENAME = ".claudesyncrc.json";

/**
 * Read the first config file found: cwd, then home directory. Returns the raw
 * parsed object (unvalidated) or {} if none/invalid. Validation happens in
 * resolveConcurrencyConfig so a malformed file degrades to defaults rather than
 * crashing the CLI.
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

/** CLI flag values (already parsed to numbers by commander). */
export interface ConcurrencyFlags {
  workers?: number;
  minWorkers?: number;
  startWorkers?: number;
  projectWorkers?: number;
  noParallel?: boolean;
}

function envNum(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Merge config sources by precedence: CLI flag > env var > config file >
 * built-in default. Clamps pool sizes so that 1 <= min <= start <= max, and
 * collapses to fully sequential when --no-parallel is set.
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
