import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import {
  ClaudeSyncClient,
  buildGitBundle,
  exportToGit,
} from "@infinite-room-labs/claudesync-core";
import type { GitBundleCommit } from "@infinite-room-labs/claudesync-core";
import { createClient, resolveOrgId } from "../utils.js";

export const exportAllCommand = new Command("export-all")
  .description("Export entire organization: all projects (with knowledge + conversations) and standalone conversations")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--output <path>", "Output directory (default: ./org-export)")
  .option("--format <format>", "Output format: git, json, or files", "files")
  .option("--author-name <name>", "Git author name", "Claude")
  .option("--author-email <email>", "Git author email", "claude@anthropic.com")
  .option("--skip-artifacts", "Skip downloading artifacts (faster)")
  .option("--skip-existing", "Skip conversations/projects whose output directory already exists")
  .action(async (options: {
    org?: string;
    output?: string;
    format: string;
    authorName: string;
    authorEmail: string;
    skipArtifacts?: boolean;
    skipExisting?: boolean;
  }) => {
    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);
    const author = { name: options.authorName, email: options.authorEmail };
    const outputRoot = resolve(options.output ?? "./org-export");

    // 1. Fetch all projects and all conversations up front
    console.log("Fetching organization data...");
    const [projects, allConversations] = await Promise.all([
      client.listProjects(orgId),
      client.listConversationsAll(orgId),
    ]);
    console.log(`  ${projects.length} project(s), ${allConversations.length} conversation(s) total`);

    // Track which conversations belong to projects so we can export the rest standalone
    const projectConvUuids = new Set<string>();

    // 2. Export each project
    for (let pi = 0; pi < projects.length; pi++) {
      const project = projects[pi];
      const projectProgress = `[project ${pi + 1}/${projects.length}]`;
      const projectSlug = slugify(project.name);
      const projectPath = resolve(outputRoot, "projects", projectSlug);

      if (options.skipExisting && existsSync(projectPath)) {
        console.log(`${projectProgress} Skipping (exists): ${project.name}`);
        // Still need to mark its conversations as project-owned
        const projConvs = await client.getProjectConversations(orgId, project.uuid);
        for (const c of projConvs) projectConvUuids.add(c.uuid);
        continue;
      }

      console.log(`${projectProgress} ${project.name}`);

      const docs = await client.getProjectDocs(orgId, project.uuid);
      const projConvs = await client.getProjectConversations(orgId, project.uuid);
      for (const c of projConvs) projectConvUuids.add(c.uuid);

      console.log(`  ${docs.length} knowledge doc(s), ${projConvs.length} conversation(s)`);

      const commits: GitBundleCommit[] = [];
      const now = new Date().toISOString();

      // First commit: project README + knowledge docs
      const projectFiles: Record<string, string | Uint8Array> = {};
      projectFiles["README.md"] = buildProjectReadme(project, docs.length, projConvs.length);
      for (const doc of docs) {
        const safeName = doc.file_name.replace(/[/\\]/g, "_");
        projectFiles[`knowledge/${safeName}`] = doc.content;
      }
      commits.push({
        message: `Export project: ${project.name}`,
        timestamp: project.created_at,
        author,
        files: projectFiles,
      });

      // Subsequent commits: each conversation + artifacts
      for (let ci = 0; ci < projConvs.length; ci++) {
        const convSummary = projConvs[ci];
        const convProgress = `  [${ci + 1}/${projConvs.length}]`;
        console.log(`${convProgress} ${convSummary.name}`);

        const convCommits = await exportConversation(
          client, orgId, convSummary.uuid, convSummary.name, author, !options.skipArtifacts, convProgress,
        );

        const convDir = `conversations/${slugify(convSummary.name)}`;
        for (const commit of convCommits) {
          const remappedFiles: Record<string, string | Uint8Array> = {};
          for (const [path, content] of Object.entries(commit.files)) {
            remappedFiles[`${convDir}/${path}`] = content;
          }
          commits.push({ ...commit, files: remappedFiles });
        }
      }

      const bundle = {
        metadata: {
          conversationId: project.uuid,
          conversationName: project.name,
          model: null,
          createdAt: project.created_at,
          exportedAt: now,
        },
        commits,
      };

      await writeOutput(bundle, projectPath, options.format);
    }

    // 3. Export standalone conversations (not in any project)
    const standaloneConvs = allConversations.filter(
      (c) => !c.project_uuid && !projectConvUuids.has(c.uuid)
    );
    console.log(`\n${standaloneConvs.length} standalone conversation(s) to export`);

    for (let ci = 0; ci < standaloneConvs.length; ci++) {
      const convSummary = standaloneConvs[ci];
      const convProgress = `[conv ${ci + 1}/${standaloneConvs.length}]`;
      const convSlug = slugify(convSummary.name);
      const convPath = resolve(outputRoot, "conversations", convSlug);

      if (options.skipExisting && existsSync(convPath)) {
        console.log(`${convProgress} Skipping (exists): ${convSummary.name}`);
        continue;
      }

      console.log(`${convProgress} ${convSummary.name}`);

      const conversation = await client.getConversation(orgId, convSummary.uuid);
      let artifacts = { success: true, files: [] as string[], files_metadata: [] as { path: string; size: number; content_type: string; created_at: string; custom_metadata: { filename: string } }[] };
      const artifactContents = new Map<string, string | Uint8Array>();

      if (!options.skipArtifacts) {
        try {
          artifacts = await client.listArtifacts(orgId, convSummary.uuid);
          for (const meta of artifacts.files_metadata) {
            try {
              const content = await client.downloadArtifact(orgId, convSummary.uuid, meta.path);
              artifactContents.set(meta.path, content);
            } catch {
              // Skip failed artifact downloads
            }
          }
          if (artifacts.files_metadata.length > 0) {
            console.log(`  ${convProgress} ${artifacts.files_metadata.length} artifact(s)`);
          }
        } catch {
          // Some conversations may not support artifacts
        }
      }

      const bundle = buildGitBundle(conversation, artifacts, artifactContents, {
        authorName: options.authorName,
        authorEmail: options.authorEmail,
      });

      await writeOutput(bundle, convPath, options.format);
    }

    // 4. Summary
    console.log(`\nOrg export complete!`);
    console.log(`  Output: ${outputRoot}`);
    console.log(`  Projects: ${projects.length}`);
    console.log(`  Standalone conversations: ${standaloneConvs.length}`);
  });

