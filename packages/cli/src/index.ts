#!/usr/bin/env node
import { Command } from "commander";
import { AuthError, ClaudeSyncError, RateLimitError } from "@claudesync/core";
import { lsCommand } from "./commands/ls.js";
import { exportCommand } from "./commands/export.js";
import { projectsCommand } from "./commands/projects.js";
import { searchCommand } from "./commands/search.js";

const program = new Command();

program
  .name("claudesync")
  .description("ClaudeSync -- Export claude.ai conversations as git repositories")
  .version("0.1.0");

program.addCommand(lsCommand);
program.addCommand(exportCommand);
program.addCommand(projectsCommand);
program.addCommand(searchCommand);

// Global error handling
program.hook("preAction", () => {
  // Set up unhandled rejection handler before each command
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
