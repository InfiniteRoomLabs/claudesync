import { Command } from "commander";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import {
  ClaudeSyncClient,
  buildGitBundle,
  exportToGit,
} from "@claudesync/core";
import { createClient, resolveOrgId } from "../utils.js";

export const exportCommand = new Command("export")
  .description("Export a conversation to a git repository")
  .argument("<conversation-id>", "Conversation UUID to export")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--output <path>", "Output directory (default: ./<conversation-name>)")
  .option("--format <format>", "Output format: git or json", "git")
  .option("--author-name <name>", "Git author name", "Claude")
  .option("--author-email <email>", "Git author email", "claude@anthropic.com")
  .action(async (
    conversationId: string,
    options: {
      org?: string;
      output?: string;
      format: string;
      authorName: string;
      authorEmail: string;
    }
  ) => {
    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);

    // 1. Fetch conversation
    console.log(`Fetching conversation ${conversationId}...`);
    const conversation = await client.getConversation(orgId, conversationId);
    console.log(`  Name: ${conversation.name}`);
    console.log(`  Messages: ${conversation.chat_messages.length}`);

    // 2. Fetch artifacts
    console.log("Fetching artifacts...");
    const artifacts = await client.listArtifacts(orgId, conversationId);
    console.log(`  Found ${artifacts.files_metadata.length} artifact(s).`);

    // 3. Download artifact contents
    const artifactContents = new Map<string, string | Uint8Array>();
    for (const meta of artifacts.files_metadata) {
      const filename = ClaudeSyncClient.safeFilename(meta.path);
      console.log(`  Downloading: ${filename}`);
      const content = await client.downloadArtifact(
        orgId,
        conversationId,
        meta.path
      );
      artifactContents.set(meta.path, content);
    }

    // 4. Build GitBundle
    console.log("Building export bundle...");
    const bundle = buildGitBundle(conversation, artifacts, artifactContents, {
      authorName: options.authorName,
      authorEmail: options.authorEmail,
    });

    // 5. Output
    if (options.format === "json") {
      const outputPath = options.output;
      if (outputPath) {
        const fullPath = resolve(outputPath);
        writeFileSync(fullPath, JSON.stringify(bundle, null, 2), "utf-8");
        console.log(`\nBundle written to ${fullPath}`);
      } else {
        console.log(JSON.stringify(bundle, null, 2));
      }
    } else {
      // git format
      const slug = conversation.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
      const outputPath = resolve(options.output ?? `./${slug}`);

      console.log(`Exporting to git repository: ${outputPath}`);
      await exportToGit(bundle, outputPath);
      console.log(`\nExport complete!`);
      console.log(`  Repository: ${outputPath}`);
      console.log(`  Commits: ${bundle.commits.length}`);
    }
  });
