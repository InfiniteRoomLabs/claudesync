# ClaudeSync Sprint Task Backlog

**Date:** 2026-03-14
**Sprint Goal:** Deliver @infinite-room-labs/claudesync-core SDK + @infinite-room-labs/claudesync-mcp-server

---

## Task 1: Monorepo Scaffold + Tooling

**Package:** root
**Depends on:** nothing
**Deliverables:**
- `package.json` (workspace root)
- `pnpm-workspace.yaml`
- `tsconfig.base.json` (shared TypeScript config)
- `.nvmrc` (pin Node.js v25.6.0)
- `.npmrc` (pnpm config: strict-peer-dependencies, etc.)
- `packages/core/package.json`
- `packages/core/tsconfig.json`
- `packages/core/vitest.config.ts`
- `packages/mcp-server/package.json`
- `packages/mcp-server/tsconfig.json`
- `packages/mcp-server/vitest.config.ts`
- `packages/cli/package.json` (stub)
- Run `pnpm install` successfully

**Acceptance criteria:**
- `pnpm install` completes with zero errors
- `pnpm -r exec echo "OK"` prints OK for each workspace package
- TypeScript compiles without errors: `pnpm -r exec tsc --noEmit`
- `.nvmrc` contains `v25.6.0`
- All packages use `"type": "module"` for ESM

---

## Task 2: Zod Schemas + TypeScript Types

**Package:** @infinite-room-labs/claudesync-core
**Depends on:** Task 1
**Deliverables:**
- `packages/core/src/schemas/organization.ts` -- OrganizationSchema
- `packages/core/src/schemas/conversation.ts` -- ConversationSummarySchema, ConversationSettingsSchema, ChatMessageSchema, ConversationSchema
- `packages/core/src/schemas/project.ts` -- ProjectSchema, ProjectDocSchema, ProjectFileSchema
- `packages/core/src/schemas/search.ts` -- SearchChunkSchema, SearchResponseSchema
- `packages/core/src/schemas/artifact.ts` -- ArtifactFileMetadataSchema, ArtifactListResponseSchema
- `packages/core/src/schemas/index.ts` -- barrel export
- `packages/core/__tests__/fixtures/` -- JSON fixture files from spike data
- `packages/core/__tests__/schemas.test.ts`

**Acceptance criteria:**
- All schemas validate against fixture data from the spike results
- Schemas use `.passthrough()` to preserve unknown fields
- Types are inferred from schemas via `z.infer<>`
- ConversationSummary includes: uuid, name, summary, model (nullable), created_at, updated_at, settings, is_starred, is_temporary, project_uuid (nullable), current_leaf_message_uuid, project (optional)
- ChatMessage includes: uuid, text, sender (enum: human/assistant), index, created_at, updated_at, truncated, parent_message_uuid, attachments, files_v2, sync_sources
- Organization includes: uuid, name, settings (passthrough), capabilities, rate_limit_tier, billing_type, active_flags, created_at, updated_at
- Project includes: uuid, name, description, is_private, creator, permissions, docs_count, files_count, created_at, updated_at
- SearchChunk includes: doc_uuid, start, end, name, text, extras (with conversation_uuid, conversation_title, doc_type)
- ArtifactListResponse includes: success, files (string[]), files_metadata (with path, size, content_type, created_at, custom_metadata)
- All tests pass: `cd packages/core && pnpm test`

---

## Task 3: Auth Module -- AuthProvider Interface + EnvAuth

**Package:** @infinite-room-labs/claudesync-core
**Depends on:** Task 1
**Deliverables:**
- `packages/core/src/auth/types.ts` -- AuthProvider interface
- `packages/core/src/auth/env.ts` -- EnvAuth class
- `packages/core/src/auth/errors.ts` -- AuthError class
- `packages/core/src/auth/constants.ts` -- DEFAULT_USER_AGENT (full Chrome UA string)
- `packages/core/src/auth/index.ts` -- barrel export
- `packages/core/__tests__/auth-env.test.ts`

