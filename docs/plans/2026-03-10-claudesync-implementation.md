# ClaudeSync Monorepo Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scaffold a pnpm workspace monorepo with a working read-only MCP server that wraps the claude.ai web API, backed by a shared core SDK.

**Architecture:** `@infinite-room-labs/claudesync-core` provides auth (env vars only in Phase 1), an HTTP client (fetch-based) with configurable rate limiting, and Zod-validated data models. `@infinite-room-labs/claudesync-mcp-server` is a thin shell that registers MCP tools (list_organizations, list_conversations, get_conversation) over stdio transport only. CLI and extension packages are stubs.

**Tech Stack:** Node.js v24 LTS, pnpm, TypeScript (strict, `NodeNext` module resolution), Zod, Vitest, @modelcontextprotocol/sdk, better-sqlite3 (deferred to Phase 3 for Firefox cookie reading)

**Updated:** 2026-03-14 -- Incorporates design review findings, security review, and phase reorder (MCP server first).

---

## Phase Overview

| Phase | Scope | Auth | Key Deliverable |
|-------|-------|------|-----------------|
| 1 | Core SDK + MCP Server | EnvAuth only | Working MCP server with 3 tools |
| 2 | ArtifactClient + Git Export Design | EnvAuth | Wiggle filesystem client, versioning spike |
| 3 | CLI + Firefox Profile Auth | EnvAuth + FirefoxProfileAuth | `claudesync export`, `claudesync ls`, `claudesync replay` |
| 4 | Extension | ExtensionAuth | Firefox extension (only if artifact versioning is solved) |

---

## Task 1: Monorepo Scaffold + Workspace Configuration

**Files:**
- Create: `package.json` (workspace root)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`
- Create: `packages/cli/package.json`
- Create: `packages/extension/package.json`
- Create: `.npmrc`
- Create: `.nvmrc`

**Step 1: Create root package.json**

```json
{
  "name": "claudesync",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "typecheck": "pnpm -r run typecheck",
    "lint": "pnpm -r run lint"
  }
}
```

**Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

**Step 3: Create .nvmrc**

```
24
```

**Step 4: Create .npmrc**

```
auto-install-peers=true
```

**Step 5: Create tsconfig.base.json**

Uses `NodeNext` module resolution (not `bundler`) so plain `tsc` works without a bundler. Requires `.js` extensions on all relative imports.

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "isolatedModules": true
  }
}
```

**Step 6: Create packages/core/package.json**

```json
{
  "name": "@infinite-room-labs/claudesync-core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.24"
  },
  "devDependencies": {
    "vitest": "^3.1",
    "typescript": "^5.8"
  }
}
```

**Step 7: Create packages/core/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"]
}
```

**Step 8: Create packages/mcp-server/package.json**

Note: `bin` points at compiled JS in `dist/`, not TypeScript source.

```json
{
  "name": "@infinite-room-labs/claudesync-mcp-server",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "bin": {
    "claudesync-mcp": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@infinite-room-labs/claudesync-core": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.12",
    "zod": "^3.24"
  },
  "devDependencies": {
    "vitest": "^3.1",
    "typescript": "^5.8"
  }
}
```

**Step 9: Create packages/mcp-server/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"]
}
```

**Step 10: Create stub packages**

`packages/cli/package.json`:
```json
{
  "name": "@infinite-room-labs/claudesync-cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@infinite-room-labs/claudesync-core": "workspace:*"
  }
}
```

`packages/extension/package.json`:
```json
{
  "name": "@infinite-room-labs/claudesync-firefox-extension",
  "version": "0.1.0",
  "private": true,
  "type": "module"
}
```

**Step 11: Install dependencies**

Run: `pnpm install`
Expected: `pnpm-lock.yaml` created, `node_modules` populated, zero errors.

**Step 12: Commit**

```bash
git add package.json pnpm-workspace.yaml .nvmrc .npmrc tsconfig.base.json packages/*/package.json packages/*/tsconfig.json pnpm-lock.yaml
git commit -m "scaffold: pnpm workspace monorepo with four packages"
```

---

## Task 2: Data Models (Zod Schemas + TypeScript Types)

**Files:**
- Create: `packages/core/src/models/schemas.ts`
- Create: `packages/core/src/models/types.ts`
- Test: `packages/core/src/models/__tests__/schemas.test.ts`

**Context:** Schemas are derived from live API responses captured during the 2026-03-14 spike. Every schema uses `.passthrough()` for forward compatibility -- unknown fields from the undocumented API are preserved, not stripped. `ConversationSettings` uses `.passthrough()` on the entire object because field names are unstable codenames (`bananagrams`, `sourdough`, `foccacia`) that Anthropic changes without notice. Only stable fields (`enabled_web_search`, `enabled_mcp_tools`) are typed explicitly.

**Step 1: Write the failing test**

