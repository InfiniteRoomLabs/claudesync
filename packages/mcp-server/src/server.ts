import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ClaudeSyncClient,
  EnvAuth,
  AuthError,
  ClaudeSyncError,
  hashContent,
  serializeEdits,
  parseEdits,
  mergeProjectMemoryControls,
  assertNoDelimiterEntries,
} from "@infinite-room-labs/claudesync-core";
import type { AuthProvider } from "@infinite-room-labs/claudesync-core";

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

/**
 * Normalize a raw controls array to the canonical on-disk form (trimmed,
 * blank entries dropped) by round-tripping through {@link serializeEdits} and
 * {@link parseEdits}. Mirrors the normalization
 * `packages/core/src/memory/push.ts`'s `normalizeControls` applies before
 * comparing merged controls against the live remote, so `put_project_memory_controls`
 * makes the same no-op decision the CLI push path would.
 *
 * @param entries - Raw control entries.
 * @returns The normalized entries, in the same relative order.
 */
function normalizeControls(entries: readonly string[]): string[] {
  return parseEdits(serializeEdits(Array.from(entries)));
}

/**
 * Compare two string arrays for exact equality: same length, same values,
 * same order.
 *
 * @param a - First array.
 * @param b - Second array.
 * @returns True if both arrays contain the same strings in the same order.
 */
function controlsArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * Content-free fingerprint of a controls array: the {@link hashContent} hash
 * of its canonical `edits.md` serialization ({@link serializeEdits}). Used to
 * report what changed in a `put_project_memory_controls` response without
 * ever including control text -- the tool's privacy contract.
 *
 * @param controls - Control entries, ideally already normalized via
 * {@link normalizeControls} so the hash is stable regardless of whitespace.
 * @returns The 64-character lowercase hex digest of the serialized form.
 */
function hashControls(controls: readonly string[]): string {
  return hashContent(serializeEdits(Array.from(controls)));
}

/**
 * Options accepted by {@link createServer}. Every field is optional: production
 * usage (`createServer()` with no arguments) derives everything from the
 * environment, while tests inject a fake {@link AuthProvider} and/or
 * {@link ClaudeSyncClient} and pin {@link CreateServerOptions.memoryWriteEnabled}
 * directly instead of mutating `process.env`.
 */
export interface CreateServerOptions {
  /**
   * Session-cookie provider used for every claude.ai API request and for
   * auto-detecting `orgId` on tools that accept it as optional. Defaults to
   * {@link resolveAuth}'s result (an `EnvAuth` reading `CLAUDE_AI_COOKIE`).
   */
  auth?: AuthProvider;
  /**
   * The claude.ai API client every tool handler calls through. Defaults to a
   * fresh {@link ClaudeSyncClient} constructed from `auth`. Tests inject a
   * fake object implementing just the methods the tools under test call.
   */
  client?: ClaudeSyncClient;
  /**
   * Gates registration of the `put_project_memory_controls` write tool: when
   * `false` (or omitted with the env var unset/mismatched), the tool is not
   * registered at all, so it never appears in `tools/list` and cannot be
   * called. Defaults to
   * `process.env.CLAUDESYNC_MCP_WRITE_SCOPE === "project-memory"` -- an
   * exact string match, so `"true"`, `"1"`, and `"all"` do NOT enable it.
   * Read-only tools are registered unconditionally either way.
   */
  memoryWriteEnabled?: boolean;
}

