import { Command } from "commander";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  ClaudeSyncClient,
  buildGitBundle,
  exportToGit,
} from "@claudesync/core";
import type { GitBundleCommit } from "@claudesync/core";
import { createClient, resolveOrgId, truncate } from "../utils.js";

export const projectsCommand = new Command("projects")
  .description("List and export projects");

// --- projects list (default) ---
projectsCommand
  .command("list", { isDefault: true })
  .description("List projects")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--json", "Output as JSON instead of table")
  .action(async (options: { org?: string; json?: boolean }) => {
    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);

    const projects = await client.listProjects(orgId);

    if (options.json) {
      console.log(JSON.stringify(projects, null, 2));
      return;
    }

    if (projects.length === 0) {
      console.log("No projects found.");
      return;
    }

    const nameWidth = 30;
    const descWidth = 40;

    console.log(
      `  ${"Name".padEnd(nameWidth)}  ${"Description".padEnd(descWidth)}  Docs`
    );

    for (const project of projects) {
      const name = truncate(project.name, nameWidth);
      const desc = truncate(project.description ?? "", descWidth);
      const docs = project.docs_count ?? 0;
      console.log(
        `  ${name.padEnd(nameWidth)}  ${desc.padEnd(descWidth)}  ${docs}`
      );
    }

    console.log(`\n  ${projects.length} project(s) found.`);
  });

// --- projects export ---
projectsCommand
  .command("export")
  .description("Export an entire project (knowledge docs + all conversations + artifacts)")
  .argument("<project-id>", "Project UUID to export")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--output <path>", "Output directory (default: ./<project-name>)")
  .option("--format <format>", "Output format: git or json", "git")
  .option("--author-name <name>", "Git author name", "Claude")
  .option("--author-email <email>", "Git author email", "claude@anthropic.com")
  .option("--skip-artifacts", "Skip downloading artifacts (faster)")
  .action(async (
    projectId: string,
    options: {
      org?: string;
      output?: string;
      format: string;
      authorName: string;
      authorEmail: string;
      skipArtifacts?: boolean;
    }
  ) => {
    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);
    const author = { name: options.authorName, email: options.authorEmail };

    // 1. Fetch project metadata
    console.log(`Fetching project ${projectId}...`);
    const projects = await client.listProjects(orgId);
    const project = projects.find((p) => p.uuid === projectId);
    if (!project) {
      console.error(`Project ${projectId} not found.`);
      process.exit(1);
    }
    console.log(`  Name: ${project.name}`);
    console.log(`  Description: ${project.description ?? "(none)"}`);

    // 2. Fetch knowledge docs
    console.log("Fetching knowledge docs...");
    const docs = await client.getProjectDocs(orgId, projectId);
    console.log(`  Found ${docs.length} knowledge doc(s).`);

    // 3. Fetch project conversations
    console.log("Fetching project conversations...");
    const conversations = await client.getProjectConversations(orgId, projectId);
    console.log(`  Found ${conversations.length} conversation(s).`);

    // 4. Build commits
    const commits: GitBundleCommit[] = [];
    const now = new Date().toISOString();

    // Commit 1: Project README + knowledge docs
    const projectFiles: Record<string, string | Uint8Array> = {};

    projectFiles["README.md"] = buildProjectReadme(project, docs.length, conversations.length);

    for (const doc of docs) {
      const safeName = doc.file_name.replace(/[/\\]/g, "_");
      projectFiles[`knowledge/${safeName}`] = doc.content;
      console.log(`  Knowledge: ${safeName} (${doc.content.length} chars)`);
    }

    commits.push({
      message: `Export project: ${project.name}`,
      timestamp: project.created_at,
      author,
      files: projectFiles,
    });

    // 5. For each conversation: fetch full content + artifacts
    for (let i = 0; i < conversations.length; i++) {
      const convSummary = conversations[i];
      const progress = `[${i + 1}/${conversations.length}]`;
      console.log(`${progress} ${convSummary.name}...`);

      const conversation = await client.getConversation(orgId, convSummary.uuid);
      const slug = convSummary.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50);
      const convDir = `conversations/${slug}`;

      // Build conversation bundle and extract files
      let artifacts = { success: true, files: [] as string[], files_metadata: [] as any[] };
      const artifactContents = new Map<string, string | Uint8Array>();

      if (!options.skipArtifacts) {
        try {
          artifacts = await client.listArtifacts(orgId, convSummary.uuid);
          for (const meta of artifacts.files_metadata) {
            try {
              const content = await client.downloadArtifact(orgId, convSummary.uuid, meta.path);
              artifactContents.set(meta.path, content);
            } catch {
              // Skip failed downloads
            }
          }
          if (artifacts.files_metadata.length > 0) {
            console.log(`  ${progress} ${artifacts.files_metadata.length} artifact(s)`);
          }
        } catch {
          // Some conversations may not support artifacts
        }
      }

      const bundle = buildGitBundle(conversation, artifacts, artifactContents, {
        authorName: options.authorName,
        authorEmail: options.authorEmail,
      });

      // Remap file paths into conversation subdirectory
      for (const commit of bundle.commits) {
        const remappedFiles: Record<string, string | Uint8Array> = {};
        for (const [path, content] of Object.entries(commit.files)) {
          remappedFiles[`${convDir}/${path}`] = content;
        }
        commits.push({
          message: `${progress} ${commit.message}`,
          timestamp: commit.timestamp,
          author: commit.author,
          files: remappedFiles,
        });
      }
    }

    // 6. Output
    const projectSlug = project.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);

    const fullBundle = {
      metadata: {
        conversationId: projectId,
        conversationName: project.name,
        model: null,
        createdAt: project.created_at,
        exportedAt: now,
      },
      commits,
    };

    if (options.format === "json") {
      const outputPath = options.output;
      if (outputPath) {
        const fullPath = resolve(outputPath);
        writeFileSync(fullPath, JSON.stringify(fullBundle, null, 2), "utf-8");
        console.log(`\nBundle written to ${fullPath}`);
      } else {
        console.log(JSON.stringify(fullBundle, null, 2));
      }
    } else {
      const outputPath = resolve(options.output ?? `./${projectSlug}`);
      console.log(`\nExporting to git repository: ${outputPath}`);
      await exportToGit(fullBundle, outputPath);
      console.log(`\nExport complete!`);
      console.log(`  Repository: ${outputPath}`);
      console.log(`  Commits: ${commits.length}`);
      console.log(`  Knowledge docs: ${docs.length}`);
      console.log(`  Conversations: ${conversations.length}`);
    }
  });

function buildProjectReadme(
  project: { name: string; uuid: string; description?: string | null; created_at: string; updated_at: string },
  docCount: number,
  convCount: number,
): string {
  const lines: string[] = [];
  lines.push(`# ${project.name}`);
  lines.push("");
  if (project.description) {
    lines.push(project.description);
    lines.push("");
  }
  lines.push(`- **Project ID:** ${project.uuid}`);
  lines.push(`- **Created:** ${project.created_at}`);
  lines.push(`- **Updated:** ${project.updated_at}`);
  lines.push(`- **Knowledge docs:** ${docCount}`);
  lines.push(`- **Conversations:** ${convCount}`);
  lines.push("");
  lines.push("## Structure");
  lines.push("");
  lines.push("```");
  lines.push("knowledge/          # Project knowledge documents");
  lines.push("conversations/      # Exported conversations with artifacts");
  lines.push("```");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("Exported by [ClaudeSync](https://github.com/infiniteroomlabs/claudesync)");
  lines.push("");
  return lines.join("\n");
}