Create `packages/core/src/models/__tests__/schemas.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  OrganizationSchema,
  ConversationSummarySchema,
  ConversationSettingsSchema,
  ChatMessageSchema,
  ConversationSchema,
  SearchResponseSchema,
  ArtifactFileMetadataSchema,
  ArtifactListResponseSchema,
} from "../schemas.js";

describe("OrganizationSchema", () => {
  it("parses a valid organization", () => {
    const data = {
      uuid: "abc-123",
      name: "My Org",
      capabilities: ["chat"],
      active_flags: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const result = OrganizationSchema.parse(data);
    expect(result.uuid).toBe("abc-123");
    expect(result.name).toBe("My Org");
  });

  it("preserves unknown fields via passthrough", () => {
    const data = {
      uuid: "abc-123",
      name: "My Org",
      capabilities: ["chat"],
      active_flags: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      rate_limit_tier: "default_claude_max_20x",
      billing_type: "stripe_subscription",
    };
    const result = OrganizationSchema.parse(data);
    expect((result as Record<string, unknown>).rate_limit_tier).toBe(
      "default_claude_max_20x"
    );
  });

  it("rejects missing uuid", () => {
    expect(() =>
      OrganizationSchema.parse({ name: "My Org" })
    ).toThrow();
  });
});

describe("ConversationSettingsSchema", () => {
  it("preserves unknown codename fields via passthrough", () => {
    const data = {
      enabled_web_search: true,
      enabled_bananagrams: true,
      enabled_sourdough: false,
      enabled_foccacia: true,
      enabled_compass: null,
      some_future_codename: "unknown_value",
    };
    const result = ConversationSettingsSchema.parse(data);
    expect(result.enabled_web_search).toBe(true);
    expect(
      (result as Record<string, unknown>).some_future_codename
    ).toBe("unknown_value");
  });
});

describe("ChatMessageSchema", () => {
  it("parses a valid message with parent_message_uuid", () => {
    const data = {
      uuid: "msg-1",
      text: "Hello",
      sender: "human",
      index: 0,
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      parent_message_uuid: "root",
      attachments: [],
      files_v2: [],
      sync_sources: [],
    };
    const result = ChatMessageSchema.parse(data);
    expect(result.sender).toBe("human");
    expect(result.parent_message_uuid).toBe("root");
  });

  it("accepts assistant sender with stop_reason", () => {
    const data = {
      uuid: "msg-2",
      text: "Hi there",
      sender: "assistant",
      index: 1,
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      parent_message_uuid: "msg-1",
      stop_reason: "end_turn",
      attachments: [],
      files_v2: [],
      sync_sources: [],
    };
    const result = ChatMessageSchema.parse(data);
    expect(result.sender).toBe("assistant");
    expect(result.stop_reason).toBe("end_turn");
  });

  it("rejects invalid sender", () => {
    const data = {
      uuid: "msg-3",
      text: "Bad",
      sender: "system",
      index: 0,
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      parent_message_uuid: "root",
      attachments: [],
      files_v2: [],
      sync_sources: [],
    };
    expect(() => ChatMessageSchema.parse(data)).toThrow();
  });
});

describe("ConversationSummarySchema", () => {
  it("parses with null model and current_leaf_message_uuid", () => {
    const data = {
      uuid: "conv-1",
      name: "Test Chat",
      model: null,
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      current_leaf_message_uuid: "leaf-1",
    };
    const result = ConversationSummarySchema.parse(data);
    expect(result.model).toBeNull();
    expect(result.current_leaf_message_uuid).toBe("leaf-1");
  });
});

describe("ConversationSchema", () => {
  it("parses a full conversation with messages", () => {
    const data = {
      uuid: "conv-1",
      name: "Test Chat",
      model: "claude-opus-4-6",
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      current_leaf_message_uuid: "msg-1",
      chat_messages: [
        {
          uuid: "msg-1",
          text: "Hello",
          sender: "human",
          index: 0,
          created_at: "2026-03-10T00:00:00Z",
          updated_at: "2026-03-10T00:00:00Z",
          parent_message_uuid: "root",
          attachments: [],
          files_v2: [],
          sync_sources: [],
        },
      ],
    };
    const result = ConversationSchema.parse(data);
    expect(result.chat_messages).toHaveLength(1);
  });
});

describe("SearchResponseSchema", () => {
  it("parses search results with extras", () => {
    const data = {
      chunks: [
        {
          doc_uuid: "doc-1",
          start: 0,
          end: 50,
          name: "Test Conv",
          text: "matching text",
          extras: {
            conversation_uuid: "conv-1",
            conversation_title: "Test Conv",
            doc_type: "conversation",
          },
        },
      ],
    };
    const result = SearchResponseSchema.parse(data);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].extras.conversation_uuid).toBe("conv-1");
  });
});

describe("ArtifactListResponseSchema", () => {
  it("parses wiggle list-files response", () => {
    const data = {
      success: true,
      files: ["/mnt/user-data/outputs/architecture.md"],
      files_metadata: [
        {
          path: "/mnt/user-data/outputs/architecture.md",
          size: 29446,
          content_type: "text/plain",
          created_at: "2026-03-12T23:08:39.328229Z",
          custom_metadata: { filename: "architecture.md" },
        },
      ],
    };
    const result = ArtifactListResponseSchema.parse(data);
    expect(result.success).toBe(true);
    expect(result.files_metadata).toHaveLength(1);
    expect(result.files_metadata[0].custom_metadata.filename).toBe(
      "architecture.md"
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/models/__tests__/schemas.test.ts`
Expected: FAIL -- cannot resolve `../schemas.js`

**Step 3: Write the schemas**

Create `packages/core/src/models/schemas.ts`:

```typescript
import { z } from "zod";

export const OrganizationSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    capabilities: z.array(z.string()).default([]),
    active_flags: z.array(z.string()).default([]),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

// ConversationSettings uses .passthrough() because field names are
// unstable codenames (bananagrams, sourdough, foccacia) that Anthropic
// changes without notice. Only stable fields are typed explicitly.
export const ConversationSettingsSchema = z
  .object({
    enabled_web_search: z.boolean().optional(),
    enabled_mcp_tools: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough();

export const AttachmentSchema = z
  .object({
    file_name: z.string(),
    file_size: z.string(),
    file_type: z.string(),
  })
  .passthrough();

export const ChatMessageSchema = z
  .object({
    uuid: z.string(),
    text: z.string(),
    sender: z.enum(["human", "assistant"]),
    index: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
    parent_message_uuid: z.string(),
    attachments: z.array(AttachmentSchema).default([]),
    files_v2: z.array(z.unknown()).default([]),
    sync_sources: z.array(z.unknown()).default([]),
    truncated: z.boolean().optional(),
    stop_reason: z.string().optional(),
    input_mode: z.string().optional(),
  })
  .passthrough();

export const ConversationSummarySchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    model: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    current_leaf_message_uuid: z.string(),
    settings: ConversationSettingsSchema.optional(),
    is_starred: z.boolean().optional(),
    is_temporary: z.boolean().optional(),
    project_uuid: z.string().nullable().optional(),
    summary: z.string().optional(),
  })
  .passthrough();

export const ConversationSchema = ConversationSummarySchema.extend({
  chat_messages: z.array(ChatMessageSchema),
}).passthrough();

export const SearchChunkSchema = z
  .object({
    doc_uuid: z.string(),
    start: z.number(),
    end: z.number(),
    name: z.string(),
    text: z.string(),
    extras: z
      .object({
        conversation_uuid: z.string(),
        conversation_title: z.string().optional(),
        doc_type: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const SearchResponseSchema = z.object({
  chunks: z.array(SearchChunkSchema),
});

export const ArtifactFileMetadataSchema = z
  .object({
    path: z.string(),
    size: z.number(),
    content_type: z.string(),
    created_at: z.string(),
    custom_metadata: z
      .object({
        filename: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export const ArtifactListResponseSchema = z.object({
  success: z.boolean(),
  files: z.array(z.string()),
  files_metadata: z.array(ArtifactFileMetadataSchema),
});

export const ProjectSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    description: z.string().optional(),
    is_private: z.boolean().optional(),
    docs_count: z.number().optional(),
    files_count: z.number().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const ProjectDocSchema = z
  .object({
    uuid: z.string(),
    file_name: z.string(),
    content: z.string(),
  })
  .passthrough();
```