/** Fetch a single conversation and its artifacts, returning GitBundleCommit[] */
async function exportConversation(
  client: ClaudeSyncClient,
  orgId: string,
  convId: string,
  convName: string,
  author: { name: string; email: string },
  fetchArtifacts: boolean,
  progressPrefix: string,
): Promise<GitBundleCommit[]> {
  const conversation = await client.getConversation(orgId, convId);

  let artifacts = { success: true, files: [] as string[], files_metadata: [] as { path: string; size: number; content_type: string; created_at: string; custom_metadata: { filename: string } }[] };
  const artifactContents = new Map<string, string | Uint8Array>();

  if (fetchArtifacts) {
    try {
      artifacts = await client.listArtifacts(orgId, convId);
      for (const meta of artifacts.files_metadata) {
        try {
          const content = await client.downloadArtifact(orgId, convId, meta.path);
          artifactContents.set(meta.path, content);
        } catch {
          // Skip failed artifact downloads
        }
      }
      if (artifacts.files_metadata.length > 0) {
        console.log(`${progressPrefix} ${artifacts.files_metadata.length} artifact(s)`);
      }
    } catch {
      // Some conversations may not support artifacts
    }
  }

  const bundle = buildGitBundle(conversation, artifacts, artifactContents, {
    authorName: author.name,
    authorEmail: author.email,
  });

  return bundle.commits;
}

/** Write a bundle to disk in the requested format */
async function writeOutput(
  bundle: { metadata: { conversationId: string; conversationName: string; model: string | null; createdAt: string; exportedAt: string }; commits: GitBundleCommit[] },
  outputPath: string,
  format: string,
): Promise<void> {
  if (format === "json") {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outputPath + ".json", JSON.stringify(bundle, null, 2), "utf-8");
  } else {
    await exportToGit(bundle, outputPath);

    // "files" format: reuse exportToGit for the file tree, then strip .git.
    // Fast-and-simple approach -- if this becomes a hot path, write a dedicated
    // flat file exporter that skips git init/stage/commit entirely.
    if (format === "files") {
      rmSync(resolve(outputPath, ".git"), { recursive: true, force: true });
    }
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

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
