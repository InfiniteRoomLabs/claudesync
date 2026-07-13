import { Command } from "commander";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import {
  ClaudeSyncClient,
  buildGitBundle,
  exportToGit,
  pullProjectMemory,
  readMemoryState,
  computePrincipalFingerprint,
} from "@infinite-room-labs/claudesync-core";
import type { GitBundleCommit } from "@infinite-room-labs/claudesync-core";
import { createClient, resolveOrgId, truncate, outputJson } from "../utils.js";

export const projectsCommand = new Command("projects")
  .description("List and export projects");

// --- projects list (default) ---
projectsCommand
  .command("list", { isDefault: true })
  .description("List projects")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--json", "Output as JSON instead of table")
  .option("--query <expression>", "JMESPath query to filter JSON output (implies --json)")
  .action(async (options: { org?: string; json?: boolean; query?: string }) => {
    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);

    const projects = await client.listProjects(orgId);

    if (options.json || options.query) {
      outputJson(projects, options.query);
      return;
    }

    if (projects.length === 0) {
      console.log("No projects found.");
      return;
    }

    console.log(
      `  ${"UUID".padEnd(38)}  ${"Name".padEnd(30)}  Docs`
    );

    for (const project of projects) {
      const name = truncate(project.name, 30);
      const docs = project.docs_count ?? 0;
      console.log(
        `  ${project.uuid.padEnd(38)}  ${name.padEnd(30)}  ${docs}`
      );
    }

    console.log(`\n  ${projects.length} project(s) found.`);
    console.log(`  Export a project: claudesync projects export <UUID>`);
  });

// --- projects export ---
projectsCommand
  .command("export")
  .description("Export an entire project (knowledge docs + all conversations + artifacts)")
  .argument("<project-id>", "Project UUID to export")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--output <path>", "Output directory (default: ./<project-name>)")
  .option("--format <format>", "Output format: git, json, or files", "git")
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
      // git and files formats both use exportToGit for the file tree
      const outputPath = resolve(options.output ?? `./${projectSlug}`);
      console.log(`\nExporting to ${options.format === "files" ? "file tree" : "git repository"}: ${outputPath}`);
      await exportToGit(fullBundle, outputPath);

      // "files" format: reuse exportToGit for the file tree, then strip .git.
      // Fast-and-simple approach -- if this becomes a hot path, write a dedicated
      // flat file exporter that skips git init/stage/commit entirely.
      if (options.format === "files") {
        rmSync(resolve(outputPath, ".git"), { recursive: true, force: true });
      }

      console.log(`\nExport complete!`);
      console.log(`  ${options.format === "files" ? "Directory" : "Repository"}: ${outputPath}`);
      if (options.format === "git") {
        console.log(`  Commits: ${commits.length}`);
      }
      console.log(`  Knowledge docs: ${docs.length}`);
      console.log(`  Conversations: ${conversations.length}`);
    }
  });

// --- projects memory ---
const memoryCommand = projectsCommand
  .command("memory")
  .description("View and sync a project's memory (the generated doc + edit list)");

memoryCommand
  .command("show")
  .description("Fetch and print a project's generated memory doc")
  .argument("<project-id>", "Project UUID")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--json", "Output raw memory JSON")
  .action(async (projectId: string, options: { org?: string; json?: boolean }) => {
    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);
    const mem = await client.getProjectMemory(orgId, projectId);

    if (options.json) {
      outputJson(mem);
      return;
    }
    if (mem.controls === null && mem.memory === "") {
      console.log("This project has no generated memory yet.");
      return;
    }
    console.log(mem.memory);
    console.log(`\n  ${mem.controls?.length ?? 0} edit(s)`);
  });

