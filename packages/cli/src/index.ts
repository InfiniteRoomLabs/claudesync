#!/usr/bin/env node
import { Command } from "commander";
import { AuthError, ClaudeSyncError, RateLimitError } from "@infinite-room-labs/claudesync-core";
import { lsCommand } from "./commands/ls.js";
import { exportCommand } from "./commands/export.js";
import { projectsCommand } from "./commands/projects.js";
import { searchCommand } from "./commands/search.js";

const program = new Command();

program
  .name("claudesync")
  .description("ClaudeSync -- Export claude.ai conversations as git repositories")
  .version("0.2.1");

program.addCommand(lsCommand);
program.addCommand(exportCommand);
program.addCommand(projectsCommand);
program.addCommand(searchCommand);

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

// If no subcommand given and we have a TTY, launch interactive TUI
if (process.argv.length <= 2 && process.stdin.isTTY) {
  import("ink").then(async ({ render }) => {
    const { createElement } = await import("react");
    const { App } = await import("./tui/App.js");
    render(createElement(App));
  }).catch(handleError);
} else {
  // Show help if no args and no TTY, otherwise parse subcommand
  program.parseAsync(process.argv).catch(handleError);
}
