import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ClaudeSyncClient,
  EnvAuth,
  AuthError,
  ClaudeSyncError,
} from "@claudesync/core";
import type { AuthProvider } from "@claudesync/core";

function resolveAuth(): AuthProvider {
  // Phase 1: EnvAuth only
  // FirefoxProfileAuth deferred to Phase 3
  if (process.env.CLAUDE_AI_COOKIE) {
    return new EnvAuth();
  }

  throw new AuthError(
    "CLAUDE_AI_COOKIE environment variable is required. " +
      "Get it from browser DevTools: Application > Cookies > claude.ai > sessionKey"
  );
}

/**
 * Wraps a tool handler to catch ClaudeSyncError and return MCP error content blocks
 * instead of crashing the server.
 */
function withErrorHandling(
  fn: () => Promise<{ content: Array<{ type: "text"; text: string }> }>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  return fn().catch((error: unknown) => {
    const message =
      error instanceof ClaudeSyncError
        ? `${error.name}: ${error.message}`
        : error instanceof AuthError
          ? `${error.name}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);

    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  });
}

export function createServer(): McpServer {
  const auth = resolveAuth();
  const client = new ClaudeSyncClient(auth);

  const server = new McpServer({
    name: "claudesync",
    version: "0.1.0",
  });

  // --- list_organizations ---
  server.tool(
    "list_organizations",
    "List claude.ai organizations accessible by this session",
    {},
    async () => {
      return withErrorHandling(async () => {
        const orgs = await client.listOrganizations();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(orgs, null, 2),
            },
          ],
        };
      });
    }
  );

  // --- list_conversations ---
  server.tool(
    "list_conversations",
    "List conversations in a claude.ai organization. Returns conversation metadata including names, models, and timestamps.",
    {
      orgId: z
        .string()
        .optional()
        .describe(
          "Organization UUID. Omit to auto-detect from session."
        ),
    },
    async ({ orgId }) => {
      return withErrorHandling(async () => {
        const resolvedOrgId =
          orgId ?? (await auth.getOrganizationId());
        const conversations =
          await client.listConversationsAll(resolvedOrgId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(conversations, null, 2),
            },
          ],
        };
      });
    }
  );

  // --- get_conversation ---
  server.tool(
    "get_conversation",
    "Get a full claude.ai conversation including all messages. Messages form a tree via parent_message_uuid for branching support.",
    {
      conversationId: z
        .string()
        .describe("The conversation UUID to retrieve"),
      orgId: z
        .string()
        .optional()
        .describe(
          "Organization UUID. Omit to auto-detect from session."
        ),
    },
    async ({ conversationId, orgId }) => {
      return withErrorHandling(async () => {
        const resolvedOrgId =
          orgId ?? (await auth.getOrganizationId());
        const conversation = await client.getConversation(
          resolvedOrgId,
          conversationId
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(conversation, null, 2),
            },
          ],
        };
      });
    }
  );

  // --- search_conversations ---
  server.tool(
    "search_conversations",
    "Search conversations by text query. Returns matching conversation chunks with context.",
    {
      query: z
        .string()
        .describe("Search query string"),
      orgId: z
        .string()
        .optional()
        .describe(
          "Organization UUID. Omit to auto-detect from session."
        ),
      limit: z
        .number()
        .optional()
        .describe(
          "Maximum number of results to return. Defaults to 20."
        ),
    },
    async ({ query, orgId, limit }) => {
      return withErrorHandling(async () => {
        const resolvedOrgId =
          orgId ?? (await auth.getOrganizationId());
        const results = await client.searchConversations(
          resolvedOrgId,
          query,
          limit ?? 20
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      });
    }
  );

  return server;
}
