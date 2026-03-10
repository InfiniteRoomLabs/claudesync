# ClaudeSync Monorepo Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scaffold a Bun workspace monorepo with a working read-only MCP server that wraps the claude.ai web API, backed by a shared core SDK.

**Architecture:** `@claudesync/core` provides auth (env vars + Firefox profile), an HTTP client (fetch-based), and Zod-validated data models. `@claudesync/mcp-server` is a thin shell that registers three MCP tools (list_organizations, list_conversations, get_conversation) over stdio transport. CLI and extension packages are stubs.

**Tech Stack:** Bun, TypeScript (strict), Zod, @modelcontextprotocol/sdk, bun:sqlite (for Firefox cookie reading)

---

## Task 1: Monorepo Scaffold + Workspace Configuration

**Files:**
- Create: `package.json` (workspace root)
- Create: `tsconfig.base.json`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`
- Create: `packages/cli/package.json`
- Create: `packages/extension/package.json`

**Step 1: Create root package.json with Bun workspaces**

```json
{
  "name": "claudesync",
  "private": true,
  "workspaces": [
    "packages/*"
  ]
}
```

**Step 2: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

**Step 3: Create packages/core/package.json**

```json
{
  "name": "@claudesync/core",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "zod": "^3.24"
  }
}
```

Note: Bun resolves `.ts` imports directly -- no build step needed for dev. `main` and `types` both point to source.

**Step 4: Create packages/core/tsconfig.json**

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

**Step 5: Create packages/mcp-server/package.json**

```json
{
  "name": "@claudesync/mcp-server",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "bin": {
    "claudesync-mcp": "src/index.ts"
  },
  "dependencies": {
    "@claudesync/core": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.12"
  }
}
```

**Step 6: Create packages/mcp-server/tsconfig.json**

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

**Step 7: Create stub packages**

`packages/cli/package.json`:
```json
{
  "name": "@claudesync/cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@claudesync/core": "workspace:*"
  }
}
```

`packages/extension/package.json`:
```json
{
  "name": "@claudesync/firefox-extension",
  "version": "0.1.0",
  "private": true,
  "type": "module"
}
```

**Step 8: Install dependencies**

Run: `bun install`
Expected: lockfile created, node_modules symlinked, zero errors.

**Step 9: Commit**

```bash
git add package.json tsconfig.base.json packages/*/package.json packages/*/tsconfig.json bun.lock
git commit -m "scaffold: Bun workspace monorepo with four packages"
```

---

## Task 2: Data Models (Zod Schemas + TypeScript Types)

**Files:**
- Create: `packages/core/src/models/schemas.ts`
- Create: `packages/core/src/models/types.ts`
- Test: `packages/core/src/models/__tests__/schemas.test.ts`

**Context:** The reference implementation (`~/projects/claude-web-api-research/unofficial-claude-api/claude_api/client.py`) shows these response shapes from the claude.ai API. We validate at runtime with Zod because the API is undocumented and can change without notice. Each schema has a `.passthrough()` call so unknown fields are preserved, not stripped.

**Step 1: Write the failing test**

Create `packages/core/src/models/__tests__/schemas.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import {
  OrganizationSchema,
  ConversationSummarySchema,
  ChatMessageSchema,
  ConversationSchema,
} from "../schemas";

describe("OrganizationSchema", () => {
  it("parses a valid organization", () => {
    const data = { uuid: "abc-123", name: "My Org" };
    const result = OrganizationSchema.parse(data);
    expect(result.uuid).toBe("abc-123");
    expect(result.name).toBe("My Org");
  });

  it("preserves unknown fields via passthrough", () => {
    const data = { uuid: "abc-123", name: "My Org", plan: "pro" };
    const result = OrganizationSchema.parse(data);
    expect((result as Record<string, unknown>).plan).toBe("pro");
  });

  it("rejects missing uuid", () => {
    expect(() => OrganizationSchema.parse({ name: "My Org" })).toThrow();
  });
});

