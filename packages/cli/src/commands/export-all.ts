import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import {
  exportToGit,
  fetchAndBuild,
  syncConversation,
  safeSlug,
  displayName,
  type ExportFormat,
  type GitBundleCommit,
} from "@infinite-room-labs/claudesync-core";
import { createClient, resolveOrgId } from "../utils.js";

export const exportAllCommand = new Command("export-all")
  .description("Export entire organization: all projects (with knowledge + conversations) and standalone conversations")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--output <path>", "Output directory (default: ./org-export)")
  .option("--format <format>", "Output format: git, json, or files", "files")
  .option("--author-name <name>", "Git author name", "Claude")
  .option("--author-email <email>", "Git author email", "claude@anthropic.com")
  .option("--skip-artifacts", "Skip downloading artifacts (faster)")
  .option(
    "--skip-existing",
    "Skip conversations/projects whose output directory already exists",
  )
  .option(
    "--skip-same",
    "Skip conversations unchanged since the last sync (uses .claudesync-state.json sidecar). Mutually exclusive with --skip-existing.",
  )
  .action(async (options: {
    org?: string;
    output?: string;
    format: ExportFormat;
    authorName: string;
    authorEmail: string;
    skipArtifacts?: boolean;
    skipExisting?: boolean;
    skipSame?: boolean;
  }) => {
    if (options.skipSame && options.skipExisting) {
      console.error("error: --skip-same and --skip-existing are mutually exclusive");
      process.exit(1);
    }

    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);
    const author = { name: options.authorName, email: options.authorEmail };
    const outputRoot = resolve(options.output ?? "./org-export");

    console.log("Fetching organization data...");
    const [projects, allConversations] = await Promise.all([
      client.listProjects(orgId),
      client.listConversationsAll(orgId),
    ]);
    console.log(`  ${projects.length} project(s), ${allConversations.length} conversation(s) total`);

    const projectConvUuids = new Set<string>();

    // 1. Projects (knowledge + their conversations bundled into one repo).
    for (let pi = 0; pi < projects.length; pi++) {
      const project = projects[pi];
      const projectProgress = `[project ${pi + 1}/${projects.length}]`;
      const projectLabel = displayName(project.name, project.uuid);
      const projectSlug = safeSlug(project.name, project.uuid);
      const projectPath = resolve(outputRoot, "projects", projectSlug);

      if (options.skipExisting && existsSync(projectPath)) {
        console.log(`${projectProgress} Skipping (exists): ${projectLabel}`);
        const projConvs = await client.getProjectConversations(orgId, project.uuid);
        for (const c of projConvs) projectConvUuids.add(c.uuid);
        continue;
      }

      console.log(`${projectProgress} ${projectLabel}`);
      const docs = await client.getProjectDocs(orgId, project.uuid);
      const projConvs = await client.getProjectConversations(orgId, project.uuid);
      for (const c of projConvs) projectConvUuids.add(c.uuid);

      console.log(`  ${docs.length} knowledge doc(s), ${projConvs.length} conversation(s)`);

      const commits: GitBundleCommit[] = [];
      const projectFiles: Record<string, string | Uint8Array> = {};
      projectFiles["README.md"] = buildProjectReadme(project, docs.length, projConvs.length);
      for (const doc of docs) {
        const safeName = doc.file_name.replace(/[/\\]/g, "_");
        projectFiles[`knowledge/${safeName}`] = doc.content;
      }
      commits.push({
        message: `Export project: ${projectLabel}`,
        timestamp: project.created_at,
        author,
        files: projectFiles,
      });

      // Conversations within the project: route through fetchAndBuild for
      // identical name/slug fallbacks and tree handling. --skip-same does not
      // apply at this layer (the project repo is rebuilt as a unit each run).
      for (let ci = 0; ci < projConvs.length; ci++) {
        const convSummary = projConvs[ci];
        const convProgress = `  [${ci + 1}/${projConvs.length}]`;

        const built = await fetchAndBuild(client, orgId, convSummary, {
          authorName: options.authorName,
          authorEmail: options.authorEmail,
          skipArtifacts: options.skipArtifacts,
          multiBranch: true,
        });
        console.log(`${convProgress} ${built.displayName}`);

        const convDir = `conversations/${built.slug}`;
        for (const commit of built.bundle.commits) {
          const remappedFiles: Record<string, string | Uint8Array> = {};
          for (const [p, content] of Object.entries(commit.files)) {
            remappedFiles[`${convDir}/${p}`] = content;
          }
          commits.push({ ...commit, files: remappedFiles });
        }
      }

      const bundle = {
        metadata: {
          conversationId: project.uuid,
          conversationName: projectLabel,
          model: null,
          createdAt: project.created_at,
          exportedAt: new Date().toISOString(),
        },
        commits,
      };

      await writeProjectBundle(bundle, projectPath, options.format);
    }

    // 2. Standalone conversations -- --skip-same applies here per conversation.
    const standaloneConvs = allConversations.filter(
      (c) => !c.project_uuid && !projectConvUuids.has(c.uuid),
    );
    console.log(`\n${standaloneConvs.length} standalone conversation(s) to export`);

    for (let ci = 0; ci < standaloneConvs.length; ci++) {
      const convSummary = standaloneConvs[ci];
      const convProgress = `[conv ${ci + 1}/${standaloneConvs.length}]`;
      const convPath = resolve(
        outputRoot,
        "conversations",
        safeSlug(convSummary.name, convSummary.uuid),
      );

      try {
        const result = await syncConversation(client, orgId, convSummary, convPath, {
          format: options.format,
          authorName: options.authorName,
          authorEmail: options.authorEmail,
          skipSame: options.skipSame,
          skipExisting: options.skipExisting,
          skipArtifacts: options.skipArtifacts,
        });
        const tag =
          result.action === "skipped" ? "Skipping (same)" :
          result.action === "skipped-existing" ? "Skipping (exists)" :
          result.action === "incremental" ? "Updated" : "Exported";
        console.log(`${convProgress} ${tag}: ${result.displayName}`);
      } catch (err) {
        const fallback = displayName(convSummary.name, convSummary.uuid);
        console.error(`${convProgress} ERROR exporting ${fallback}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`\nOrg export complete!`);
    console.log(`  Output: ${outputRoot}`);
    console.log(`  Projects: ${projects.length}`);
    console.log(`  Standalone conversations: ${standaloneConvs.length}`);
  });

async function writeProjectBundle(
  bundle: { metadata: { conversationId: string; conversationName: string; model: string | null; createdAt: string; exportedAt: string }; commits: GitBundleCommit[] },
  outputPath: string,
  format: ExportFormat,
): Promise<void> {
  if (format === "json") {
    writeFileSync(outputPath + ".json", JSON.stringify(bundle, null, 2), "utf-8");
    return;
  }
  if (existsSync(outputPath)) {
    rmSync(outputPath, { recursive: true, force: true });
  }
  await exportToGit(bundle, outputPath);
  if (format === "files") {
    rmSync(resolve(outputPath, ".git"), { recursive: true, force: true });
  }
}

function buildProjectReadme(
  project: { name: string; uuid: string; description?: string | null; created_at: string; updated_at: string },
  docCount: number,
  convCount: number,
): string {
  const lines: string[] = [];
  lines.push(`# ${displayName(project.name, project.uuid)}`);
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
