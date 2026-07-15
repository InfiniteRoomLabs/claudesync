import { Command } from "commander";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import {
  ClaudeSyncClient,
  buildGitBundle,
  exportToGit,
  pullProjectMemory,
  readMemoryState,
  writeMemoryState,
  computePrincipalFingerprint,
  planProjectMemoryPush,
  applyProjectMemoryPush,
} from "@infinite-room-labs/claudesync-core";
import type {
  GitBundleCommit,
  PlanProjectMemoryPushOptions,
  ProjectMemoryPushPlan,
  ApplyProjectMemoryPushOptions,
  ProjectMemoryPushOutcome,
} from "@infinite-room-labs/claudesync-core";
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

memoryCommand
  .command("push")
  .description(
    "Push local memory edits to claude.ai (always fetches fresh and merges against the live remote; dry run by default)"
  )
  .argument("<project-id>", "Project UUID")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--output <dir>", "Local directory the project was pulled into (default: ./<project-id>)")
  .option("--apply", "Actually send the write (default is a dry run that sends nothing)")
  .option("--timeout <seconds>", "Timeout in seconds to wait for the write (default: 90)")
  .option(
    "--adopt-legacy-principal",
    "Migrate a Phase 1 organization-keyed local sidecar to the current account principal (requires --confirm-project)"
  )
  .option(
    "--confirm-project <project-id>",
    "Must exactly equal <project-id>; required by --adopt-legacy-principal"
  )
  .option("--json", "Output structured JSON instead of text")
  .action(async (
    projectId: string,
    options: {
      org?: string;
      output?: string;
      apply?: boolean;
      timeout?: string;
      adoptLegacyPrincipal?: boolean;
      confirmProject?: string;
      json?: boolean;
    }
  ) => {
    const { client, orgId, accountId } = await resolvePushPrincipal(options.org);
    const outputDir = options.output ?? defaultMemoryOutputDir(projectId);
    const dir = resolve(outputDir, "memory");

    if (options.adoptLegacyPrincipal) {
      if (options.confirmProject !== projectId) {
        console.error(
          `--adopt-legacy-principal requires --confirm-project to exactly equal "${projectId}".`
        );
        process.exitCode = 1;
        return;
      }
      const migration = adoptLegacyPrincipal({ dir, projectId, orgId, accountId });
      console.log(
        migration === "migrated"
          ? "Migrated the local memory sidecar from the organization principal to the account principal."
          : "The local memory sidecar is already keyed to the account principal; nothing to migrate."
      );
    }

    await runProjectMemoryPush({
      client,
      orgId,
      accountId,
      projectId,
      dir,
      apply: options.apply,
      timeoutMs: parseTimeoutSeconds(options.timeout),
      json: options.json,
    });
  });

const memoryEditsCommand = memoryCommand
  .command("edits")
  .description("Manage a project's local memory edit-control entries");