describe("ChatMessageSchema", () => {
  it("parses a valid message", () => {
    const data = {
      uuid: "msg-1",
      text: "Hello",
      sender: "human",
      index: 0,
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      attachments: [],
    };
    const result = ChatMessageSchema.parse(data);
    expect(result.sender).toBe("human");
  });

  it("accepts assistant sender", () => {
    const data = {
      uuid: "msg-2",
      text: "Hi there",
      sender: "assistant",
      index: 1,
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      attachments: [],
    };
    expect(ChatMessageSchema.parse(data).sender).toBe("assistant");
  });

  it("rejects invalid sender", () => {
    const data = {
      uuid: "msg-3",
      text: "Bad",
      sender: "system",
      index: 0,
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      attachments: [],
    };
    expect(() => ChatMessageSchema.parse(data)).toThrow();
  });
});

describe("ConversationSummarySchema", () => {
  it("parses with null model", () => {
    const data = {
      uuid: "conv-1",
      name: "Test Chat",
      model: null,
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
    };
    const result = ConversationSummarySchema.parse(data);
    expect(result.model).toBeNull();
  });
});

describe("ConversationSchema", () => {
  it("parses a full conversation with messages", () => {
    const data = {
      uuid: "conv-1",
      name: "Test Chat",
      model: "claude-sonnet-4-5-20250514",
      created_at: "2026-03-10T00:00:00Z",
      updated_at: "2026-03-10T00:00:00Z",
      chat_messages: [
        {
          uuid: "msg-1",
          text: "Hello",
          sender: "human",
          index: 0,
          created_at: "2026-03-10T00:00:00Z",
          updated_at: "2026-03-10T00:00:00Z",
          attachments: [],
        },
      ],
    };
    const result = ConversationSchema.parse(data);
    expect(result.chat_messages).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test src/models/__tests__/schemas.test.ts`
Expected: FAIL -- cannot resolve `../schemas`

**Step 3: Write the schemas**

Create `packages/core/src/models/schemas.ts`:

```typescript
import { z } from "zod";

export const OrganizationSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
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
    attachments: z.array(AttachmentSchema).default([]),
  })
  .passthrough();

export const ConversationSummarySchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    model: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

export const ConversationSchema = ConversationSummarySchema.extend({
  chat_messages: z.array(ChatMessageSchema),
}).passthrough();
```

**Step 4: Write the inferred TypeScript types**

Create `packages/core/src/models/types.ts`:

```typescript
import type { z } from "zod";
import type {
  OrganizationSchema,
  AttachmentSchema,
  ChatMessageSchema,
  ConversationSummarySchema,
  ConversationSchema,
} from "./schemas";

export type Organization = z.infer<typeof OrganizationSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
```

**Step 5: Run tests to verify they pass**

Run: `cd packages/core && bun test src/models/__tests__/schemas.test.ts`
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

**Context:** The auth module provides a common interface for different authentication strategies. `EnvAuth` is the simplest -- it reads `CLAUDE_AI_COOKIE` from the environment. The reference implementation requires both a cookie string and a User-Agent header. We make User-Agent optional with a sensible default.

**Step 1: Write the failing test**

Create `packages/core/src/auth/__tests__/env.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { EnvAuth } from "../env";
import { AuthError } from "../errors";

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
    process.env.CLAUDE_AI_USER_AGENT = "MyCustomAgent/1.0";
    const auth = new EnvAuth();
    const headers = await auth.getHeaders();
    expect(headers["User-Agent"]).toBe("MyCustomAgent/1.0");
  });

  it("fetches organization ID from headers", async () => {
    process.env.CLAUDE_AI_COOKIE = "sessionKey=abc123";
    const auth = new EnvAuth();
    // getOrganizationId makes a real API call -- tested in integration tests
    // Here we just verify the method exists and is async
    expect(auth.getOrganizationId).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test src/auth/__tests__/env.test.ts`
Expected: FAIL -- cannot resolve `../env`

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
import type { AuthProvider } from "./types";
import { AuthError } from "./errors";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0";

export class EnvAuth implements AuthProvider {
  private readonly cookie: string;
  private readonly userAgent: string;
  private cachedOrgId: string | null = null;

  constructor() {
    const cookie = process.env.CLAUDE_AI_COOKIE;
    if (!cookie) {
      throw new AuthError(
        "CLAUDE_AI_COOKIE environment variable is required. " +
          "Get it from browser DevTools: Application > Cookies > claude.ai"
      );
    }
    this.cookie = cookie;
    this.userAgent = process.env.CLAUDE_AI_USER_AGENT ?? DEFAULT_USER_AGENT;
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

Run: `cd packages/core && bun test src/auth/__tests__/env.test.ts`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add packages/core/src/auth/
git commit -m "feat(core): add AuthProvider interface and EnvAuth implementation"
```

---

## Task 4: Auth Module -- FirefoxProfileAuth

**Files:**
- Create: `packages/core/src/auth/firefox.ts`
- Test: `packages/core/src/auth/__tests__/firefox.test.ts`

**Context:** Firefox stores cookies in a SQLite database at `~/.mozilla/firefox/<profile>/cookies.sqlite`. Bun has a built-in `bun:sqlite` module. We read the database in read-only mode (works while Firefox is running). Profile discovery uses `profiles.ini` to find the default profile. User-Agent is derived from the Firefox version string in `compatibility.ini` or falls back to a default.

**Step 1: Write the failing test**

Create `packages/core/src/auth/__tests__/firefox.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { findFirefoxProfiles, type FirefoxProfile } from "../firefox";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

describe("findFirefoxProfiles", () => {
  const firefoxDir = join(homedir(), ".mozilla", "firefox");
  const hasFirefox = existsSync(firefoxDir);

  it.skipIf(!hasFirefox)("finds at least one profile", () => {
    const profiles = findFirefoxProfiles();
    expect(profiles.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasFirefox)("each profile has name and path", () => {
    const profiles = findFirefoxProfiles();
    for (const p of profiles) {
      expect(p.name).toBeDefined();
      expect(p.path).toBeDefined();
      expect(typeof p.isDefault).toBe("boolean");
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test src/auth/__tests__/firefox.test.ts`
Expected: FAIL -- cannot resolve `../firefox`

**Step 3: Write FirefoxProfileAuth**

Create `packages/core/src/auth/firefox.ts`:

```typescript
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AuthProvider } from "./types";
import { AuthError } from "./errors";

export interface FirefoxProfile {
  name: string;
  path: string;
  isDefault: boolean;
}

const FIREFOX_DIR = join(homedir(), ".mozilla", "firefox");

/**
 * Parse Firefox profiles.ini to find available profiles.
 * Format is INI with [Profile0], [Profile1], etc. sections.
 */
export function findFirefoxProfiles(): FirefoxProfile[] {
  const iniPath = join(FIREFOX_DIR, "profiles.ini");
  if (!existsSync(iniPath)) {
    throw new AuthError(`Firefox profiles.ini not found at ${iniPath}`);
  }

  const content = readFileSync(iniPath, "utf-8");
  const profiles: FirefoxProfile[] = [];
  let current: Partial<FirefoxProfile> | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[Profile")) {
      if (current?.name && current?.path) {
        profiles.push(current as FirefoxProfile);
      }
      current = { isDefault: false };
    } else if (current && trimmed.startsWith("Name=")) {
      current.name = trimmed.slice(5);
    } else if (current && trimmed.startsWith("Path=")) {
      const relPath = trimmed.slice(5);
      current.path = join(FIREFOX_DIR, relPath);
    } else if (current && trimmed.startsWith("Default=1")) {
      current.isDefault = true;
    }
  }

  if (current?.name && current?.path) {
    profiles.push(current as FirefoxProfile);
  }

  return profiles;
}

/**
 * Read claude.ai cookies from a Firefox profile's cookies.sqlite.
 * Opens read-only -- works while Firefox is running.
 */
function readCookies(profilePath: string): string {
  const dbPath = join(profilePath, "cookies.sqlite");
  if (!existsSync(dbPath)) {
    throw new AuthError(`cookies.sqlite not found at ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        "SELECT name, value FROM moz_cookies WHERE host LIKE '%claude.ai%'"
      )
      .all() as Array<{ name: string; value: string }>;

    if (rows.length === 0) {
      throw new AuthError(
        "No claude.ai cookies found. Make sure you are logged in to claude.ai in Firefox."
      );
    }

    return rows.map((r) => `${r.name}=${r.value}`).join("; ");
  } finally {
    db.close();
  }
}