**Acceptance criteria:**
- AuthProvider interface has: getHeaders() -> Promise<Record<string, string>>, getOrganizationId() -> Promise<string>
- EnvAuth reads CLAUDE_AI_COOKIE from environment (required)
- EnvAuth reads CLAUDE_AI_USER_AGENT from environment (optional, defaults to realistic Chrome UA)
- EnvAuth throws AuthError if CLAUDE_AI_COOKIE is not set
- getHeaders() returns Cookie, User-Agent, Accept headers
- getOrganizationId() calls /api/organizations and caches the first org UUID
- DEFAULT_USER_AGENT is a full, realistic Chrome UA string (not Firefox, not minimal) per spike findings
- All tests pass

---

## Task 4: Auth Module -- FirefoxProfileAuth

**Package:** @infinite-room-labs/claudesync-core
**Depends on:** Task 3
**Deliverables:**
- `packages/core/src/auth/firefox.ts` -- FirefoxProfileAuth class + findFirefoxProfiles()
- `packages/core/__tests__/auth-firefox.test.ts`

**Acceptance criteria:**
- findFirefoxProfiles() parses ~/.mozilla/firefox/profiles.ini
- findFirefoxProfiles() returns array of {name, path, isDefault}
- FirefoxProfileAuth reads cookies from cookies.sqlite (read-only, using better-sqlite3)
- FirefoxProfileAuth queries: SELECT name, value FROM moz_cookies WHERE host LIKE '%claude.ai%'
- FirefoxProfileAuth throws AuthError if no claude.ai cookies found
- User-Agent derived from compatibility.ini Firefox version, with Chrome UA fallback
- Tests skip gracefully if Firefox is not installed (conditional skip)
- All tests pass

---

## Task 5: API Client -- Endpoints + ClaudeSyncClient

**Package:** @infinite-room-labs/claudesync-core
**Depends on:** Tasks 2, 3
**Deliverables:**
- `packages/core/src/client/endpoints.ts` -- URL builders for all 11 endpoints
- `packages/core/src/client/api-client.ts` -- ClaudeSyncClient class
- `packages/core/src/client/errors.ts` -- ClaudeSyncError, RateLimitError
- `packages/core/src/client/index.ts` -- barrel export
- `packages/core/__tests__/endpoints.test.ts`
- `packages/core/__tests__/api-client.test.ts`

**Acceptance criteria:**
- ENDPOINTS object covers all 11 read-only endpoints from the architecture plan
- buildUrl() creates correct full URLs for every endpoint
- ClaudeSyncClient constructor accepts an AuthProvider
- All 11 client methods exist and delegate to the correct endpoints
- Private request() method: calls auth.getHeaders(), calls fetch, checks status (429 -> RateLimitError, !ok -> ClaudeSyncError), parses JSON, validates through Zod schema
- searchConversations() handles double-JSON-encoded response (JSON.parse twice)
- RateLimitError includes resetsAt timestamp and sleepSeconds getter
- Tests use mocked fetch with fixture data (no real API calls)
- All tests pass

---

## Task 6: Message Tree Utilities

**Package:** @infinite-room-labs/claudesync-core
**Depends on:** Task 2
**Deliverables:**
- `packages/core/src/tree/message-tree.ts` -- buildMessageTree(), getLinearBranch(), findLeafMessages()
- `packages/core/src/tree/index.ts` -- barrel export
- `packages/core/__tests__/message-tree.test.ts`

**Acceptance criteria:**
- buildMessageTree() takes ChatMessage[] and returns a tree structure using parent_message_uuid
- getLinearBranch() takes the tree + a leaf message UUID and returns the ordered message array from root to leaf
- findLeafMessages() returns all leaf nodes (messages with no children)
- Handles the root message case (parent_message_uuid points to a non-existent UUID or is a sentinel value)
- Works correctly with branching conversations (multiple children per message)
- current_leaf_message_uuid can be used to extract the "main" branch
- Tests cover: linear conversation (no branches), branching conversation (2+ branches), single-message conversation
- All tests pass

---

## Task 7: Core Package Public API (index.ts)

**Package:** @infinite-room-labs/claudesync-core
**Depends on:** Tasks 2, 3, 4, 5, 6
**Deliverables:**
- `packages/core/src/index.ts` -- barrel export of all public API