memoryEditsCommand
  .command("clear")
  .description(
    "Clear all local memory edit entries (base entries only -- a concurrent remote addition still survives the merge)"
  )
  .argument("<project-id>", "Project UUID")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--output <dir>", "Local directory the project was pulled into (default: ./<project-id>)")
  .option("--apply", "Actually send the write (default is a dry run that sends nothing)")
  .option("--confirm-project <project-id>", "Must exactly equal <project-id>; required by --apply")
  .option("--timeout <seconds>", "Timeout in seconds to wait for the write (default: 90)")
  .option("--json", "Output structured JSON instead of text")
  .action(async (
    projectId: string,
    options: {
      org?: string;
      output?: string;
      apply?: boolean;
      confirmProject?: string;
      timeout?: string;
      json?: boolean;
    }
  ) => {
    const { client, orgId, accountId } = await resolvePushPrincipal(options.org);
    const outputDir = options.output ?? defaultMemoryOutputDir(projectId);
    const dir = resolve(outputDir, "memory");

    await runProjectMemoryPush({
      client,
      orgId,
      accountId,
      projectId,
      dir,
      apply: options.apply,
      timeoutMs: parseTimeoutSeconds(options.timeout),
      json: options.json,
      localControlsOverride: [],
      applyGuard: () =>
        options.confirmProject === projectId
          ? undefined
          : `--apply requires --confirm-project to exactly equal "${projectId}".`,
    });
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

/**
 * Resolves the org id and account id used as the push principal, shared
 * verbatim by `projects memory push` and `projects memory edits clear` so
 * both commands derive `accountId` the exact same way (`createClient` +
 * `resolveOrgId` + `client.getAccount().uuid`) and stay interchangeable
 * against the same local sidecar.
 *
 * @param orgOption - The `--org` option as parsed by commander; auto-detected when omitted.
 * @returns The authenticated client, the resolved organization UUID, and the resolved account UUID.
 */
async function resolvePushPrincipal(
  orgOption: string | undefined
): Promise<{ client: ClaudeSyncClient; orgId: string; accountId: string }> {
  const { auth, client } = createClient();
  const orgId = await resolveOrgId(auth, orgOption);
  const account = await client.getAccount();
  return { client, orgId, accountId: account.uuid };
}

/**
 * Parses the `--timeout <seconds>` CLI option into the milliseconds
 * {@link ApplyProjectMemoryPushOptions.timeoutMs} expects. Validated eagerly
 * so a malformed value is rejected with a clear message before any network
 * I/O, rather than surfacing later as a `TypeError` from
 * `putProjectMemoryControls`.
 *
 * @param seconds - The raw `--timeout` option value, or undefined if the flag was not given.
 * @returns The value in milliseconds, or undefined if `seconds` was undefined.
 */
function parseTimeoutSeconds(seconds: string | undefined): number | undefined {
  if (seconds === undefined) {
    return undefined;
  }
  const parsedSeconds = Number(seconds);
  if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0) {
    console.error(`--timeout must be a positive number of seconds; got "${seconds}".`);
    process.exit(1);
  }
  return parsedSeconds * 1000;
}

/**
 * Starts a plain, escape-code-free elapsed-seconds ticker on a TTY stdout,
 * used while `--apply` waits out claude.ai's roughly one-minute memory
 * regeneration so the user sees the process is still alive. On a non-TTY
 * stdout (piped or redirected output) this is a no-op -- no interval is
 * started, and the returned stop function does nothing, so scripted/CI
 * invocations never see partial-line output.
 *
 * @returns A stop function; call it exactly once when the wait ends, whether
 * it succeeded or failed, to clear the interval and print a trailing newline.
 */
function startElapsedTimer(): () => void {
  if (!process.stdout.isTTY) {
    return () => {};
  }
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    process.stdout.write(`\r  ${elapsedSeconds}s elapsed...`);
  }, 1000);
  return () => {
    clearInterval(timer);
    process.stdout.write("\n");
  };
}

/**
 * Result of {@link adoptLegacyPrincipal}: whether the sidecar's fingerprint
 * was actually rewritten.
 */
type LegacyPrincipalMigration = "migrated" | "already-account-keyed";

/**
 * The sole sanctioned migration path for a Phase 1 (organization-keyed)
 * local memory sidecar: atomically rewrites only `principal_fingerprint` to
 * the account-uuid fingerprint via {@link writeMemoryState}, leaving
 * `edits.md`, `controls_base`, and every other sidecar field untouched.
 * Invoked by `projects memory push --adopt-legacy-principal
 * --confirm-project <id>` before the normal push flow runs, so the
 * subsequent {@link planProjectMemoryPush} call (which enforces the
 * account-fingerprint precondition) sees an already-migrated sidecar.
 *
 * @param opts.dir - The `memory/` directory holding the sidecar to migrate.
 * @param opts.projectId - Expected `project_uuid`; checked before any write.
 * @param opts.orgId - Organization UUID -- the Phase 1 principal input this
 * migration moves away from.
 * @param opts.accountId - Account UUID -- the Phase 2 principal input this
 * migration adopts.
 * @returns `"migrated"` if the fingerprint was rewritten, or
 * `"already-account-keyed"` if the sidecar already matched `accountId` and
 * nothing was written.
 * @throws Error if no sidecar exists in `opts.dir`.
 * @throws Error if the sidecar's `project_uuid` does not match `opts.projectId`.
 * @throws Error if the sidecar's `principal_fingerprint` matches neither the
 * organization fingerprint nor the account fingerprint -- adoption is
 * refused rather than silently overwriting an unrelated principal's sidecar.
 */
