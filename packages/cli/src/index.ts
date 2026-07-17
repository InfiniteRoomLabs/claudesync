#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { AuthError, ClaudeSyncError, RateLimitError } from "@infinite-room-labs/claudesync-core";
import { lsCommand } from "./commands/ls.js";
import { exportCommand } from "./commands/export.js";
import { projectsCommand } from "./commands/projects.js";
import { searchCommand } from "./commands/search.js";
import { exportAllCommand } from "./commands/export-all.js";
import { claudeCodeCommand } from "./commands/claude-code.js";

/**
 * The package's own version, read from `package.json` at startup so
 * `claudesync --version` can never drift from the published version again
 * (it was hardcoded and stuck at 0.8.0 through two releases).
 */
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();

program
  .name("claudesync")
  .description("ClaudeSync -- Export claude.ai conversations as git repositories")
  .version(version);

program.addCommand(lsCommand);
program.addCommand(exportCommand);
program.addCommand(projectsCommand);
program.addCommand(searchCommand);
program.addCommand(exportAllCommand);
program.addCommand(claudeCodeCommand);

// TUI subcommand
program
  .command("tui")
  .description("Launch interactive browser (Miller Columns)")
  .action(async () => {
    const { render } = await import("ink");
    const { createElement } = await import("react");
    const { App } = await import("./tui/App.js");
    render(createElement(App));
  });

// Global error handling
program.hook("preAction", () => {
  process.on("unhandledRejection", handleError);
});

function handleError(error: unknown): void {
  if (error instanceof AuthError) {
    console.error(`Auth error: ${error.message}`);
    process.exit(1);
  }

  if (error instanceof RateLimitError) {
    console.error(
      `Rate limited. Try again in ${error.sleepSeconds} seconds.`
    );
    process.exit(1);
  }

  if (error instanceof ClaudeSyncError) {
    console.error(`API error: ${error.message}`);
    process.exit(1);
  }

  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  console.error("An unexpected error occurred.");
  process.exit(1);
}

program.parseAsync(process.argv).catch(handleError);
