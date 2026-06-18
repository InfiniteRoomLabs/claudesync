import { Command } from "commander";
import { resolve } from "node:path";
import {
  ClaudeSource,
  FileSink,
  parseLocationUri,
  sync,
  safeSlug,
  displayName,
  type ExportFormat,
  type ItemRef,
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
  .option(
    "--preserve <glob>",
    "Glob (POSIX, relative to the conversation dir) of locally-added files to keep across re-syncs in --format files. Repeatable. CHANGELOG.md is always preserved.",
    (value: string, previous: string[] = []) => previous.concat(value),
    [] as string[],
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
      preserve: string[];
    }
  ) => {
    if (options.skipSame && options.skipExisting) {
      console.error("error: --skip-same and --skip-existing are mutually exclusive");
      process.exit(1);
    }

    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);

    // claude.ai expressed as a source surface.
    const source = new ClaudeSource(client, orgId, {
      authorName: options.authorName,
      authorEmail: options.authorEmail,
      skipArtifacts: options.skipArtifacts,
    });

    // Resolve the conversation (one cached list call inside the source) so we
    // can derive the default output path and detect not-found before syncing.
    let ref: ItemRef | undefined;
    for await (const r of source.list({ conversationId })) {
      ref = r;
      break;
    }
    if (!ref) {
      console.error(`Conversation not found: ${conversationId}`);
      process.exit(1);
      return; // unreachable after process.exit, helps the type narrower
    }

    const slug = safeSlug(ref.name, ref.id);
    const outputPath = resolve(options.output ?? `./${slug}`);

    // `--output ./x` -> `file:///abs/x?format=<fmt>`, dispatched through the
    // local-filesystem sink surface. Format is a property of the sink.
    const sinkUri = parseLocationUri(outputPath);
    sinkUri.query.format = options.format;
    const sink = FileSink.fromUri(sinkUri);

    const label = displayName(ref.name, ref.id);
    console.log(`Syncing conversation ${label} (${ref.id})`);
    console.log(`  Format: ${options.format}`);
    console.log(`  Output: ${outputPath}`);

    const [result] = await sync(source, [sink], {
      selector: { conversationId },
      format: options.format,
      authorName: options.authorName,
      authorEmail: options.authorEmail,
      skipSame: options.skipSame,
      skipExisting: options.skipExisting,
      preserve: options.preserve,
    });

    if (!result) return;

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