**Acceptance criteria:**
- Exports all auth: AuthProvider (type), EnvAuth, FirefoxProfileAuth, findFirefoxProfiles, FirefoxProfile (type), AuthError
- Exports all client: ClaudeSyncClient, ClaudeSyncError, RateLimitError
- Exports all schemas (named exports)
- Exports all types (type exports)
- Exports tree utilities: buildMessageTree, getLinearBranch, findLeafMessages
- Importing from "@infinite-room-labs/claudesync-core" resolves all exports correctly
- No circular dependencies

---

## Task 8: MCP Server -- Tool Registration + stdio Transport

**Package:** @infinite-room-labs/claudesync-mcp-server
**Depends on:** Task 7
**Deliverables:**
- `packages/mcp-server/src/server.ts` -- createServer() function with 7 tool registrations
- `packages/mcp-server/src/index.ts` -- entry point with stdio transport
- `packages/mcp-server/__tests__/server.test.ts`

**Acceptance criteria:**
- 7 tools registered: list_organizations, list_conversations, get_conversation, search_conversations, list_projects, list_artifacts, download_artifact
- Each tool has: name, description, Zod parameter schema, handler function
- list_conversations, get_conversation, search_conversations, list_projects, list_artifacts, download_artifact all accept optional orgId (auto-resolves via auth.getOrganizationId())
- Auth resolution at startup: env vars first, Firefox profile fallback
- Entry point creates server and connects stdio transport
- Error handling: tool handlers catch ClaudeSyncError and return error content blocks
- Tests verify tool registration and wiring (mock auth, mock fetch)
- All tests pass

---

## Task 9: End-to-End Smoke Test

**Package:** @infinite-room-labs/claudesync-mcp-server
**Depends on:** Task 8
**Deliverables:**
- `packages/mcp-server/__tests__/smoke.test.ts`

**Acceptance criteria:**
- Core package exports resolve correctly from mcp-server
- ClaudeSyncClient constructs with mock auth
- McpServer constructs with correct name and version
- All 7 tools are registered (verify tool names via server internals)
- Full chain test: mock auth -> client -> tool handler -> MCP response format
- All tests pass

---

## Task 10: Project Finalization

**Package:** root
**Depends on:** Tasks 7, 8, 9
**Deliverables:**
- Updated `.gitignore` (node_modules, dist, .env, pnpm-lock.yaml policy)
- Updated `CLAUDE.md` (corrected tech stack: Node.js not Bun, pnpm not bun, Vitest not bun:test)

**Acceptance criteria:**
- `pnpm -r test` runs all tests across all packages, all pass
- `pnpm -r exec tsc --noEmit` compiles without errors
- .gitignore covers: node_modules/, dist/, .env, .env.*
- CLAUDE.md reflects accurate tech stack and development commands
- No secrets, credentials, or .env files in the repository

---

## Task Dependency Graph

```
Task 1 (scaffold)
  |
  +---> Task 2 (schemas) ---+
  |                          |
  +---> Task 3 (env auth) --+--> Task 5 (client) --+
          |                  |                       |
          +--> Task 4 (ff)   +--> Task 6 (tree) ----+--> Task 7 (barrel) --> Task 8 (MCP) --> Task 9 (smoke) --> Task 10 (finalize)
```

**Critical path:** 1 -> 2 -> 5 -> 7 -> 8 -> 9 -> 10
**Parallel work possible:** Tasks 2, 3, 4 can run in parallel after Task 1. Task 6 can run in parallel with Task 5.

---

## Summary Table

| Task | What | Package | Depends On |
|------|------|---------|------------|
| 1 | Monorepo scaffold + pnpm workspaces + Vitest | root | - |
| 2 | Zod schemas + TypeScript types for all API models | core | 1 |
| 3 | AuthProvider interface + EnvAuth | core | 1 |
| 4 | FirefoxProfileAuth (cookies.sqlite via better-sqlite3) | core | 3 |
| 5 | API client (11 endpoints + ClaudeSyncClient) | core | 2, 3 |
| 6 | Message tree utilities (build tree, extract branches) | core | 2 |
| 7 | Core barrel export (index.ts) | core | 2, 3, 4, 5, 6 |
| 8 | MCP server (7 tools + stdio transport) | mcp-server | 7 |
| 9 | End-to-end smoke test | mcp-server | 8 |
| 10 | .gitignore + CLAUDE.md updates | root | 7, 8, 9 |
