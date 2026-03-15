import { Command } from "commander";
import type { ConversationSummary } from "@claudesync/core";
import { createClient, resolveOrgId, truncate, outputJson } from "../utils.js";

export const lsCommand = new Command("ls")
  .description("List conversations")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--limit <n>", "Max conversations to show", "20")
  .option("--starred", "Show only starred conversations")
  .option("--json", "Output as JSON instead of table")
  .option("--query <expression>", "JMESPath query to filter JSON output (implies --json)")
  .action(async (options: {
    org?: string;
    limit: string;
    starred?: boolean;
    json?: boolean;
    query?: string;
  }) => {
    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);
    const limit = parseInt(options.limit, 10);

    let conversations: ConversationSummary[] = [];
    for await (const conv of client.listConversations(orgId)) {
      if (options.starred && !conv.is_starred) {
        continue;
      }
      conversations.push(conv);
      if (conversations.length >= limit) {
        break;
      }
    }

    if (options.json || options.query) {
      outputJson(conversations, options.query);
      return;
    }

    if (conversations.length === 0) {
      console.log("No conversations found.");
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
