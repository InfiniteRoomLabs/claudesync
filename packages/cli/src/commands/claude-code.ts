import { Command } from "commander";
import os from "node:os";
import path from "node:path";
import {
  runClaudeCodeSync,
  type ClaudeCodeFidelity,
  type ClaudeCodeProgressEvent,
} from "@infinite-room-labs/claudesync-core";

const FIDELITIES: ClaudeCodeFidelity[] = ["compact", "truncated", "full"];

function parseFidelity(value: string): ClaudeCodeFidelity {
  if (!FIDELITIES.includes(value as ClaudeCodeFidelity)) {
    throw new Error(`--fidelity must be one of: ${FIDELITIES.join(", ")}`);
  }
  return value as ClaudeCodeFidelity;
}

function parseIntArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`expected a non-negative integer, got "${value}"`);
  }
  return n;
}

function renderProgress(e: ClaudeCodeProgressEvent): void {
  switch (e.type) {
    case "start":
      console.log(`  ${e.projects} project(s), ${e.sessions} session(s) total`);
      break;
    case "session-done": {
      const tag =
        e.action === "exported"
          ? "Exported"
          : e.action === "skipped-existing"
            ? "Skipping (exists)"
            : "Skipping (same)";
      console.log(`[session ${e.completed}/${e.total}] ${tag}: ${e.displayName}`);
      break;
    }
    case "error":
      console.error(`  ERROR ${e.displayName}: ${e.message}`);
      break;
  }
}

export const claudeCodeCommand = new Command("claude-code")
  .description(
    "Export local Claude Code sessions (~/.claude session cache) into <output>/claude-code/ as greppable markdown"
  )
  .option(
    "--claude-code-home <dir>",
    "Claude Code home dir. Default: $CLAUDE_CODE_HOME, else ~/.claude"
  )
  .option(
    "--output <path>",
    "Corpus root; content is written under <path>/claude-code/ (default: ./org-export)"
  )
  .option(
    "--fidelity <mode>",
    "Transcript fidelity: compact | truncated | full",
    parseFidelity,
    "compact" as ClaudeCodeFidelity
  )
  .option(
    "--truncate-cap <kb>",
    "In 'truncated' mode, inline cap (KB) per tool output before externalizing",
    parseIntArg,
    20
  )
  .option("--no-subagents", "Do not convert subagent sidechains")
  .option(
    "--skip-existing",
    "Skip sessions whose output directory already exists"
  )
  .option(
    "--skip-same",
    "Skip sessions unchanged since the last sync (uses .claudesync-state.json). Mutually exclusive with --skip-existing."
  )
  .option(
    "--preserve <glob>",
    "Glob (POSIX, relative to each session dir) of locally-added files to keep across re-syncs. Repeatable. CHANGELOG.md is always preserved.",
    (value: string, previous: string[] = []) => previous.concat(value),
    [] as string[]
  )
  .action(
    async (options: {
      claudeCodeHome?: string;
      output?: string;
      fidelity: ClaudeCodeFidelity;
      truncateCap: number;
      subagents: boolean;
      skipExisting?: boolean;
      skipSame?: boolean;
      preserve: string[];
    }) => {
      if (options.skipSame && options.skipExisting) {
        console.error(
          "error: --skip-same and --skip-existing are mutually exclusive"
        );
        process.exit(1);
      }

      const ccHome =
        options.claudeCodeHome ??
        process.env.CLAUDE_CODE_HOME ??
        path.join(os.homedir(), ".claude");
      const outputRoot = path.resolve(options.output ?? "./org-export");

      console.log(`Reading Claude Code sessions from ${ccHome} ...`);

      const abortController = new AbortController();
      const onSigint = () => {
        console.error(
          "\nInterrupted -- finishing the current session, then stopping..."
        );
        abortController.abort();
      };
      process.on("SIGINT", onSigint);

      try {
        const result = await runClaudeCodeSync(ccHome, {
          outputRoot,
          fidelity: options.fidelity,
          truncateCapBytes: options.truncateCap * 1024,
          includeSubagents: options.subagents,
          skipExisting: options.skipExisting,
          skipSame: options.skipSame,
          preserve: options.preserve,
          signal: abortController.signal,
          onProgress: renderProgress,
        });

        const aborted = abortController.signal.aborted;
        console.log(
          aborted
            ? `\nClaude Code export stopped (interrupted).`
            : `\nClaude Code export complete!`
        );
        console.log(`  Output: ${path.join(outputRoot, "claude-code")}`);
        console.log(`  Projects: ${result.projects}`);
        console.log(`  Sessions: ${result.sessions}`);
        console.log(`  Exported: ${result.exported}, Skipped: ${result.skipped}`);
        if (result.sessions === 0) {
          console.log(
            `  (No sessions found -- is ${ccHome}/projects the right Claude Code home?)`
          );
        }
        if (result.errors > 0) {
          console.log(`  Errors: ${result.errors}`);
        }
        if (aborted) {
          process.exitCode = 130;
        } else if (result.errors > 0) {
          process.exitCode = 1;
        }
      } finally {
        process.off("SIGINT", onSigint);
      }
    }
  );
