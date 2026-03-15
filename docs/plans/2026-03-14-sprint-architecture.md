# ClaudeSync Sprint Architecture Plan

**Date:** 2026-03-14
**Status:** Active
**Sprint Goal:** Deliver @claudesync/core SDK + @claudesync/mcp-server with 7 tools

---

## Architecture Overview

Three-layer design, two packages built this sprint:

```
@claudesync/mcp-server (thin shell, 7 tools)
        |
@claudesync/core (SDK)
  - Auth (EnvAuth, FirefoxProfileAuth)
  - API Client (all read-only endpoints)
  - Zod Schemas (runtime validation)
  - Artifact Client (wiggle filesystem)
  - Message Tree Utilities
        |
claude.ai Web API (undocumented, cookie auth)
```

## Technology Stack (Corrected from Spike)

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js v25.6.0 | Passes Cloudflare TLS fingerprinting (Bun blocked) |
| Package manager | pnpm 10.x | Fast, workspace support, disk-efficient |
| Monorepo | pnpm workspaces | Lightweight, no Turborepo needed for 3 packages |
| Language | TypeScript (strict mode, ESM) | As specified in PRD |
| Validation | Zod 3.x | Runtime schema validation for undocumented API |
| Testing | Vitest | Fast, ESM-native, TypeScript-first |
| HTTP | Node.js native fetch | No TLS impersonation needed with Node.js v25 |
| SQLite | better-sqlite3 | Firefox cookie reading (replaces bun:sqlite) |
| MCP SDK | @modelcontextprotocol/sdk | Official SDK, stdio transport |
| Build | tsup | ESM bundler for publishable packages |

## Package Structure

```
claudesync/
  packages/
    core/                          @claudesync/core
      src/
        auth/
          types.ts                 AuthProvider interface
          env.ts                   EnvAuth (CLAUDE_AI_COOKIE env var)
          firefox.ts               FirefoxProfileAuth (cookies.sqlite)
          errors.ts                AuthError
          index.ts                 Auth barrel export
        client/
          api-client.ts            ClaudeSyncClient class
          endpoints.ts             URL builders for all endpoints
          errors.ts                ClaudeSyncError, RateLimitError
          index.ts                 Client barrel export
        schemas/
          organization.ts          Organization Zod schema
          conversation.ts          Conversation/Message schemas
          project.ts               Project/Doc schemas
          search.ts                Search response schema
          artifact.ts              Artifact/Wiggle schemas
          index.ts                 Schema barrel export
        tree/
          message-tree.ts          Build tree from parent_message_uuid
          index.ts                 Tree utilities barrel
        index.ts                   Package barrel export
      __tests__/
        fixtures/                  Recorded API response fixtures
          organization.json
          conversation-summary.json
          conversation-detail.json
          project.json
          project-docs.json
          search-response.json
          artifact-list.json
        schemas.test.ts
        auth-env.test.ts
        auth-firefox.test.ts
        api-client.test.ts
        endpoints.test.ts
        message-tree.test.ts
      package.json
      tsconfig.json
      vitest.config.ts

    mcp-server/                    @claudesync/mcp-server
      src/
        server.ts                  MCP server setup + tool registration
        tools.ts                   Tool handler implementations
        index.ts                   Entry point (stdio transport)
      __tests__/
        server.test.ts             Tool registration + wiring tests
      package.json
      tsconfig.json
      vitest.config.ts

    cli/                           @claudesync/cli (STUB)
      package.json

  package.json                     Workspace root
  pnpm-workspace.yaml             Workspace config
  tsconfig.base.json               Shared TS config
  .nvmrc                           Node.js version pin
  .npmrc                           pnpm config
```

## API Client Design

### Endpoints Covered (Read-Only, v1 scope)

| Category | Endpoints | Count |
|----------|-----------|-------|
| Organizations | list orgs | 1 |
| Conversations | list, get detail, search | 3 |
| Projects | list, get detail, get docs, get files, get conversations | 5 |
| Artifacts | list files (wiggle), download file (wiggle) | 2 |
| **Total** | | **11** |

### Client Interface

```typescript
class ClaudeSyncClient {
  constructor(auth: AuthProvider)

  // Organizations
  listOrganizations(): Promise<Organization[]>

  // Conversations
  listConversations(orgId: string): Promise<ConversationSummary[]>
  getConversation(orgId: string, chatId: string): Promise<Conversation>
  searchConversations(orgId: string, query: string, limit?: number): Promise<SearchResult>

  // Projects
  listProjects(orgId: string): Promise<Project[]>
  getProject(orgId: string, projectId: string): Promise<Project>
  getProjectDocs(orgId: string, projectId: string): Promise<ProjectDoc[]>
  getProjectFiles(orgId: string, projectId: string): Promise<ProjectFile[]>
  getProjectConversations(orgId: string, projectId: string): Promise<ConversationSummary[]>

  // Artifacts (Wiggle)
  listArtifacts(orgId: string, conversationId: string): Promise<ArtifactListResponse>
  downloadArtifact(orgId: string, conversationId: string, path: string): Promise<string>
}
```

### Request Flow

```
Client method call
  -> auth.getHeaders() (cached cookie + UA)
  -> fetch(buildUrl(endpoint), { headers })
  -> Response status check (429 -> RateLimitError, !ok -> ClaudeSyncError)
  -> JSON parse
  -> Zod schema validation (.passthrough() to preserve unknown fields)
  -> Return typed result
```

### Search Response Handling

The search endpoint returns double-JSON-encoded data. The client handles this:
```typescript
const text = await response.text();
const parsed = JSON.parse(JSON.parse(text));
return SearchResponseSchema.parse(parsed);
```

## MCP Server Design

### Tools (7 total)

| Tool | Description | Parameters |
|------|-------------|------------|
| list_organizations | List claude.ai organizations | none |
| list_conversations | List conversations | orgId? |
| get_conversation | Get full conversation with messages | conversationId, orgId? |
| search_conversations | Full-text search across conversations | query, limit?, orgId? |
| list_projects | List projects in an organization | orgId? |
| list_artifacts | List artifact files for a conversation | conversationId, orgId? |
| download_artifact | Download artifact file content | conversationId, path, orgId? |

### Auth Resolution (startup)

1. Check CLAUDE_AI_COOKIE env var -> EnvAuth
2. Fall back to Firefox profile -> FirefoxProfileAuth
3. If neither works -> throw AuthError with instructions

## Data Model Strategy

- Zod schemas with `.passthrough()` for all API responses (preserves unknown fields)
- TypeScript types inferred from Zod schemas via `z.infer<>`
- Schemas model only the fields we actively use, not the full API response
- Tests use fixture data captured from real API responses

## Testing Strategy

- **Unit tests**: Zod schema validation, endpoint URL builders, message tree utilities
- **Integration tests**: API client with mocked fetch (fixture data)
- **Smoke tests**: Full stack wiring (auth -> client -> MCP server)
- **No live API tests in CI** -- fixture data only
- Test runner: Vitest with TypeScript support

---

*Architecture confirmed from PRD v0.3.0, monorepo design doc, and spike results (2026-03-14)*
