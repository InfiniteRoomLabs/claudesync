import { Command } from "commander";
import { createClient, resolveOrgId, truncate } from "../utils.js";

export const searchCommand = new Command("search")
  .description("Search conversations")
  .argument("<query>", "Search query")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--limit <n>", "Max results to show", "10")
  .option("--json", "Output as JSON instead of table")
  .action(async (
    query: string,
    options: {
      org?: string;
      limit: string;
      json?: boolean;
    }
  ) => {
    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);
    const limit = parseInt(options.limit, 10);

    const results = await client.searchConversations(orgId, query, limit);

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.chunks.length === 0) {
      console.log(`No results found for "${query}".`);
      return;
    }

    console.log(`Found ${results.chunks.length} result(s) for "${query}":\n`);

    for (const chunk of results.chunks) {
      const title = chunk.extras.conversation_title ?? chunk.name;
      const preview = truncate(
        chunk.text.replace(/\n/g, " ").trim(),
        100
      );
      console.log(`  ${title}`);
      console.log(`    Conversation: ${chunk.extras.conversation_uuid}`);
      console.log(`    ${preview}`);
      console.log();
    }
  });