/**
 * Derive a User-Agent string from the Firefox profile.
 * Reads compatibility.ini for the Firefox version.
 */
function deriveUserAgent(profilePath: string): string {
  const compatPath = join(profilePath, "compatibility.ini");
  if (existsSync(compatPath)) {
    const content = readFileSync(compatPath, "utf-8");
    const match = content.match(/LastVersion=([0-9.]+)/);
    if (match) {
      const version = match[1].split(".")[0]; // major version only
      return `Mozilla/5.0 (X11; Linux x86_64; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`;
    }
  }
  // Fallback
  return "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0";
}

export class FirefoxProfileAuth implements AuthProvider {
  private readonly cookie: string;
  private readonly userAgent: string;
  private cachedOrgId: string | null = null;

  constructor(profilePath?: string) {
    if (profilePath) {
      this.cookie = readCookies(profilePath);
      this.userAgent = deriveUserAgent(profilePath);
    } else {
      const profiles = findFirefoxProfiles();
      const defaultProfile = profiles.find((p) => p.isDefault) ?? profiles[0];
      if (!defaultProfile) {
        throw new AuthError("No Firefox profiles found");
      }
      this.cookie = readCookies(defaultProfile.path);
      this.userAgent = deriveUserAgent(defaultProfile.path);
    }
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

**Step 4: Run tests to verify they pass**

Run: `cd packages/core && bun test src/auth/__tests__/firefox.test.ts`
Expected: All tests PASS (profile discovery tests skip if Firefox not installed)

**Step 5: Commit**

```bash
git add packages/core/src/auth/firefox.ts packages/core/src/auth/__tests__/firefox.test.ts
git commit -m "feat(core): add FirefoxProfileAuth with cookies.sqlite reader"
```

---

## Task 5: API Client -- Endpoints + ClaudeSyncClient

**Files:**
- Create: `packages/core/src/client/endpoints.ts`
- Create: `packages/core/src/client/client.ts`
- Create: `packages/core/src/client/errors.ts`
- Test: `packages/core/src/client/__tests__/endpoints.test.ts`
- Test: `packages/core/src/client/__tests__/client.test.ts`

**Context:** The API client wraps fetch calls to claude.ai. The reference implementation (`unofficial-claude-api/claude_api/client.py:183-213`) shows the request headers pattern -- we replicate the essential headers but skip TLS impersonation. The client accepts any AuthProvider and uses it for every request. Responses are validated through Zod schemas from Task 2.

**Step 1: Write endpoint tests**

Create `packages/core/src/client/__tests__/endpoints.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { buildUrl, ENDPOINTS } from "../endpoints";

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
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test src/client/__tests__/endpoints.test.ts`
Expected: FAIL -- cannot resolve `../endpoints`

**Step 3: Write endpoints module**

Create `packages/core/src/client/endpoints.ts`:

```typescript
const BASE_URL = "https://claude.ai";

export const ENDPOINTS = {
  organizations: "/api/organizations",
  conversations: (orgId: string) =>
    `/api/organizations/${orgId}/chat_conversations`,
  conversation: (orgId: string, chatId: string) =>
    `/api/organizations/${orgId}/chat_conversations/${chatId}`,
} as const;

export function buildUrl(path: string): string {
  return `${BASE_URL}${path}`;
}
```

**Step 4: Run endpoint tests**

Run: `cd packages/core && bun test src/client/__tests__/endpoints.test.ts`
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
      message ?? `Rate limited. Resets at ${new Date(resetsAt * 1000).toISOString()}`,
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
import { describe, expect, it, mock, beforeEach } from "bun:test";
import { ClaudeSyncClient } from "../client";
import type { AuthProvider } from "../../auth/types";

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

  it("exposes listOrganizations method", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.listOrganizations).toBe("function");
  });

  it("exposes listConversations method", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.listConversations).toBe("function");
  });

  it("exposes getConversation method", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.getConversation).toBe("function");
  });
});
```

**Step 7: Write the ClaudeSyncClient**

Create `packages/core/src/client/client.ts`:

```typescript
import type { AuthProvider } from "../auth/types";
import { buildUrl, ENDPOINTS } from "./endpoints";
import { ClaudeSyncError, RateLimitError } from "./errors";
import {
  OrganizationSchema,
  ConversationSummarySchema,
  ConversationSchema,
} from "../models/schemas";
import type {
  Organization,
  ConversationSummary,
  Conversation,
} from "../models/types";
import { z } from "zod";