function adoptLegacyPrincipal(opts: {
  dir: string;
  projectId: string;
  orgId: string;
  accountId: string;
}): LegacyPrincipalMigration {
  const { dir, projectId, orgId, accountId } = opts;

  const state = readMemoryState(dir);
  if (state === undefined) {
    throw new Error(
      `adoptLegacyPrincipal: no project memory sidecar found in "${dir}". Run \`projects memory pull\` first.`
    );
  }
  if (state.project_uuid !== projectId) {
    throw new Error(
      `adoptLegacyPrincipal: the sidecar in "${dir}" belongs to project "${state.project_uuid}", not "${projectId}".`
    );
  }

  const accountFingerprint = computePrincipalFingerprint(accountId);
  if (state.principal_fingerprint === accountFingerprint) {
    return "already-account-keyed";
  }

  const orgFingerprint = computePrincipalFingerprint(orgId);
  if (state.principal_fingerprint !== orgFingerprint) {
    throw new Error(
      `adoptLegacyPrincipal: the sidecar in "${dir}" is fingerprinted to a principal that is neither the current ` +
        "organization nor the current account -- refusing to adopt. This looks like a sidecar synced under an " +
        "unrelated account; if that is not the case, re-run `projects memory pull --force` instead."
    );
  }

  writeMemoryState(dir, { ...state, principal_fingerprint: accountFingerprint });
  return "migrated";
}

/**
 * Options accepted by {@link runProjectMemoryPush}.
 */
interface RunProjectMemoryPushOptions {
  /** Client used for the fresh GET and, if `apply` is set, the PUT plus verification GET. */
  client: ClaudeSyncClient;
  /** Organization UUID the project belongs to. */
  orgId: string;
  /** Account UUID used as the push principal; see {@link PlanProjectMemoryPushOptions.accountId}. */
  accountId: string;
  /** Project UUID this push targets. */
  projectId: string;
  /** The `memory/` directory holding the sidecar, `MEMORY.md`, and `edits.md`. */
  dir: string;
  /** Whether to actually send the write (`--apply`); omitted or false is a dry run that sends nothing. */
  apply?: boolean;
  /** Millisecond timeout forwarded to `putProjectMemoryControls`, parsed from `--timeout <seconds>` via {@link parseTimeoutSeconds}. */
  timeoutMs?: number;
  /** Whether to print structured JSON (via {@link outputJson}) instead of human-readable text. */
  json?: boolean;
  /**
   * Forwarded to {@link planProjectMemoryPush} and {@link applyProjectMemoryPush}.
   * Omitted reads `edits.md` from `dir` (the `push` command); `[]` clears all
   * local base entries (the `edits clear` command).
   */
  localControlsOverride?: string[];
  /**
   * Checked only when `apply` is true, immediately before sending -- lets
   * `edits clear` require `--confirm-project` to match the positional project
   * id before anything is sent. Returning a string aborts the apply with
   * that string printed as an error and a nonzero exit; returning undefined
   * proceeds. Omitted for `push`, which has no such guard.
   */
  applyGuard?: () => string | undefined;
}