**Step 4: Write the inferred TypeScript types**

Create `packages/core/src/models/types.ts`:

```typescript
import type { z } from "zod";
import type {
  OrganizationSchema,
  ConversationSettingsSchema,
  AttachmentSchema,
  ChatMessageSchema,
  ConversationSummarySchema,
  ConversationSchema,
  SearchChunkSchema,
  SearchResponseSchema,
  ArtifactFileMetadataSchema,
  ArtifactListResponseSchema,
  ProjectSchema,
  ProjectDocSchema,
} from "./schemas.js";

export type Organization = z.infer<typeof OrganizationSchema>;
export type ConversationSettings = z.infer<typeof ConversationSettingsSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type SearchChunk = z.infer<typeof SearchChunkSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type ArtifactFileMetadata = z.infer<typeof ArtifactFileMetadataSchema>;
export type ArtifactListResponse = z.infer<typeof ArtifactListResponseSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectDoc = z.infer<typeof ProjectDocSchema>;
```

**Step 5: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/models/__tests__/schemas.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add packages/core/src/models/
git commit -m "feat(core): add Zod schemas and TypeScript types for claude.ai API models"
```

---

## Task 3: Auth Module -- AuthProvider Interface + EnvAuth

**Files:**
- Create: `packages/core/src/auth/types.ts`
- Create: `packages/core/src/auth/env.ts`
- Create: `packages/core/src/auth/errors.ts`
- Test: `packages/core/src/auth/__tests__/env.test.ts`

**Context:** The auth module provides a common interface for different authentication strategies. `EnvAuth` is the only strategy in Phase 1 -- it reads `CLAUDE_AI_COOKIE` from the environment. `FirefoxProfileAuth` is deferred to Phase 3.

**Security requirement:** Clear `CLAUDE_AI_COOKIE` from `process.env` after reading to minimize exposure via `/proc/<pid>/environ` and `docker inspect`.

**Step 1: Write the failing test**

Create `packages/core/src/auth/__tests__/env.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EnvAuth } from "../env.js";
import { AuthError } from "../errors.js";

