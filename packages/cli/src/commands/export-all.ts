import { Command } from "commander";
import { resolve } from "node:path";
import {
  AdaptiveController,
  resolveConcurrencyConfig,
  runOrgSync,
  type ExportFormat,
  type ProgressEvent,
} from "@infinite-room-labs/claudesync-core";
import { createClient, resolveOrgId } from "../utils.js";

const parseIntArg = (value: string): number => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`expected an integer, got "${value}"`);
  }
  return n;
};

function actionTag(action: string): string {
  switch (action) {
    case "skipped":
      return "Skipping (same)";
    case "skipped-existing":
      return "Skipping (exists)";
    case "incremental":
      return "Updated";
    case "full":
    case "exported":
    default:
      return "Exported";
  }
}

function renderProgress(e: ProgressEvent): void {
  switch (e.type) {
    case "org-start":
      console.log(
        `  ${e.projectCount} project(s), ${e.conversationCount} conversation(s) total`
      );
      break;
    case "project-start":
      console.log(
        `[project] ${e.project} (${e.docs} doc(s), ${e.conversations} conversation(s))`
      );
      break;
    case "project-skipped":
      console.log(`[project] Skipping (exists): ${e.project}`);
      break;
    case "project-done":
      console.log(`[project] Written: ${e.project}`);
      break;
    case "conv-done":
      console.log(
        `[conv ${e.completed}/${e.total}] ${actionTag(e.action)}: ${e.displayName}`
      );
      break;
    case "throttle":
      console.log(
        `  Rate limited -> backing off to ${e.limit} worker(s), resuming in ${e.resumeInSec}s`
      );
      break;
    case "error":
      console.error(`  ERROR ${e.displayName}: ${e.message}`);
      break;
  }
}

export const exportAllCommand = new Command("export-all")
  .description(
    "Export entire organization: all projects (with knowledge + conversations) and standalone conversations"
  )
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--output <path>", "Output directory (default: ./org-export)")
  .option("--format <format>", "Output format: git, json, or files", "files")
  .option("--author-name <name>", "Git author name", "Claude")
  .option("--author-email <email>", "Git author email", "claude@anthropic.com")
  .option("--skip-artifacts", "Skip downloading artifacts (faster)")
  .option(
    "--skip-existing",
    "Skip conversations/projects whose output directory already exists"
  )
  .option(
    "--skip-same",
    "Skip conversations unchanged since the last sync (uses .claudesync-state.json sidecar). Mutually exclusive with --skip-existing."
  )
  .option(
    "--preserve <glob>",
    "Glob (POSIX-style, relative to each conversation dir) of locally-added files to keep across re-syncs in --format files. Repeatable. CHANGELOG.md is always preserved. Examples: --preserve INDEX.md --preserve 'notes/**'",
    (value: string, previous: string[] = []) => previous.concat(value),
    [] as string[]
  )
  .option(
    "--workers <n>",
    "Maximum concurrent workers (pool ceiling). Env: CLAUDESYNC_WORKERS",
    parseIntArg
  )
  .option(
    "--min-workers <n>",
    "Minimum workers the backpressure controller will fall back to. Env: CLAUDESYNC_MIN_WORKERS",
    parseIntArg
  )
  .option(
    "--start-workers <n>",
    "Initial (skeptical) worker count before ramping up. Env: CLAUDESYNC_START_WORKERS",
    parseIntArg
  )
  .option(
    "--project-workers <n>",
    "Optional per-project concurrency cap. Env: CLAUDESYNC_PROJECT_WORKERS",
    parseIntArg
  )
  .option("--no-parallel", "Disable parallelism (sequential, 1 worker)")
  .action(
    async (options: {
      org?: string;
      output?: string;
      format: ExportFormat;
      authorName: string;
      authorEmail: string;
      skipArtifacts?: boolean;
      skipExisting?: boolean;
      skipSame?: boolean;
      preserve: string[];
      workers?: number;
      minWorkers?: number;
      startWorkers?: number;
      projectWorkers?: number;
      parallel: boolean;
    }) => {
      if (options.skipSame && options.skipExisting) {
        console.error(
          "error: --skip-same and --skip-existing are mutually exclusive"
        );
        process.exit(1);
      }

      const config = resolveConcurrencyConfig({
        workers: options.workers,
        minWorkers: options.minWorkers,
        startWorkers: options.startWorkers,
        projectWorkers: options.projectWorkers,
        noParallel: options.parallel === false,
      });

      const controller = new AdaptiveController({
        min: config.pool.min,
        max: config.pool.max,
        start: config.pool.start,
        increaseAfter: config.ramp.increaseAfter,
        decreaseFactor: config.ramp.decreaseFactor,
        minGapMs: config.request.minGapMs,
      });

      const { auth, client } = createClient({ limiter: controller });
      const orgId = await resolveOrgId(auth, options.org);
      const outputRoot = resolve(options.output ?? "./org-export");

      console.log("Fetching organization data...");
      console.log(
        `  Workers: start ${config.pool.start}, min ${config.pool.min}, max ${config.pool.max}` +
          (config.projectConcurrency
            ? `, per-project cap ${config.projectConcurrency}`
            : "")
      );

      const abortController = new AbortController();
      const onSigint = () => {
        console.error(
          "\nInterrupted -- no new work will start; finishing in-flight conversations, then stopping..."
        );
        abortController.abort();
      };
      process.on("SIGINT", onSigint);

      try {
        const result = await runOrgSync(client, orgId, {
          outputRoot,
          format: options.format,
          authorName: options.authorName,
          authorEmail: options.authorEmail,
          skipArtifacts: options.skipArtifacts,
          skipExisting: options.skipExisting,
          skipSame: options.skipSame,
          preserve: options.preserve,
          controller,
          projectConcurrency: config.projectConcurrency,
          maxRetries: config.request.maxRetries,
          signal: abortController.signal,
          onProgress: renderProgress,
        });

        const aborted = abortController.signal.aborted;
        console.log(
          aborted ? `\nOrg export stopped (interrupted).` : `\nOrg export complete!`
        );
        console.log(`  Output: ${outputRoot}`);
        console.log(`  Projects: ${result.projects}`);
        console.log(`  Standalone conversations: ${result.standalone}`);
        if (result.errors > 0) {
          console.log(`  Errors: ${result.errors}`);
        }
        if (aborted) {
          process.exitCode = 130; // 128 + SIGINT
        } else if (result.errors > 0) {
          process.exitCode = 1;
        }
      } finally {
        process.off("SIGINT", onSigint);
      }
    }
  );