/**
 * Shared execution engine behind `projects memory push` and `projects
 * memory edits clear`. Always performs a fresh `getProjectMemory` GET and a
 * real {@link planProjectMemoryPush} call -- the plan is never trusted from
 * a prior run or skipped, per the design's "never blind-PUT" rule -- then
 * either prints a content-free dry-run summary (default) or, when `apply`
 * is set, calls {@link applyProjectMemoryPush} and prints its outcome.
 *
 * Never prints memory or control-entry text, on any path: only counts,
 * actions, timestamps, and hashes reach stdout/stderr, per the privacy
 * convention {@link ProjectMemoryPushPlan} and {@link ProjectMemoryPushOutcome}
 * document at the type level.
 *
 * @param opts - See {@link RunProjectMemoryPushOptions}.
 */
async function runProjectMemoryPush(opts: RunProjectMemoryPushOptions): Promise<void> {
  const { client, orgId, accountId, projectId, dir, apply, timeoutMs, json, localControlsOverride, applyGuard } =
    opts;

  const remote = await client.getProjectMemory(orgId, projectId);
  const plan: ProjectMemoryPushPlan = planProjectMemoryPush({
    remote,
    accountId,
    projectId,
    dir,
    localControlsOverride,
  });

  if (plan.action === "no-memory") {
    if (json) {
      outputJson({ action: "no-memory" });
    } else {
      console.log(
        "This project has no generated memory yet -- chat in it and wait for the nightly generation, then pull."
      );
    }
    return;
  }

  if (!apply) {
    if (json) {
      outputJson({
        action: plan.action,
        localAdds: plan.localAdds,
        localDeletes: plan.localDeletes,
        remoteAdds: plan.remoteAdds,
        remoteDeletes: plan.remoteDeletes,
        remoteUpdatedAt: plan.remoteUpdatedAt,
      });
    } else {
      console.log(
        `Plan: add ${plan.localAdds}, delete ${plan.localDeletes}, ${plan.remoteAdds} remote addition(s) preserved. ` +
          "Nothing sent -- re-run with --apply."
      );
    }
    return;
  }

  const guardError = applyGuard?.();
  if (guardError !== undefined) {
    console.error(guardError);
    process.exitCode = 1;
    return;
  }

  console.log("Updating project memory. claude.ai takes about 1 minute to regenerate it.");
  const stopTimer = startElapsedTimer();
  let outcome: ProjectMemoryPushOutcome;
  try {
    outcome = await applyProjectMemoryPush({
      client,
      orgId,
      accountId,
      projectId,
      dir,
      now: new Date().toISOString(),
      localControlsOverride,
      timeoutMs,
    });
  } finally {
    stopTimer();
  }

  printPushOutcome(outcome, json);
}

/**
 * Prints the content-free result of an applied {@link runProjectMemoryPush}
 * call. `"verify-mismatch"` is treated as a warning-level failure per the
 * design (the server did not persist the intended edits, most likely a
 * concurrent write racing this one) -- it is always printed to stderr, even
 * in `--json` mode, and sets a nonzero exit code.
 *
 * @param outcome - The result of {@link applyProjectMemoryPush}.
 * @param json - Whether to also print `outcome`'s content-free fields as JSON via {@link outputJson}.
 */
function printPushOutcome(outcome: ProjectMemoryPushOutcome, json?: boolean): void {
  if (json) {
    outputJson({
      action: outcome.action,
      controlsCount: outcome.controlsCount,
      memoryChanged: outcome.memoryChanged,
      remoteUpdatedAt: outcome.remoteUpdatedAt,
    });
  }

  switch (outcome.action) {
    case "written":
      if (!json) {
        console.log(`written: ${outcome.controlsCount} edit(s) now live.`);
      }
      break;
    case "unchanged":
      if (!json) {
        console.log("Already synchronized; nothing to push.");
      }
      break;
    case "no-memory":
      if (!json) {
        console.log(
          "This project has no generated memory yet -- chat in it and wait for the nightly generation, then pull."
        );
      }
      break;
    case "verify-mismatch":
      console.error(
        "Warning: the server did not persist the intended edits (a concurrent write may have raced this one). " +
          "MEMORY.md was updated and local edits were preserved -- re-run push."
      );
      process.exitCode = 1;
      break;
  }
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