describe("EnvAuth", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws AuthError when CLAUDE_AI_COOKIE is not set", () => {
    delete process.env.CLAUDE_AI_COOKIE;
    expect(() => new EnvAuth()).toThrow(AuthError);
  });

  it("returns headers with cookie and default user-agent", async () => {
    process.env.CLAUDE_AI_COOKIE = "sessionKey=abc123";
    const auth = new EnvAuth();
    const headers = await auth.getHeaders();
    expect(headers["Cookie"]).toBe("sessionKey=abc123");
    expect(headers["User-Agent"]).toBeDefined();
    expect(headers["User-Agent"].length).toBeGreaterThan(0);
  });

  it("uses custom user-agent from env when set", async () => {
    process.env.CLAUDE_AI_COOKIE = "sessionKey=abc123";
    process.env.CLAUDE_AI_USER_AGENT =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0";
    const auth = new EnvAuth();
    const headers = await auth.getHeaders();
    expect(headers["User-Agent"]).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0"
    );
  });

  it("clears CLAUDE_AI_COOKIE from process.env after reading", () => {
    process.env.CLAUDE_AI_COOKIE = "sessionKey=abc123";
    new EnvAuth();
    expect(process.env.CLAUDE_AI_COOKIE).toBeUndefined();
  });

  it("fetches organization ID from API", async () => {
    process.env.CLAUDE_AI_COOKIE = "sessionKey=abc123";
    const auth = new EnvAuth();
    // getOrganizationId makes a real API call -- tested in integration tests
    // Here we just verify the method exists and is async
    expect(auth.getOrganizationId).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/auth/__tests__/env.test.ts`
Expected: FAIL -- cannot resolve `../env.js`

**Step 3: Write the AuthProvider interface**

Create `packages/core/src/auth/types.ts`:

```typescript
export interface AuthProvider {
  /** Build the HTTP headers needed for claude.ai API requests */
  getHeaders(): Promise<Record<string, string>>;

  /**
   * Resolve the organization UUID for this session.
   * Makes an API call to /api/organizations on first call, caches the result.
   */
  getOrganizationId(): Promise<string>;
}
```

**Step 4: Write the auth errors**

Create `packages/core/src/auth/errors.ts`:

```typescript
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
```

**Step 5: Write EnvAuth implementation**

Create `packages/core/src/auth/env.ts`:

```typescript
import type { AuthProvider } from "./types.js";
import { AuthError } from "./errors.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export class EnvAuth implements AuthProvider {
  private readonly cookie: string;
  private readonly userAgent: string;
  private cachedOrgId: string | null = null;

  constructor() {
    const cookie = process.env.CLAUDE_AI_COOKIE;
    if (!cookie) {
      throw new AuthError(
        "CLAUDE_AI_COOKIE environment variable is required. " +
          "Get it from browser DevTools: Application > Cookies > claude.ai > sessionKey"
      );
    }
    this.cookie = cookie;
    this.userAgent = process.env.CLAUDE_AI_USER_AGENT ?? DEFAULT_USER_AGENT;

    // Security: clear the cookie from process.env to minimize exposure
    // via /proc/<pid>/environ and docker inspect
    delete process.env.CLAUDE_AI_COOKIE;
  }

  async getHeaders(): Promise<Record<string, string>> {
    return {
      Cookie: this.cookie,
      "User-Agent": this.userAgent,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  async getOrganizationId(): Promise<string> {
    if (this.cachedOrgId) {
      return this.cachedOrgId;
    }

    const headers = await this.getHeaders();
    const response = await fetch("https://claude.ai/api/organizations", {
      headers,
    });

    if (!response.ok) {
      throw new AuthError(
        `Failed to fetch organizations: ${response.status} ${response.statusText}`
      );
    }

    const orgs = await response.json();
    if (!Array.isArray(orgs) || orgs.length === 0 || !orgs[0].uuid) {
      throw new AuthError("No organizations found for this session");
    }

    this.cachedOrgId = orgs[0].uuid;
    return this.cachedOrgId;
  }
}
```

**Step 6: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run src/auth/__tests__/env.test.ts`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add packages/core/src/auth/
git commit -m "feat(core): add AuthProvider interface and EnvAuth with env-clear security"
```

---

## Task 4: API Client -- Endpoints + ClaudeSyncClient with Rate Limiting

**Files:**
- Create: `packages/core/src/client/endpoints.ts`
- Create: `packages/core/src/client/client.ts`
- Create: `packages/core/src/client/errors.ts`
- Test: `packages/core/src/client/__tests__/endpoints.test.ts`
- Test: `packages/core/src/client/__tests__/client.test.ts`

**Context:** The API client wraps fetch calls to claude.ai. Node.js v24's native `fetch` (undici/OpenSSL) passes Cloudflare's TLS fingerprinting. The client accepts any `AuthProvider` and uses it for every request. Responses are validated through Zod schemas from Task 2.

**Key design decisions from review:**
- `listConversations` returns `AsyncIterable<ConversationSummary>` (not `Promise<T[]>`) to handle large conversation lists gracefully. A convenience `listConversationsAll()` method is also provided.
- Configurable rate limiting delay (300ms default) built into the client between requests.
- Search response uses defensive double-parse handling: `typeof firstPass === 'string' ? JSON.parse(firstPass) : firstPass`.
- `downloadArtifact` returns `string | Uint8Array` to handle binary content (images).
- Artifact paths validated against expected `/mnt/user-data/outputs/*` pattern for path traversal protection.

**Step 1: Write endpoint tests**

Create `packages/core/src/client/__tests__/endpoints.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildUrl, ENDPOINTS } from "../endpoints.js";

describe("buildUrl", () => {
  it("builds organizations URL", () => {
    expect(buildUrl(ENDPOINTS.organizations)).toBe(
      "https://claude.ai/api/organizations"
    );
  });

  it("builds conversations list URL", () => {
    expect(buildUrl(ENDPOINTS.conversations("org-123"))).toBe(
      "https://claude.ai/api/organizations/org-123/chat_conversations"
    );
  });

  it("builds single conversation URL", () => {
    expect(buildUrl(ENDPOINTS.conversation("org-123", "chat-456"))).toBe(
      "https://claude.ai/api/organizations/org-123/chat_conversations/chat-456"
    );
  });

  it("builds search URL", () => {
    expect(buildUrl(ENDPOINTS.search("org-123", "hello", 10))).toBe(
      "https://claude.ai/api/organizations/org-123/conversation/search?query=hello&n=10"
    );
  });

  it("builds projects URL", () => {
    expect(buildUrl(ENDPOINTS.projects("org-123"))).toBe(
      "https://claude.ai/api/organizations/org-123/projects"
    );
  });

  it("builds wiggle list-files URL", () => {
    expect(
      buildUrl(ENDPOINTS.artifactListFiles("org-123", "conv-456"))
    ).toBe(
      "https://claude.ai/api/organizations/org-123/conversations/conv-456/wiggle/list-files"
    );
  });

  it("builds wiggle download-file URL", () => {
    expect(
      buildUrl(
        ENDPOINTS.artifactDownloadFile(
          "org-123",
          "conv-456",
          "/mnt/user-data/outputs/file.md"
        )
      )
    ).toBe(
      "https://claude.ai/api/organizations/org-123/conversations/conv-456/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Ffile.md"
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/client/__tests__/endpoints.test.ts`
Expected: FAIL -- cannot resolve `../endpoints.js`

**Step 3: Write endpoints module**

Create `packages/core/src/client/endpoints.ts`:

```typescript
const BASE_URL = "https://claude.ai";

export const ENDPOINTS = {
  // Bootstrap & Account
  bootstrap: "/api/bootstrap",
  account: "/api/account",
  organizations: "/api/organizations",

  // Conversations
  conversations: (orgId: string) =>
    `/api/organizations/${orgId}/chat_conversations`,
  conversation: (orgId: string, chatId: string) =>
    `/api/organizations/${orgId}/chat_conversations/${chatId}`,
  search: (orgId: string, query: string, limit: number) =>
    `/api/organizations/${orgId}/conversation/search?query=${encodeURIComponent(query)}&n=${limit}`,

  // Projects
  projects: (orgId: string) =>
    `/api/organizations/${orgId}/projects`,
  project: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/projects/${projectId}`,
  projectDocs: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/projects/${projectId}/docs`,
  projectFiles: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/projects/${projectId}/files`,
  projectConversations: (orgId: string, projectId: string) =>
    `/api/organizations/${orgId}/projects/${projectId}/conversations`,

  // Artifacts (wiggle filesystem)
  artifactListFiles: (orgId: string, conversationId: string) =>
    `/api/organizations/${orgId}/conversations/${conversationId}/wiggle/list-files`,
  artifactDownloadFile: (
    orgId: string,
    conversationId: string,
    path: string
  ) =>
    `/api/organizations/${orgId}/conversations/${conversationId}/wiggle/download-file?path=${encodeURIComponent(path)}`,
  artifactStorageInfo: (orgId: string, artifactId: string) =>
    `/api/organizations/${orgId}/artifacts/wiggle_artifact/${artifactId}/manage/storage/info`,
} as const;

export function buildUrl(path: string): string {
  return `${BASE_URL}${path}`;
}
```

**Step 4: Run endpoint tests**

Run: `cd packages/core && npx vitest run src/client/__tests__/endpoints.test.ts`
Expected: All tests PASS

**Step 5: Write client error types**

Create `packages/core/src/client/errors.ts`:

```typescript
export class ClaudeSyncError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "ClaudeSyncError";
  }
}

export class RateLimitError extends ClaudeSyncError {
  constructor(
    public readonly resetsAt: number,
    message?: string
  ) {
    super(
      message ??
        `Rate limited. Resets at ${new Date(resetsAt * 1000).toISOString()}`,
      429
    );
    this.name = "RateLimitError";
  }

  /** Seconds until rate limit resets */
  get sleepSeconds(): number {
    return Math.max(0, Math.ceil(this.resetsAt - Date.now() / 1000));
  }
}
```

**Step 6: Write client tests**

Create `packages/core/src/client/__tests__/client.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { ClaudeSyncClient } from "../client.js";
import type { AuthProvider } from "../../auth/types.js";

// Mock AuthProvider that returns fixed headers
function createMockAuth(): AuthProvider {
  return {
    getHeaders: async () => ({
      Cookie: "test-cookie",
      "User-Agent": "test-agent",
    }),
    getOrganizationId: async () => "org-123",
  };
}

describe("ClaudeSyncClient", () => {
  it("constructs with an auth provider", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(client).toBeDefined();
  });

  it("constructs with custom rate limit delay", () => {
    const client = new ClaudeSyncClient(createMockAuth(), {
      rateLimitDelayMs: 500,
    });
    expect(client).toBeDefined();
  });

  it("exposes listOrganizations method", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.listOrganizations).toBe("function");
  });

  it("exposes listConversations as async iterable", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.listConversations).toBe("function");
  });

  it("exposes listConversationsAll convenience method", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.listConversationsAll).toBe("function");
  });

  it("exposes getConversation method", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.getConversation).toBe("function");
  });

  it("exposes searchConversations method", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.searchConversations).toBe("function");
  });

  it("exposes artifact methods", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.listArtifacts).toBe("function");
    expect(typeof client.downloadArtifact).toBe("function");
  });
});
```

**Step 7: Write the ClaudeSyncClient**

Create `packages/core/src/client/client.ts`:

```typescript
import type { AuthProvider } from "../auth/types.js";
import { buildUrl, ENDPOINTS } from "./endpoints.js";
import { ClaudeSyncError, RateLimitError } from "./errors.js";
import {
  OrganizationSchema,
  ConversationSummarySchema,
  ConversationSchema,
  SearchResponseSchema,
  ArtifactListResponseSchema,
  ProjectSchema,
  ProjectDocSchema,
} from "../models/schemas.js";
import type {
  Organization,
  ConversationSummary,
  Conversation,
  SearchResponse,
  ArtifactListResponse,
  Project,
  ProjectDoc,
} from "../models/types.js";
import { z } from "zod";
import { basename } from "node:path";