export class ClaudeSyncClient {
  constructor(private readonly auth: AuthProvider) {}

  private async request(url: string): Promise<unknown> {
    const headers = await this.auth.getHeaders();
    const response = await fetch(url, { headers });

    if (response.status === 429) {
      const body = await response.json().catch(() => null);
      const resetsAt = body?.error?.resets_at;
      throw new RateLimitError(
        resetsAt ?? Math.floor(Date.now() / 1000) + 60
      );
    }

    if (!response.ok) {
      throw new ClaudeSyncError(
        `API request failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    return response.json();
  }

  async listOrganizations(): Promise<Organization[]> {
    const data = await this.request(buildUrl(ENDPOINTS.organizations));
    return z.array(OrganizationSchema).parse(data);
  }

  async listConversations(orgId: string): Promise<ConversationSummary[]> {
    const data = await this.request(
      buildUrl(ENDPOINTS.conversations(orgId))
    );
    return z.array(ConversationSummarySchema).parse(data);
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
}
```

**Step 8: Run all client tests**

Run: `cd packages/core && bun test src/client/__tests__/`
Expected: All tests PASS

**Step 9: Commit**

```bash
git add packages/core/src/client/
git commit -m "feat(core): add API client with endpoints, error types, and Zod-validated responses"
```

---

## Task 6: Core Package Public API (index.ts)

**Files:**
- Create: `packages/core/src/index.ts`

**Step 1: Write the barrel export**

Create `packages/core/src/index.ts`:

```typescript
// Auth
export type { AuthProvider } from "./auth/types";
export { EnvAuth } from "./auth/env";
export { FirefoxProfileAuth, findFirefoxProfiles } from "./auth/firefox";
export type { FirefoxProfile } from "./auth/firefox";
export { AuthError } from "./auth/errors";

// Client
export { ClaudeSyncClient } from "./client/client";
export { ClaudeSyncError, RateLimitError } from "./client/errors";

// Models
export {
  OrganizationSchema,
  AttachmentSchema,
  ChatMessageSchema,
  ConversationSummarySchema,
  ConversationSchema,
} from "./models/schemas";
export type {
  Organization,
  Attachment,
  ChatMessage,
  ConversationSummary,
  Conversation,
} from "./models/types";
```

**Step 2: Verify the package resolves**

Run: `cd packages/core && bun -e "import { ClaudeSyncClient } from './src/index'; console.log('OK')"`
Expected: prints `OK`

**Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): add barrel export for public API"
```

---

## Task 7: MCP Server -- Tool Registration + stdio Transport

**Files:**
- Create: `packages/mcp-server/src/server.ts`
- Create: `packages/mcp-server/src/index.ts`
- Test: manual test via `echo '...' | bun run packages/mcp-server/src/index.ts`

**Context:** The MCP server uses `@modelcontextprotocol/sdk` with stdio transport. It registers three tools that delegate to `ClaudeSyncClient` from `@claudesync/core`. Auth is resolved at startup -- try env vars first, fall back to Firefox profile. The MCP SDK's `Server` class handles JSON-RPC framing over stdin/stdout.

**Step 1: Write the server module**

Create `packages/mcp-server/src/server.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ClaudeSyncClient,
  EnvAuth,
  FirefoxProfileAuth,
  AuthError,
} from "@claudesync/core";
import type { AuthProvider } from "@claudesync/core";

function resolveAuth(): AuthProvider {
  // Try env vars first
  if (process.env.CLAUDE_AI_COOKIE) {
    return new EnvAuth();
  }

  // Fall back to Firefox profile
  try {
    return new FirefoxProfileAuth();
  } catch {
    throw new AuthError(
      "No authentication configured. Either set CLAUDE_AI_COOKIE environment variable " +
        "or ensure you are logged in to claude.ai in Firefox."
    );
  }
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
    "List conversations in a claude.ai organization. If orgId is omitted, uses the first available organization.",
    {
      orgId: z
        .string()
        .optional()
        .describe(
          "Organization UUID. Omit to auto-detect from session."
        ),
    },
    async ({ orgId }) => {
      const resolvedOrgId = orgId ?? (await auth.getOrganizationId());
      const conversations = await client.listConversations(resolvedOrgId);
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
    "Get a full claude.ai conversation including all messages",
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
      const resolvedOrgId = orgId ?? (await auth.getOrganizationId());
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
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Step 3: Verify the server starts**

Run: `CLAUDE_AI_COOKIE=test bun run packages/mcp-server/src/index.ts &` then send a JSON-RPC initialize request to stdin:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | CLAUDE_AI_COOKIE=test bun run packages/mcp-server/src/index.ts
```

Expected: JSON-RPC response with server capabilities including the three tools.

**Step 4: Commit**

```bash
git add packages/mcp-server/src/
git commit -m "feat(mcp-server): register read-only MCP tools with stdio transport"
```

---

## Task 8: Cookie Extraction Helper Script

**Files:**
- Create: `scripts/extract-cookie.ts`

**Context:** Helper script users can run to extract their claude.ai cookie from Firefox. Prints the cookie string they can copy into their env, or exports it directly.

**Step 1: Write the script**

Create `scripts/extract-cookie.ts`:

```typescript
#!/usr/bin/env bun

import { findFirefoxProfiles } from "@claudesync/core";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

const profiles = findFirefoxProfiles();

if (profiles.length === 0) {
  console.error("No Firefox profiles found.");
  process.exit(1);
}

const profile = profiles.find((p) => p.isDefault) ?? profiles[0];
console.error(`Using Firefox profile: ${profile.name} (${profile.path})`);

const dbPath = join(profile.path, "cookies.sqlite");
if (!existsSync(dbPath)) {
  console.error(`cookies.sqlite not found at ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const rows = db
  .query("SELECT name, value FROM moz_cookies WHERE host LIKE '%claude.ai%'")
  .all() as Array<{ name: string; value: string }>;
db.close();

if (rows.length === 0) {
  console.error(
    "No claude.ai cookies found. Make sure you are logged in to claude.ai in Firefox."
  );
  process.exit(1);
}

const cookie = rows.map((r) => `${r.name}=${r.value}`).join("; ");

// Print to stdout so it can be captured: export CLAUDE_AI_COOKIE=$(bun run scripts/extract-cookie.ts)
console.log(cookie);
console.error("\nTo use this cookie, run:");
console.error(`  export CLAUDE_AI_COOKIE='${cookie}'`);
```

**Step 2: Verify it runs**

Run: `bun run scripts/extract-cookie.ts`
Expected: Prints cookie string (or error if Firefox not logged in -- both are valid).

**Step 3: Commit**

```bash
git add scripts/extract-cookie.ts
git commit -m "feat: add Firefox cookie extraction helper script"
```

---

## Task 9: Update CLAUDE.md + .gitignore

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.gitignore`

**Context:** Update the project README for agents and add standard ignores for Bun/Node.

**Step 1: Update CLAUDE.md**

Replace the template CLAUDE.md with project-specific content:

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

ClaudeSync is a TypeScript monorepo wrapping the undocumented claude.ai web API. It provides a shared SDK (`@claudesync/core`) consumed by thin shells: an MCP server, CLI, and Firefox extension.

## Architecture

Three-layer design: `@claudesync/core` (SDK) -> consumers (MCP server, CLI, extension) -> claude.ai web API.

See `docs/plans/2026-03-10-claudesync-monorepo-design.md` for the full design document.

## Development

### Prerequisites

- [Bun](https://bun.sh/) >= 1.2

### Setup

```bash
bun install
```

### Running Tests

```bash
bun test                        # all packages
bun test --filter core          # core package only
```

### Running the MCP Server

```bash
# Set your claude.ai cookie (grab from browser DevTools)
export CLAUDE_AI_COOKIE='your-cookie-string'

# Or extract from Firefox automatically
export CLAUDE_AI_COOKIE=$(bun run scripts/extract-cookie.ts)

# Run the server
bun run packages/mcp-server/src/index.ts
```

### Package Structure

| Package | Path | Purpose |
|---------|------|---------|
| @claudesync/core | packages/core/ | Auth, API client, data models |
| @claudesync/mcp-server | packages/mcp-server/ | MCP server (stdio transport) |
| @claudesync/cli | packages/cli/ | CLI tool (stub) |
| @claudesync/firefox-extension | packages/extension/ | Firefox extension (stub) |

## Conventions

### Monorepo

- Bun workspaces -- no Turborepo
- Packages import each other via `workspace:*`
- No build step for dev -- Bun resolves .ts directly

### API Client

- Standard `fetch` -- no TLS impersonation
- All API responses validated through Zod schemas with `.passthrough()`
- Auth via `AuthProvider` interface (env vars or Firefox profile)

### File Encoding

**UTF-8 only.** No Windows-1252 smart quotes, em/en dashes, or copy-pasted Office characters.

### Git Discipline

- Never commit agent directories (`.claude/`, `.codex/`, `.gemini/`, etc.)
- Imperative mood commit messages
- Never rewrite shared branch history
- Never commit secrets or credentials
```

**Step 2: Update .gitignore**

Append Bun/Node-specific ignores:

```
# Dependencies
node_modules/

# Bun
bun.lock

# Build output
dist/

# Environment
.env
.env.*
```

Note: Whether to commit `bun.lock` is a team decision. Including it here as ignored for now since this is a library/tool, not an application. Remove the `bun.lock` line if you want reproducible installs.

**Step 3: Commit**

```bash
git add CLAUDE.md .gitignore
git commit -m "docs: update CLAUDE.md with project-specific guidance and .gitignore"
```

---

## Task 10: End-to-End Smoke Test

**Files:**
- Create: `packages/mcp-server/src/__tests__/smoke.test.ts`

**Context:** Verify the full stack wires together: auth resolves, client constructs, MCP server creates and registers tools. This does NOT make real API calls -- it tests the wiring with a mock auth provider.

**Step 1: Write the smoke test**

Create `packages/mcp-server/src/__tests__/smoke.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClaudeSyncClient, type AuthProvider } from "@claudesync/core";

function createMockAuth(): AuthProvider {
  return {
    getHeaders: async () => ({
      Cookie: "mock-cookie",
      "User-Agent": "mock-agent",
    }),
    getOrganizationId: async () => "mock-org-id",
  };
}

describe("MCP Server smoke test", () => {
  it("core package exports resolve correctly", async () => {
    const {
      ClaudeSyncClient,
      EnvAuth,
      FirefoxProfileAuth,
      OrganizationSchema,
      ConversationSchema,
    } = await import("@claudesync/core");
    expect(ClaudeSyncClient).toBeDefined();
    expect(EnvAuth).toBeDefined();
    expect(FirefoxProfileAuth).toBeDefined();
    expect(OrganizationSchema).toBeDefined();
    expect(ConversationSchema).toBeDefined();
  });

  it("ClaudeSyncClient constructs with mock auth", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(client).toBeDefined();
    expect(typeof client.listOrganizations).toBe("function");
    expect(typeof client.listConversations).toBe("function");
    expect(typeof client.getConversation).toBe("function");
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

Run: `bun test packages/mcp-server/src/__tests__/smoke.test.ts`
Expected: All tests PASS

**Step 3: Run all tests across the monorepo**

Run: `bun test`
Expected: All tests across all packages PASS

**Step 4: Commit**

```bash
git add packages/mcp-server/src/__tests__/
git commit -m "test: add end-to-end smoke test for MCP server + core wiring"
```

---

## Summary

| Task | What | Package |
|------|------|---------|
| 1 | Monorepo scaffold + Bun workspaces | root |
| 2 | Zod schemas + TypeScript types | core |
| 3 | AuthProvider interface + EnvAuth | core |
| 4 | FirefoxProfileAuth (cookies.sqlite) | core |
| 5 | API client (endpoints + ClaudeSyncClient) | core |
| 6 | Core barrel export (index.ts) | core |
| 7 | MCP server (tool registration + stdio) | mcp-server |
| 8 | Cookie extraction helper script | scripts |
| 9 | CLAUDE.md + .gitignore updates | root |
| 10 | End-to-end smoke test | mcp-server |

**Dependencies:** Tasks 2-5 can be done in any order but must all complete before Task 6 (barrel export). Task 7 depends on Task 6. Tasks 8-9 are independent. Task 10 depends on Tasks 6+7.