export function createServer(options?: CreateServerOptions): McpServer {
  const auth = options?.auth ?? resolveAuth();
  const client = options?.client ?? new ClaudeSyncClient(auth);
  const memoryWriteEnabled =
    options?.memoryWriteEnabled ?? process.env.CLAUDESYNC_MCP_WRITE_SCOPE === "project-memory";

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

  // --- list_projects ---
  server.tool(
    "list_projects",
    "List projects in a claude.ai organization. Returns project metadata including name, description, docs_count, and files_count.",
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
        const projects = await client.listProjects(resolvedOrgId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(projects, null, 2),
            },
          ],
        };
      });
    }
  );

  // --- get_project_docs ---
  server.tool(
    "get_project_docs",
    "Get knowledge file contents for a claude.ai project. Returns the list of project documents with their content.",
    {
      projectId: z
        .string()
        .describe("The project UUID to retrieve docs for"),
      orgId: z
        .string()
        .optional()
        .describe(
          "Organization UUID. Omit to auto-detect from session."
        ),
    },
    async ({ projectId, orgId }) => {
      return withErrorHandling(async () => {
        const resolvedOrgId =
          orgId ?? (await auth.getOrganizationId());
        const docs = await client.getProjectDocs(
          resolvedOrgId,
          projectId
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(docs, null, 2),
            },
          ],
        };
      });
    }
  );

  // --- get_project_memory ---
  server.tool(
    "get_project_memory",
    "Get a claude.ai project's memory: the server-generated memory document plus its ordered edit-instruction list (controls). Read-only.",
    {
      projectId: z.string().describe("The project UUID"),
      orgId: z
        .string()
        .optional()
        .describe(
          "Organization UUID. Omit to auto-detect from session."
        ),
    },
    async ({ projectId, orgId }) => {
      return withErrorHandling(async () => {
        const resolvedOrgId =
          orgId ?? (await auth.getOrganizationId());
        const mem = await client.getProjectMemory(
          resolvedOrgId,
          projectId
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(mem, null, 2),
            },
          ],
        };
      });
    }
  );

  // --- list_artifacts ---
  server.tool(
    "list_artifacts",
    "List artifact files in a conversation's wiggle filesystem. Returns file metadata including paths, sizes, and types.",
    {
      conversationId: z
        .string()
        .describe("The conversation UUID to list artifacts for"),
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
        const artifacts = await client.listArtifacts(
          resolvedOrgId,
          conversationId
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(artifacts, null, 2),
            },
          ],
        };
      });
    }
  );

  // --- download_artifact ---
  server.tool(
    "download_artifact",
    "Download an artifact file from a conversation's wiggle filesystem. Returns file content as text.",
    {
      conversationId: z
        .string()
        .describe("The conversation UUID that contains the artifact"),
      filePath: z
        .string()
        .describe(
          "Full path of the artifact file (e.g. /mnt/user-data/...)"
        ),
      orgId: z
        .string()
        .optional()
        .describe(
          "Organization UUID. Omit to auto-detect from session."
        ),
    },
    async ({ conversationId, filePath, orgId }) => {
      return withErrorHandling(async () => {
        const resolvedOrgId =
          orgId ?? (await auth.getOrganizationId());
        const content = await client.downloadArtifact(
          resolvedOrgId,
          conversationId,
          filePath
        );
        const text =
          typeof content === "string"
            ? content
            : `[Binary content: ${content.byteLength} bytes]`;
        return {
          content: [
            {
              type: "text" as const,
              text,
            },
          ],
        };
      });
    }
  );

  // --- put_project_memory_controls (gated write tool) ---
  if (memoryWriteEnabled) {
    server.tool(
      "put_project_memory_controls",
      "Write a claude.ai project's memory edit-instruction list (controls), three-way merging the caller's " +
        "desired list against the live remote so a concurrent edit made on claude.ai is not clobbered. This " +
        "triggers a synchronous server-side regeneration of the memory doc and can take up to about a minute " +
        "to return. The underlying write is NEVER retried automatically by this server, and callers MUST NOT " +
        "auto-retry after a timeout either -- a timeout does not mean the write failed, it may already be " +
        "applied server-side; re-read via get_project_memory and re-call this tool to reconcile instead. " +
        "Requires expectedUpdatedAt from a fresh get_project_memory read (refuses on any mismatch, i.e. a stale " +
        "read) and confirmProjectId equal to projectId as a deliberate confirmation gate checked before any " +
        "network call. Returns only content-free hashes and counts -- never memory or control text.",
      {
        projectId: z.string().describe("The project UUID to write memory controls for"),
        confirmProjectId: z
          .string()
          .describe(
            "Must exactly equal projectId. A deliberate confirmation gate checked before any GET or PUT, " +
              "to guard against an accidental write to the wrong project."
          ),
        orgId: z
          .string()
          .optional()
          .describe(
            "Organization UUID. Omit to auto-detect from session."
          ),
        expectedUpdatedAt: z
          .string()
          .describe(
            "The remote's updated_at from a fresh get_project_memory call. If the live remote's updated_at " +
              "no longer matches, the write is refused as a stale read rather than silently merged."
          ),
        baseControls: z
          .array(z.string())
          .describe(
            "The control entries the caller's desiredControls were derived from (the three-way merge base) -- " +
              "typically the controls list from the same read that produced expectedUpdatedAt."
          ),
        desiredControls: z
          .array(z.string())
          .describe(
            "The caller's desired full ordered control list after local edits. Merged against the live remote " +
              "controls using baseControls as the merge base before being sent."
          ),
      },
      async ({ projectId, confirmProjectId, orgId, expectedUpdatedAt, baseControls, desiredControls }) => {
        return withErrorHandling(async () => {
          if (confirmProjectId !== projectId) {
            throw new Error(
              `put_project_memory_controls: confirmProjectId ("${confirmProjectId}") does not equal projectId ` +
                `("${projectId}"). Refusing to write before any read or write call.`
            );
          }

          const resolvedOrgId = orgId ?? (await auth.getOrganizationId());
          const remote = await client.getProjectMemory(resolvedOrgId, projectId);

          if (remote.memory === "") {
            throw new Error(
              `put_project_memory_controls: project "${projectId}" has no memory generated yet (memory === ""). ` +
                "There is nothing to attach edit controls to."
            );
          }

          if (remote.updated_at !== expectedUpdatedAt) {
            throw new Error(
              `put_project_memory_controls: stale read -- the live remote's updated_at is "${remote.updated_at}" ` +
                `but expectedUpdatedAt was "${expectedUpdatedAt}". Re-read via get_project_memory and retry with ` +
                "the current value; this tool never silently merges over a stale read."
            );
          }

          const baseHashes = normalizeControls(baseControls).map(hashContent);
          assertNoDelimiterEntries(desiredControls);
          const remoteControls = remote.controls ?? [];
          const remoteNormalized = normalizeControls(remoteControls);
          const merge = mergeProjectMemoryControls(baseHashes, desiredControls, remoteControls);

          if (controlsArraysEqual(merge.controls, remoteNormalized)) {
            const sha = hashControls(remoteNormalized);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      action: "no-op",
                      before_controls_sha256: sha,
                      after_controls_sha256: sha,
                      before_updated_at: remote.updated_at,
                      after_updated_at: remote.updated_at,
                      controls_count: remoteNormalized.length,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

          const beforeControlsSha256 = hashControls(remoteNormalized);
          const beforeUpdatedAt = remote.updated_at;

          await client.putProjectMemoryControls(resolvedOrgId, projectId, merge.controls);

          const verifyRemote = await client.getProjectMemory(resolvedOrgId, projectId);

          if (verifyRemote.controls === null && merge.controls.length > 0) {
            throw new Error(
              `put_project_memory_controls: the PUT for project "${projectId}" completed, but the post-write ` +
                "verification read returned controls === null even though a non-empty list was sent. The server " +
                "did not persist the write -- it may not support initializing the edit list for this project. " +
                "Client edits were NOT applied; re-read via get_project_memory before retrying."
            );
          }

          const afterNormalized = normalizeControls(verifyRemote.controls ?? []);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    action: "written",
                    before_controls_sha256: beforeControlsSha256,
                    after_controls_sha256: hashControls(afterNormalized),
                    before_updated_at: beforeUpdatedAt,
                    after_updated_at: verifyRemote.updated_at,
                    controls_count: afterNormalized.length,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        });
      }
    );
  }

  return server;
}
