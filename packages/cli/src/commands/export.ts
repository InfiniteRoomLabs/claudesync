import { Command } from "commander";
import { resolve } from "node:path";
import {
  syncConversation,
  safeSlug,
  displayName,
  type ExportFormat,
} from "@infinite-room-labs/claudesync-core";
import { createClient, resolveOrgId } from "../utils.js";

export const exportCommand = new Command("export")
  .description("Export a conversation to a git repository, file tree, or JSON")
  .argument("<conversation-id>", "Conversation UUID to export")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--output <path>", "Output directory (default: ./<conversation-name>)")
  .option("--format <format>", "Output format: git, json, or files", "git")
  .option("--author-name <name>", "Git author name", "Claude")
  .option("--author-email <email>", "Git author email", "claude@anthropic.com")
  .option("--skip-artifacts", "Skip downloading artifacts (faster)")
  .option(
    "--skip-existing",
    "Skip if the output directory already exists (no change detection)",
  )
  .option(
    "--skip-same",
    "Skip if the conversation is unchanged since the last sync. Mutually exclusive with --skip-existing.",
  )
  .action(async (
    conversationId: string,
    options: {
      org?: string;
      output?: string;
      format: ExportFormat;
      authorName: string;
      authorEmail: string;
      skipArtifacts?: boolean;
      skipExisting?: boolean;
      skipSame?: boolean;
    }
  ) => {
    if (options.skipSame && options.skipExisting) {
      console.error("error: --skip-same and --skip-existing are mutually exclusive");
      process.exit(1);
    }

    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);

    // For --skip-same we need the list-endpoint summary (cheap, no
    // chat_messages). Always fetch it so the cursor checks are accurate.
    const summaries = await client.listConversationsAll(orgId);
    const summary = summaries.find((c) => c.uuid === conversationId);
    if (!summary) {
      console.error(`Conversation not found: ${conversationId}`);
      process.exit(1);
      return; // unreachable after process.exit, helps the type narrower
    }

    const slug = safeSlug(summary.name, summary.uuid);
    const outputPath = resolve(options.output ?? `./${slug}`);

    const label = displayName(summary.name, summary.uuid);
    console.log(`Syncing conversation ${label} (${summary.uuid})`);
    console.log(`  Format: ${options.format}`);
    console.log(`  Output: ${outputPath}`);

    const result = await syncConversation(client, orgId, summary, outputPath, {
      format: options.format,
      authorName: options.authorName,
      authorEmail: options.authorEmail,
      skipSame: options.skipSame,
      skipExisting: options.skipExisting,
      skipArtifacts: options.skipArtifacts,
    });

    switch (result.action) {
      case "skipped":
        console.log(`Skipped (same): ${result.reason}`);
        break;
      case "skipped-existing":
        console.log(`Skipped (exists): ${result.reason}`);
        break;
      case "full":
        console.log(`Initial export complete.`);
        break;
      case "incremental":
        console.log(
          `Incremental sync complete${result.changelogWritten ? " (CHANGELOG updated)" : ""}.`,
        );
        break;
    }
  });