export interface ClientOptions {
  /**
   * Delay in milliseconds between API requests to avoid rate limiting.
   * Default: 300ms.
   */
  rateLimitDelayMs?: number;
}

/** Expected path prefix for wiggle artifact files */
const ARTIFACT_PATH_PREFIX = "/mnt/user-data/";

export class ClaudeSyncClient {
  private readonly rateLimitDelayMs: number;
  private lastRequestTime = 0;

  constructor(
    private readonly auth: AuthProvider,
    options?: ClientOptions
  ) {
    this.rateLimitDelayMs = options?.rateLimitDelayMs ?? 300;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.rateLimitDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.rateLimitDelayMs - elapsed)
      );
    }
    this.lastRequestTime = Date.now();
  }

  private async request(url: string): Promise<unknown> {
    await this.throttle();

    const headers = await this.auth.getHeaders();
    const response = await fetch(url, { headers });

    if (response.status === 429) {
      const body = await response.json().catch(() => null);
      const resetsAt =
        body?.error?.resets_at ??
        Math.floor(Date.now() / 1000) + 60;
      throw new RateLimitError(resetsAt);
    }

    if (!response.ok) {
      throw new ClaudeSyncError(
        `API request failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    return response.json();
  }

  private async requestRaw(url: string): Promise<Response> {
    await this.throttle();

    const headers = await this.auth.getHeaders();
    const response = await fetch(url, { headers });

    if (response.status === 429) {
      const body = await response.json().catch(() => null);
      const resetsAt =
        body?.error?.resets_at ??
        Math.floor(Date.now() / 1000) + 60;
      throw new RateLimitError(resetsAt);
    }

    if (!response.ok) {
      throw new ClaudeSyncError(
        `API request failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    return response;
  }

  // --- Organizations ---

  async listOrganizations(): Promise<Organization[]> {
    const data = await this.request(buildUrl(ENDPOINTS.organizations));
    return z.array(OrganizationSchema).parse(data);
  }

  // --- Conversations ---

  /**
   * List conversations as an async iterable.
   * Currently the API returns all conversations in one response (no pagination),
   * but this interface is forward-compatible with future pagination.
   */
  async *listConversations(
    orgId: string
  ): AsyncIterable<ConversationSummary> {
    const data = await this.request(
      buildUrl(ENDPOINTS.conversations(orgId))
    );
    const conversations = z
      .array(ConversationSummarySchema)
      .parse(data);
    for (const conv of conversations) {
      yield conv;
    }
  }

  /**
   * Convenience method that collects all conversations into an array.
   * Use listConversations() for streaming/lazy processing of large lists.
   */
  async listConversationsAll(
    orgId: string
  ): Promise<ConversationSummary[]> {
    const results: ConversationSummary[] = [];
    for await (const conv of this.listConversations(orgId)) {
      results.push(conv);
    }
    return results;
  }

  async getConversation(
    orgId: string,
    chatId: string
  ): Promise<Conversation> {
    const data = await this.request(
      buildUrl(ENDPOINTS.conversation(orgId, chatId))
    );
    return ConversationSchema.parse(data);
  }

  /**
   * Search conversations. Handles double-JSON-encoded responses defensively:
   * the API sometimes returns a JSON string containing another JSON string.
   */
  async searchConversations(
    orgId: string,
    query: string,
    limit = 20
  ): Promise<SearchResponse> {
    const data = await this.request(
      buildUrl(ENDPOINTS.search(orgId, query, limit))
    );
    // Defensive double-parse: API returns double-JSON-encoded responses
    const parsed =
      typeof data === "string" ? JSON.parse(data) : data;
    return SearchResponseSchema.parse(parsed);
  }

  // --- Projects ---

  async listProjects(orgId: string): Promise<Project[]> {
    const data = await this.request(
      buildUrl(ENDPOINTS.projects(orgId))
    );
    return z.array(ProjectSchema).parse(data);
  }

  async getProjectDocs(
    orgId: string,
    projectId: string
  ): Promise<ProjectDoc[]> {
    const data = await this.request(
      buildUrl(ENDPOINTS.projectDocs(orgId, projectId))
    );
    return z.array(ProjectDocSchema).parse(data);
  }

  // --- Artifacts (wiggle filesystem) ---

  async listArtifacts(
    orgId: string,
    conversationId: string
  ): Promise<ArtifactListResponse> {
    const data = await this.request(
      buildUrl(ENDPOINTS.artifactListFiles(orgId, conversationId))
    );
    return ArtifactListResponseSchema.parse(data);
  }

  /**
   * Download an artifact file from the wiggle filesystem.
   * Returns string for text content, Uint8Array for binary content.
   *
   * Security: validates that the path matches the expected artifact path prefix
   * to prevent path traversal attacks.
   */
  async downloadArtifact(
    orgId: string,
    conversationId: string,
    path: string
  ): Promise<string | Uint8Array> {
    // Security: validate artifact path against expected pattern
    if (!path.startsWith(ARTIFACT_PATH_PREFIX)) {
      throw new ClaudeSyncError(
        `Invalid artifact path: ${path}. Expected path starting with ${ARTIFACT_PATH_PREFIX}`
      );
    }

    const response = await this.requestRaw(
      buildUrl(
        ENDPOINTS.artifactDownloadFile(orgId, conversationId, path)
      )
    );

    const contentType =
      response.headers.get("content-type") ?? "text/plain";
    if (contentType.startsWith("text/")) {
      return response.text();
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Get the safe local filename for an artifact path.
   * Uses path.basename() to prevent path traversal on local writes.
   */
  static safeFilename(artifactPath: string): string {
    return basename(artifactPath);
  }
}
```

**Step 8: Run all client tests**

Run: `cd packages/core && npx vitest run src/client/__tests__/`
Expected: All tests PASS

**Step 9: Commit**

```bash
git add packages/core/src/client/
git commit -m "feat(core): add API client with rate limiting, artifact support, and path validation"
```

---

## Task 5: Core Package Public API (index.ts)

**Files:**
- Create: `packages/core/src/index.ts`

**Step 1: Write the barrel export**

Create `packages/core/src/index.ts`:

```typescript
// Auth
export type { AuthProvider } from "./auth/types.js";
export { EnvAuth } from "./auth/env.js";
export { AuthError } from "./auth/errors.js";

// Client
export { ClaudeSyncClient } from "./client/client.js";
export type { ClientOptions } from "./client/client.js";
export { ClaudeSyncError, RateLimitError } from "./client/errors.js";

// Models -- Schemas
export {
  OrganizationSchema,
  ConversationSettingsSchema,
  AttachmentSchema,
  ChatMessageSchema,
  ConversationSummarySchema,
  ConversationSchema,
  SearchChunkSchema,
  SearchResponseSchema,
  ArtifactFileMetadataSchema,
  ArtifactListResponseSchema,
  ProjectSchema,
  ProjectDocSchema,
} from "./models/schemas.js";

// Models -- Types
export type {
  Organization,
  ConversationSettings,
  Attachment,
  ChatMessage,
  ConversationSummary,
  Conversation,
  SearchChunk,
  SearchResponse,
  ArtifactFileMetadata,
  ArtifactListResponse,
  Project,
  ProjectDoc,
} from "./models/types.js";
```

Note: `FirefoxProfileAuth` is NOT exported in Phase 1. It will be added in Phase 3 when `better-sqlite3` is introduced as a dependency.

**Step 2: Verify the package builds**

Run: `cd packages/core && npx tsc -p tsconfig.json`
Expected: `dist/` directory created with `.js` and `.d.ts` files, zero errors.

**Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): add barrel export for public API (Phase 1 -- EnvAuth only)"
```

---

## Task 6: MCP Server -- Tool Registration + stdio Transport

**Files:**
- Create: `packages/mcp-server/src/server.ts`
- Create: `packages/mcp-server/src/index.ts`

**Context:** The MCP server uses `@modelcontextprotocol/sdk` with stdio transport only. It registers three tools that delegate to `ClaudeSyncClient` from `@infinite-room-labs/claudesync-core`. Auth is `EnvAuth` only in Phase 1.

**Security requirement:** stdio transport ONLY. Network transports (SSE, HTTP) expose the session cookie to any network client and are explicitly unsafe. Document this in the server startup banner.

**Step 1: Write the server module**

Create `packages/mcp-server/src/server.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ClaudeSyncClient,
  EnvAuth,
  AuthError,
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

export function createServer(): McpServer {
  const auth = resolveAuth();
  const client = new ClaudeSyncClient(auth);

  const server = new McpServer({
    name: "claudesync",
    version: "0.1.0",
  });

  server.tool(
    "list_organizations",
    "List claude.ai organizations accessible by this session",
    {},
    async () => {
      const orgs = await client.listOrganizations();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(orgs, null, 2),
          },
        ],
      };
    }
  );

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
    }
  );

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
    }
  );

  return server;
}
```

**Step 2: Write the entry point**

Create `packages/mcp-server/src/index.ts`:

```typescript
#!/usr/bin/env node

/**
 * ClaudeSync MCP Server
 *
 * SECURITY NOTE: This server uses stdio transport ONLY.
 * Network transports (SSE, HTTP) would expose the claude.ai session
 * cookie to any network client and are explicitly unsafe. Do not add
 * network transport support without implementing proper auth isolation.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Step 3: Build and verify the server starts**

Run:
```bash
cd packages/core && npx tsc -p tsconfig.json
cd packages/mcp-server && npx tsc -p tsconfig.json
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | CLAUDE_AI_COOKIE=test node packages/mcp-server/dist/index.js
```

Expected: JSON-RPC response with server capabilities including the three tools.

**Step 4: Commit**

```bash
git add packages/mcp-server/src/
git commit -m "feat(mcp-server): register read-only MCP tools with stdio transport only"
```

---

## Task 7: Cookie Extraction Helper Script

**Files:**
- Create: `scripts/extract-cookie.ts`

**Context:** Helper script users can run to extract their claude.ai cookie from Firefox. Writes to `.env` file by default. Stdout output requires an explicit `--stdout` flag to prevent accidental cookie exposure in shell history.

**Security requirements:**
- Default behavior writes to `.env` file, not stdout
- Stdout output gated behind `--stdout` flag
- Never print the full cookie to stderr

**Step 1: Write the script**

Create `scripts/extract-cookie.ts`:

```typescript
#!/usr/bin/env node

/**
 * Extract claude.ai session cookie from Firefox profile.
 *
 * Usage:
 *   npx tsx scripts/extract-cookie.ts           # Writes to .env file
 *   npx tsx scripts/extract-cookie.ts --stdout   # Prints to stdout (use with caution)
 *
 * Requires: better-sqlite3 (installed as dev dependency)
 * Note: This script is a Phase 3 deliverable. In Phase 1, users
 * extract the cookie manually from browser DevTools.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Phase 3: This script will use better-sqlite3 to read Firefox cookies.
// For now, print instructions for manual extraction.

const useStdout = process.argv.includes("--stdout");

console.error("ClaudeSync Cookie Extractor");
console.error("===========================");
console.error("");
console.error("Phase 1: Manual extraction required.");
console.error("");
console.error("Steps:");
console.error("  1. Open Firefox or Chrome and navigate to claude.ai");
console.error("  2. Open DevTools (F12) > Application > Cookies > claude.ai");
console.error("  3. Find the 'sessionKey' cookie (131 chars, httpOnly)");
console.error("  4. Copy the value");
console.error("  5. Set in your environment:");
console.error("");
console.error("     export CLAUDE_AI_COOKIE='sessionKey=<paste-value-here>'");
console.error("");
console.error("Or create a .env file:");
console.error("");
console.error("     echo 'CLAUDE_AI_COOKIE=sessionKey=<paste-value-here>' > .env");
console.error("");
console.error("Firefox cookie extraction (Phase 3) will be automated via better-sqlite3.");
```

**Step 2: Commit**

```bash
git add scripts/extract-cookie.ts
git commit -m "feat: add cookie extraction helper with manual instructions (Phase 1)"
```

---

## Task 8: Update CLAUDE.md + .gitignore

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.gitignore`

**Context:** Update the project CLAUDE.md for agents and add standard ignores for Node.js/pnpm.

**Step 1: Update CLAUDE.md**

The CLAUDE.md should contain project-specific guidance (this is already checked in, so update it to reflect the new tech stack and conventions):

Key updates:
- Runtime: Node.js v24 LTS (not Bun)
- Package manager: pnpm (not bun install)
- Test runner: Vitest (not bun:test)
- Module resolution: NodeNext (requires `.js` extensions on imports)
- Auth: EnvAuth only in Phase 1
- Security: list the key requirements from the security review

**Step 2: Update .gitignore**

```
# Dependencies
node_modules/

# Build output
dist/

# Environment (CRITICAL: session cookie lives here)
.env
.env.*
.env.local

# pnpm
pnpm-lock.yaml

# TypeScript
*.tsbuildinfo

# Test coverage
coverage/

# OS
.DS_Store
Thumbs.db
```

Note: Whether to commit `pnpm-lock.yaml` is a team decision. Including it as ignored here since this is a library/tool. Remove the `pnpm-lock.yaml` line if you want reproducible installs.

**Step 3: Commit**

```bash
git add CLAUDE.md .gitignore
git commit -m "docs: update CLAUDE.md for Node.js/pnpm/Vitest stack and .gitignore"
```

---

## Task 9: Vitest Configuration

**Files:**
- Create: `packages/core/vitest.config.ts`
- Create: `packages/mcp-server/vitest.config.ts`

**Step 1: Create core vitest config**

Create `packages/core/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    globals: false,
  },
});
```

**Step 2: Create mcp-server vitest config**

Create `packages/mcp-server/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    globals: false,
  },
});
```

**Step 3: Commit**

```bash
git add packages/core/vitest.config.ts packages/mcp-server/vitest.config.ts
git commit -m "chore: add Vitest configuration for core and mcp-server packages"
```

---

## Task 10: End-to-End Smoke Test

**Files:**
- Create: `packages/mcp-server/src/__tests__/smoke.test.ts`

**Context:** Verify the full stack wires together: auth resolves, client constructs, MCP server creates and registers tools. This does NOT make real API calls -- it tests the wiring with a mock auth provider. All test fixtures use synthetic data only (no real PII).

**Step 1: Write the smoke test**

Create `packages/mcp-server/src/__tests__/smoke.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClaudeSyncClient, type AuthProvider } from "@infinite-room-labs/claudesync-core";

// Synthetic test data only -- no real PII
function createMockAuth(): AuthProvider {
  return {
    getHeaders: async () => ({
      Cookie: "sessionKey=synthetic-test-value-not-a-real-cookie",
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0",
    }),
    getOrganizationId: async () => "00000000-0000-0000-0000-000000000000",
  };
}

describe("MCP Server smoke test", () => {
  it("core package exports resolve correctly", async () => {
    const {
      ClaudeSyncClient,
      EnvAuth,
      OrganizationSchema,
      ConversationSchema,
      ArtifactListResponseSchema,
      SearchResponseSchema,
    } = await import("@infinite-room-labs/claudesync-core");
    expect(ClaudeSyncClient).toBeDefined();
    expect(EnvAuth).toBeDefined();
    expect(OrganizationSchema).toBeDefined();
    expect(ConversationSchema).toBeDefined();
    expect(ArtifactListResponseSchema).toBeDefined();
    expect(SearchResponseSchema).toBeDefined();
  });

  it("ClaudeSyncClient constructs with mock auth", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(client).toBeDefined();
    expect(typeof client.listOrganizations).toBe("function");
    expect(typeof client.listConversations).toBe("function");
    expect(typeof client.listConversationsAll).toBe("function");
    expect(typeof client.getConversation).toBe("function");
    expect(typeof client.searchConversations).toBe("function");
    expect(typeof client.listArtifacts).toBe("function");
    expect(typeof client.downloadArtifact).toBe("function");
  });

  it("ClaudeSyncClient constructs with custom rate limit delay", () => {
    const client = new ClaudeSyncClient(createMockAuth(), {
      rateLimitDelayMs: 500,
    });
    expect(client).toBeDefined();
  });

  it("ClaudeSyncClient.safeFilename strips path components", () => {
    expect(
      ClaudeSyncClient.safeFilename(
        "/mnt/user-data/outputs/architecture.md"
      )
    ).toBe("architecture.md");
    expect(
      ClaudeSyncClient.safeFilename(
        "/mnt/user-data/outputs/../../../etc/passwd"
      )
    ).toBe("passwd");
  });

  it("McpServer constructs with name and version", () => {
    const server = new McpServer({
      name: "claudesync",
      version: "0.1.0",
    });
    expect(server).toBeDefined();
  });
});
```

**Step 2: Run the smoke test**

Run: `npx vitest run packages/mcp-server/src/__tests__/smoke.test.ts`
Expected: All tests PASS

**Step 3: Run all tests across the monorepo**

Run: `pnpm test`
Expected: All tests across all packages PASS

**Step 4: Commit**

```bash
git add packages/mcp-server/src/__tests__/
git commit -m "test: add end-to-end smoke test for MCP server + core wiring"
```

---

## Summary

| Task | What | Package | Phase |
|------|------|---------|-------|
| 1 | Monorepo scaffold + pnpm workspaces + Node.js v24 | root | 1 |
| 2 | Zod schemas (with `.passthrough()`) + TypeScript types | core | 1 |
| 3 | AuthProvider interface + EnvAuth (with env-clear security) | core | 1 |
| 4 | API client (rate limiting, artifact path validation, double-parse) | core | 1 |
| 5 | Core barrel export (index.ts) | core | 1 |
| 6 | MCP server (tool registration + stdio only) | mcp-server | 1 |
| 7 | Cookie extraction helper script (manual Phase 1, automated Phase 3) | scripts | 1 |
| 8 | CLAUDE.md + .gitignore updates | root | 1 |
| 9 | Vitest configuration | core, mcp-server | 1 |
| 10 | End-to-end smoke test (synthetic fixtures only) | mcp-server | 1 |

**Dependencies:** Tasks 2-4 can be done in any order but must all complete before Task 5 (barrel export). Task 6 depends on Task 5. Tasks 7-9 are independent. Task 10 depends on Tasks 5+6.

---

## Deferred to Phase 2: ArtifactClient + Git Export Design

- Full `ArtifactClient` module wrapping wiggle filesystem API
- Artifact versioning follow-up spike (correlating files to messages)
- Git export design using `isomorphic-git` (pure JS)
- Staging directory with atomic rename on success
- `GitBundle` intermediate representation for extension export

## Deferred to Phase 3: CLI + Firefox Profile Auth

- `FirefoxProfileAuth` using `better-sqlite3` (with `immutable=1` URI flag for WAL safety)
- `claudesync export <conversation-url>` -- direct export
- `claudesync replay <bundle.json>` -- git replay from bundle
- `claudesync ls` -- list conversations
- Automated cookie extraction script (replaces Phase 1 manual instructions)
- npm publishing setup

## Deferred to Phase 4: Extension

- Firefox extension (MV2) -- only if artifact versioning question is answered
- Popup UI, content script, background script
- `ExtensionAuth` using `browser.cookies` API
- ZIP export with git-ready directory structure

## Cut from v1

- Conversation branching in git export (follow `current_leaf_message_uuid` only)
- Watch mode / live export (requires SSE streaming, untested)
- Chrome extension port
- Bulk export (single conversation is the v1 unit)
- Network transport for MCP server (unsafe -- exposes session cookie)

---

## Security Checklist (from security review)

These requirements apply across ALL tasks:

- [ ] Clear `CLAUDE_AI_COOKIE` from `process.env` after reading (Task 3)
- [ ] Validate artifact paths against `/mnt/user-data/` prefix (Task 4)
- [ ] Use `path.basename()` for all local file writes from artifact paths (Task 4)
- [ ] Never print cookie to stdout in extract-cookie script without `--stdout` flag (Task 7)
- [ ] Synthetic test fixtures only -- no real PII in test data (Task 10)
- [ ] MCP server: stdio transport only, document that network transport is unsafe (Task 6)
- [ ] `.env` files gitignored before any auth code is written (Task 8)
- [ ] No secrets in error messages or log output (all tasks)

---

*Updated: 2026-03-14*
*Author: Wes Gilleland / Infinite Room Labs LLC*