memoryCommand
  .command("pull")
  .description("Pull a project's memory doc + edit list into a local directory")
  .argument("<project-id>", "Project UUID")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--output <dir>", "Output directory (default: ./<project-id>)")
  .option("--force", "Overwrite local changes that conflict with the remote update")
  .action(async (
    projectId: string,
    options: { org?: string; output?: string; force?: boolean }
  ) => {
    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);
    const remote = await client.getProjectMemory(orgId, projectId);

    const outputDir = options.output ?? defaultMemoryOutputDir(projectId);
    const dir = resolve(outputDir, "memory");

    // The auth layer exposes only an org id (no separate account id), and it
    // is 1:1 with the account for this tool -- reuse it as the principal
    // fingerprint input passed to pullProjectMemory. `status` below MUST
    // derive accountId the same way (resolveOrgId, no other transform) so
    // the fingerprints recorded in the sidecar line up across commands.
    // Phase 1 uses the org id as the principal (single-member-org
    // assumption); a per-user account id from /api/account is a Phase 2
    // upgrade.
    const outcome = pullProjectMemory({
      remote,
      accountId: orgId,
      projectId,
      dir,
      now: new Date().toISOString(),
      force: options.force,
    });

    switch (outcome.action) {
      case "no-memory":
        console.log(
          "This project has no generated memory yet -- chat in it and wait for the nightly generation."
        );
        break;
      case "conflict":
        console.log("Local changes conflict with the remote update. Re-run with --force to overwrite.");
        break;
      case "written":
        console.log(`written: ${dir} (${outcome.controlsCount} edit(s))`);
        break;
      case "unchanged":
        console.log(`unchanged: ${dir} (${outcome.controlsCount} edit(s))`);
        break;
    }
  });

memoryCommand
  .command("status")
  .description("Report whether a local memory pull is clean, stale, or missing")
  .argument("<project-id>", "Project UUID")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--output <dir>", "Local directory the project was pulled into (default: ./<project-id>)")
  .action(async (projectId: string, options: { org?: string; output?: string }) => {
    const { auth } = createClient();
    const orgId = await resolveOrgId(auth, options.org);

    const outputDir = options.output ?? defaultMemoryOutputDir(projectId);
    const dir = resolve(outputDir, "memory");

    console.log(describeMemoryStatus(dir, orgId));
  });

/**
 * Default local directory a `projects memory` subcommand reads from or
 * writes into when `--output` is not given. Uses the project UUID directly
 * (unlike `projects export`, which slugifies the project's display name) --
 * memory commands never fetch project metadata beyond the memory doc itself.
 *
 * @param projectId - Project UUID.
 * @returns `./<project-id>`.
 */
function defaultMemoryOutputDir(projectId: string): string {
  return `./${projectId}`;
}

/**
 * Reports a content-free, one-line status for a project's local memory pull.
 *
 * Deliberately does not replicate `pullProjectMemory`'s full read-side merge
 * decision (remote-snapshot hashing, per-file dirty checks against the
 * sidecar's recorded base) -- that logic depends on an unexported internal
 * hash formula (`snapshotHash`), and reimplementing it here would duplicate
 * pull's engine and risk silently drifting out of sync with it. Instead this
 * makes a single network-free check the sidecar can already answer: whether
 * a pull has ever happened, when, and whether it was made under the account
 * currently resolved (same org-id-as-principal convention `pull` uses).
 *
 * @param dir - The `memory/` directory a prior `pull` would have written into.
 * @param accountId - The resolved org id, used identically to how `pull` derives `accountId`.
 * @returns One of: "no local pull", "local pull present but was made under a
 * different account ..." (principal fingerprint mismatch), or "local pull
 * present (last pulled ...); run pull to check for updates".
 */
function describeMemoryStatus(dir: string, accountId: string): string {
  const prior = readMemoryState(dir);
  if (prior === undefined) {
    return "no local pull";
  }

  // Phase 1 uses the org id as the principal (single-member-org assumption);
  // a per-user account id from /api/account is a Phase 2 upgrade.
  const principalFingerprint = computePrincipalFingerprint(accountId);
  if (prior.principal_fingerprint !== principalFingerprint) {
    return (
      `local pull present but was made under a different account (last pulled ${prior.last_pull_at}); ` +
      "run pull --force to confirm and overwrite."
    );
  }

  return `local pull present (last pulled ${prior.last_pull_at}); run pull to check for updates.`;
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
