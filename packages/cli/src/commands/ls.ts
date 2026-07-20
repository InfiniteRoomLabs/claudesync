import { Command } from "commander";
import type { ConversationSummary } from "@infinite-room-labs/claudesync-core";
import { resolveBehaviorConfig, summaryLooksEmpty } from "@infinite-room-labs/claudesync-core";
import { createClient, resolveOrgId, truncate, outputJson } from "../utils.js";

export const lsCommand = new Command("ls")
  .description("List conversations")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--limit <n>", "Max conversations to show", "20")
  .option("--starred", "Show only starred conversations")
  .option(
    "--include-empty",
    "Include conversations with no human messages (hidden by default). ls's hide" +
      " signal is the list-level draft marker (current_leaf_message_uuid being" +
      " null) -- a cheap subset check of the full no-human-messages check that" +
      " export/export-all use, so a conversation ls shows as non-empty can still" +
      " turn out empty once fetched."
  )
  .option("--json", "Output as JSON instead of table")
  .option("--query <expression>", "JMESPath query to filter JSON output (implies --json)")
  .action(async (options: {
    org?: string;
    limit: string;
    starred?: boolean;
    includeEmpty?: boolean;
    json?: boolean;
    query?: string;
  }) => {
    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);
    const limit = parseInt(options.limit, 10);

    const behaviorConfig = resolveBehaviorConfig({
      skipEmptyConversations: options.includeEmpty ? false : undefined,
    });
    const skipEmpty = behaviorConfig.skipEmptyConversations;

    let conversations: ConversationSummary[] = [];
    let totalSeen = 0;
    let hiddenEmpty = 0;
    for await (const conv of client.listConversations(orgId)) {
      totalSeen++;
      if (options.starred && !conv.is_starred) {
        continue;
      }
      if (skipEmpty && summaryLooksEmpty(conv)) {
        hiddenEmpty++;
        continue;
      }
      conversations.push(conv);
      if (conversations.length >= limit) {
        break;
      }
    }

    if (hiddenEmpty > 0) {
      console.error(`${hiddenEmpty} empty conversation(s) hidden; use --include-empty`);
    }

    if (options.json || options.query) {
      outputJson(conversations, options.query);
      return;
    }

    if (conversations.length === 0) {
      if (totalSeen > 0 && hiddenEmpty === totalSeen) {
        console.log(
          `All ${hiddenEmpty} conversations are empty drafts (hidden); use --include-empty`
        );
      } else {
        console.log("No conversations.");
      }
      return;
    }

    // Table output
    const uuidWidth = 36;
    const modelWidth = 20;

    console.log(
      `  ${"UUID".padEnd(uuidWidth)}  ${"Model".padEnd(modelWidth)}  Name`
    );

    for (const conv of conversations) {
      const uuid = conv.uuid;
      const model = truncate(conv.model ?? "unknown", modelWidth);
      const name = truncate(conv.name, 60);
      console.log(
        `  ${uuid.padEnd(uuidWidth)}  ${model.padEnd(modelWidth)}  ${name}`
      );
    }

    console.log(`\n  ${conversations.length} conversation(s) shown.`);
    console.log(`  Export a conversation: claudesync export <UUID>`);
  });
