---
title: "ClaudeSync"
description: Unofficial SDK wrapping claude.ai web API + Firefox extension for git-style conversation export with artifact versioning
author: Wes Gilleland
version: 0.3.0
status: draft
date: 2026-03-14
source: Slack #ideas
tags: [claude-ai, sdk, typescript, firefox-extension, git, artifacts, export, reverse-engineering]
---

# ClaudeSync -- PRD v0.3

> Unofficial SDK wrapping claude.ai's web API + Firefox extension for git-style conversation export with artifact versioning.

---

## Executive Summary

ClaudeSync is a TypeScript/Node.js SDK that wraps the undocumented claude.ai web interface API, enabling programmatic access to conversations, artifacts, projects, and account management. The first consumer is a Firefox extension that exports conversations as git repositories where each artifact version maps to a commit.

**Why this exists:** Claude.ai has no export-with-artifacts feature. Existing tools (ClaudeExport, claude-exporter) export flat JSON/Markdown but lose artifact version history. The git-repo format preserves the full evolution of code artifacts — which is the actual value of a Claude coding session.

**Positioning:** yt-dlp energy. Unofficial, community tool, your-data-is-yours philosophy. MIT licensed.

---

## Prior Art & Competitive Gap

| Project | What It Does | What It Misses |
|---------|-------------|----------------|
| `st1vms/unofficial-claude-api` (Python) | Cookie+UA auth, Selenium session capture, send/receive messages, file attachments (5 files/10MB), proxy support (HTTP/SOCKS), rate limit detection | No artifact extraction, no export, no Projects API, no search, Python-only |
| `KoushikNavuluri/Claude-API` (Python) | Cookie-auth, send/receive messages, conversation CRUD, basic file uploads | **ABANDONED** (last commit Aug 2023), hardcoded to claude-2, no data models, almost certainly broken against current API |
| `agoramachina/claude-exporter` (Chrome/Firefox) | Bulk export conversations as JSON/MD/TXT with artifact extraction | Flat export -- no artifact versioning, no SDK, no programmatic access |
| `Llaves/ClaudeExport` (Chrome/Firefox) | HTML export mimicking claude.ai UI | No artifact versioning, HTML-only output |
| `socketteer/Claude-Conversation-Exporter` | Chrome export with model inference | No artifacts, Chrome-only |
| Claude.ai "Export Data" (Settings) | ZIP of all conversations as JSON | Deleted conversation stubs included, no artifact content, no versioning |

**The gap:** Nobody does artifact version tracking -> git commits. Nobody provides an SDK-first architecture where browser extensions, CLIs, and MCP servers are all thin consumers of the same core library.

---

## Prior Art Deep Audit (March 2026)

Both unofficial Python libraries were cloned and audited on 2026-03-07. Full source was read and analyzed.

### st1vms/unofficial-claude-api v0.3.3

**Status:** Actively maintained. 93 commits, last code change Dec 2024, docs updated Jun 2025. Published on PyPI. Python >= 3.10.

**Dependencies:** `requests`, `curl_cffi` (Chrome 110 impersonation), `selgym` (Selenium/Firefox), `tzlocal`

**Authentication:**
- Cookie string + User-Agent header (both required)
- Selenium-based auto-capture via Firefox (`get_session_data()`) -- opens browser, extracts cookies + UA + org ID
- Manual alternative: construct `SessionData(cookie, user_agent, org_id)` directly
- No token refresh or session health check

**API Surface (6 public methods on `ClaudeAPIClient`):**

| Method | Returns | Notes |
|--------|---------|-------|
| `send_message(chat_id, prompt, attachment_paths)` | `SendMessageResponse` (frozen dataclass: answer, status_code, raw_answer) | Max 5 files, 10MB each |
| `create_chat()` | `str` (UUID) or `None` | Returns None on rate limit (no exception) |
| `delete_chat(chat_id)` | `bool` | Expects HTTP 204 |
| `get_chat_data(chat_id)` | `dict` | Full conversation JSON with messages |
| `get_all_chat_ids()` | `list[str]` | UUIDs only |
| `delete_all_chats()` | `bool` | Bulk delete, all-or-nothing |

**Endpoints hit:**

| Verb | Path | Purpose |
|------|------|---------|
| GET | `/api/organizations` | Fetch org UUIDs |
| POST | `/api/{org_id}/upload` | File attachment upload |
| GET | `/api/organizations/{org_id}/chat_conversations` | List all chats |
| POST | `/api/organizations/{org_id}/chat_conversations` | Create chat |
| GET | `/api/organizations/{org_id}/chat_conversations/{chat_id}` | Get chat data |
| DELETE | `/api/organizations/{org_id}/chat_conversations/{chat_id}` | Delete chat |
| POST | `/api/organizations/{org_id}/chat_conversations/{chat_id}/completion` | Send message (SSE) |

**Data models:** `SendMessageResponse`, `SessionData`, `HTTPProxy`, `SOCKSProxy` (all dataclasses). Exception hierarchy: `ClaudeAPIError` -> `MessageRateLimitError` (with `reset_timestamp`, `sleep_sec`), `OverloadError`.

**Strengths:** Proxy support, rate limit handling with reset timestamps, proper error hierarchy, configurable model name, auto-timezone detection.

**Weaknesses:** No test suite, Chrome 110 impersonation hardcoded, Firefox-only for Selenium, no streaming iterator (blocks until completion).

**ClaudeSync workaround for Selenium dependency:** Skip `selgym`/Selenium entirely. Read cookies from Firefox's `cookies.sqlite` file directly (SQLite, read-only mode, works while browser is running). Derive User-Agent from Firefox version or `prefs.js`. Fetch org ID via plain HTTP GET to `/api/organizations`. This eliminates the geckodriver dependency and browser popup entirely.

### KoushikNavuluri/Claude-API v1.0.17

**Status: ABANDONED.** 68 commits across one month (Jul-Aug 2023). Zero activity since. Almost certainly non-functional against current claude.ai.

**Dependencies:** `requests`, `curl_cffi`

**Authentication:** Raw cookie string only. No User-Agent requirement. No auto-capture.

**API Surface (11 methods, but thin):** `send_message`, `list_all_conversations`, `create_new_chat`, `delete_conversation`, `chat_conversation_history`, `rename_chat`, `reset_all`, `upload_attachment`, `get_organization_id`, `get_content_type`, `generate_uuid`

**Critical Issues:**
- Model hardcoded to `"claude-2"` (line 97)
- Timezone hardcoded to `"Asia/Kolkata"` (line 96)
- No data models -- returns raw dicts
- No error handling beyond True/False
- Brittle SSE parsing
- Only handles pdf/txt/csv file types

**Verdict:** Reference value only. The endpoint paths and request shapes are useful as historical data points, but no code is reusable.

---

## Gap Analysis: What Neither Library Covers

These are capabilities ClaudeSync needs that do not exist in any known unofficial client. Each represents wholesale implementation work.

### Tier 1 -- Core to ClaudeSync Value Prop

**1. Projects API (~~complete gap~~ endpoints discovered)**
No existing library provides access, but the spike (2026-03-14) mapped all endpoints:
- `GET /projects` -- list all projects
- `GET /projects/{id}/docs` -- knowledge files with full content inline
- `GET /projects/{id}/files` -- uploaded binary files
- `GET /projects/{id}/conversations` -- project-scoped conversation list
- `GET /projects/{id}/settings` -- project configuration
- Still no existing implementation -- ClaudeSync will be first

**2. Artifact Extraction & Versioning (~~complete gap~~ approach clarified)**
The spike proved artifacts use the "wiggle" filesystem API, not inline text markers:
- `GET /conversations/{id}/wiggle/list-files` -- lists artifact files with metadata
- `GET /conversations/{id}/wiggle/download-file?path={path}` -- downloads content
- Files have `created_at` timestamps for version ordering
- No existing implementation -- ClaudeSync will be first
- Remaining unknown: how to correlate artifact files to specific messages

**3. Conversation Structure Awareness (~~complete gap~~ tree structure confirmed)**
The spike confirmed messages form a linked tree via `parent_message_uuid`:
- `current_leaf_message_uuid` on the conversation identifies the active branch
- Full tree reconstruction possible by following parent links
- Model info available per conversation (e.g., `"claude-opus-4-6"`)
- No existing implementation handles branching

### Tier 2 -- Important for SDK Completeness

**4. Search (~~complete gap~~ endpoint discovered)**
- Full-text search: `GET /conversation/search?query={q}&n={limit}`
- Returns chunked results with conversation UUIDs and matching text snippets
- Response is double-JSON-encoded (needs double parse)
- No existing implementation

**5. Conversation Organization (complete gap)**
- No starring/favoriting
- No folder/label management
- No shared conversation link creation or management

**6. Session Lifecycle Management (partial gap -- workarounds identified)**
st1vms uses Selenium/Firefox to capture cookies interactively. This is heavyweight (requires geckodriver, pops a browser window) and unnecessary when the user is already logged in. Workarounds:

- **Direct `cookies.sqlite` read:** Firefox stores all cookies (including httpOnly) in `~/.mozilla/firefox/<profile>/cookies.sqlite`, table `moz_cookies`. Query: `SELECT name, value FROM moz_cookies WHERE host LIKE '%claude.ai%'`. Works while Firefox is running if opened read-only (`?mode=ro` URI). Session cookies are persisted in modern Firefox. Zero dependencies beyond `sqlite3`.
- **User-Agent:** Not available from `cookies.sqlite`, but can be read from Firefox's `about:support` page, the `general.useragent.override` pref in `prefs.js`, or simply constructed from the known Firefox version string. claude.ai may or may not validate UA consistency with the session -- needs testing.
- **Org ID:** Just a GET to `/api/organizations` with the cookie. No browser needed.

Remaining gaps even with workarounds:
- No session health check (is this cookie still valid?)
- No token/session refresh mechanism
- No graceful expiry detection and re-auth flow
- No profile auto-discovery (finding the right Firefox profile directory)

**7. Streaming API (partial gap)**
Both do SSE parsing but neither exposes it properly:
- No streaming iterator/async generator API
- No partial artifact state tracking during streaming
- No callback/event emitter pattern for real-time consumers

### Tier 3 -- Nice to Have for Full Platform

**8. Account & Settings (complete gap)**
- No access to account preferences
- No memory/personalization API
- No usage or billing information

**9. Feature Selection (partial gap)**
st1vms allows model name override, but:
- No control over extended thinking toggle
- No tool use configuration
- No web search toggle
- No conversation "style" settings

**10. Bulk Operations & Export (partial gap)**
st1vms has `delete_all_chats()` but:
- No bulk conversation export
- No incremental sync (export only new/changed since last sync)
- No pagination handling for large conversation lists

---

## Architecture

### Three-Layer Design

```
┌─────────────────────────────────────────────┐
│  Consumers (thin shells)                     │
│  ┌──────────┐ ┌─────┐ ┌──────────┐         │
│  │ Firefox  │ │ CLI │ │ MCP      │         │
│  │ Extension│ │     │ │ Server   │         │
│  └────┬─────┘ └──┬──┘ └────┬─────┘         │
│       │          │          │                │
├───────┴──────────┴──────────┴────────────────┤
│  @infinite-room-labs/claudesync-core  (TypeScript SDK)          │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ Auth     │ │ API      │ │ Git Export   │ │
│  │ (cookie/ │ │ Client   │ │ Engine       │ │
│  │  session)│ │          │ │              │ │
│  └──────────┘ └──────────┘ └──────────────┘ │
├──────────────────────────────────────────────┤
│  claude.ai Web API (undocumented)            │
│  /api/organizations/{org}/chat_conversations │
│  /api/organizations/{org}/projects           │
│  /api/...                                    │
└──────────────────────────────────────────────┘
```

### Package Structure (Monorepo)

```
claudesync/
├── packages/
│   ├── core/                  # @infinite-room-labs/claudesync-core — the SDK
│   │   ├── src/
│   │   │   ├── auth/          # Session/cookie management
│   │   │   ├── client/        # HTTP client wrapping claude.ai API
│   │   │   ├── models/        # TypeScript types for API responses
│   │   │   ├── export/        # Export engines (git, json, md)
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── extension/             # @infinite-room-labs/claudesync-firefox-extension
│   │   ├── manifest.json      # Manifest V2 (Firefox) or V3
│   │   ├── background/
│   │   ├── popup/
│   │   ├── content/
│   │   └── package.json
│   └── cli/                   # @infinite-room-labs/claudesync-cli (future)
│       └── package.json
├── package.json               # Workspace root
├── turbo.json                 # Turborepo config
└── tsconfig.base.json
```

---

## SDK Design (`@infinite-room-labs/claudesync-core`)

### Authentication

claude.ai uses session cookies. Three auth strategies (in order of preference for each consumer):

1. **Firefox Profile Read** -- Read cookies directly from Firefox's `cookies.sqlite` database. Zero dependencies beyond SQLite. Best for CLI and MCP server consumers. Requires locating the Firefox profile directory (`~/.mozilla/firefox/<profile>/`) and opening the DB read-only. httpOnly cookies are accessible (that flag only restricts browser JS, not file reads). User-Agent can be derived from Firefox version or read from `prefs.js`.
2. **Cookie Injection** -- User provides raw cookie string manually (extracted from browser DevTools). Simple, works everywhere, no Firefox dependency. Fallback for non-Firefox users.
3. **Browser Extension Context** -- Extension reads cookies from its own context via `browser.cookies` API. Zero friction for extension users. Has native access to UA and can auto-discover org ID.

```typescript
interface AuthProvider {
  getHeaders(): Promise<Record<string, string>>;
  getOrganizationId(): Promise<string>;
}

class FirefoxProfileAuth implements AuthProvider {
  // Reads cookies.sqlite directly (SQLite read-only mode)
  // Auto-discovers profile dir from ~/.mozilla/firefox/profiles.ini
  // Derives User-Agent from Firefox version
  constructor(private profilePath?: string) {}
}

class CookieAuth implements AuthProvider {
  constructor(private cookie: string, private orgId?: string) {}
  // Manual cookie string + optional UA override
}

class ExtensionAuth implements AuthProvider {
  // Uses browser.cookies API
  // Auto-discovers org ID from /api/organizations
}
```

### API Client

Known endpoints confirmed via technical spike (2026-03-14):

#### Bootstrap & Account

| Verb | Path | Purpose | Paginated? |
|------|------|---------|------------|
| GET | `/api/bootstrap` | SPA initialization -- account, feature flags, system prompts | No |
| GET | `/api/account` | User profile, memberships, settings | No |
| GET | `/api/account/raven_eligible` | Unknown eligibility check | No |

#### Organizations

| Verb | Path | Purpose | Paginated? |
|------|------|---------|------------|
| GET | `/api/organizations` | List orgs with full settings + capabilities | No |
| GET | `/api/organizations/{org}/members` | Org members list | Unknown |
| GET | `/api/organizations/{org}/sync/settings` | Integration settings (Google Calendar, etc.) | No |

#### Conversations

| Verb | Path | Purpose | Paginated? |
|------|------|---------|------------|
| GET | `/api/organizations/{org}/chat_conversations` | List ALL conversations (no pagination -- 1375 returned at once) | **No** |
| GET | `/api/organizations/{org}/chat_conversations/{id}` | Full conversation with all messages | No |
| POST | `/api/organizations/{org}/chat_conversations` | Create conversation | N/A |
| DELETE | `/api/organizations/{org}/chat_conversations/{id}` | Delete conversation | N/A |
| POST | `/api/organizations/{org}/chat_conversations/{id}/completion` | Send message (SSE) | N/A |
| GET | `/api/organizations/{org}/conversation/search?query={q}&n={limit}` | Full-text search across conversations | Via `n` param |

#### Projects

| Verb | Path | Purpose |
|------|------|---------|
| GET | `/api/organizations/{org}/projects` | List all projects |
| GET | `/api/organizations/{org}/projects/{id}` | Single project detail |
| GET | `/api/organizations/{org}/projects/{id}/docs` | Knowledge files (full content inline) |
| GET | `/api/organizations/{org}/projects/{id}/files` | Uploaded files |
| GET | `/api/organizations/{org}/projects/{id}/conversations` | Project-scoped conversation list |
| GET | `/api/organizations/{org}/projects/{id}/settings` | Project settings |

#### Artifacts (Wiggle Filesystem)

| Verb | Path | Purpose |
|------|------|---------|
| GET | `/api/organizations/{org}/conversations/{id}/wiggle/list-files` | List artifact files for a conversation |
| GET | `/api/organizations/{org}/conversations/{id}/wiggle/download-file?path={path}` | Download artifact file content |
| GET | `/api/organizations/{org}/artifacts/wiggle_artifact/{artifact_id}/manage/storage/info` | Artifact storage metadata |
| GET | `/api/organizations/{org}/artifacts/wiggle_artifact/{artifact_id}/tools` | Artifact tool availability |
| GET | `/api/organizations/{org}/user_artifacts?limit={n}&offset={n}` | List user artifacts (returned 500 -- may be unstable) |
| GET | `/api/organizations/{org}/user_artifacts/count` | Count user artifacts (returned 500) |

#### File Upload

| Verb | Path | Purpose |
|------|------|---------|
| POST | `/api/{org}/upload` | Upload file attachment |

```typescript
interface ClaudeSyncClient {
  // Bootstrap
  getBootstrap(): Promise<BootstrapResponse>;
  getAccount(): Promise<Account>;

  // Organizations
  listOrganizations(): Promise<Organization[]>;
  getOrgMembers(orgId: string): Promise<Member[]>;

  // Conversations
  listConversations(orgId: string): Promise<ConversationSummary[]>;
  getConversation(orgId: string, chatId: string): Promise<Conversation>;
  searchConversations(orgId: string, query: string, limit?: number): Promise<SearchResponse>;

  // Projects
  listProjects(orgId: string): Promise<Project[]>;
  getProject(orgId: string, projectId: string): Promise<Project>;
  getProjectDocs(orgId: string, projectId: string): Promise<ProjectDoc[]>;
  getProjectFiles(orgId: string, projectId: string): Promise<ProjectFile[]>;
  getProjectConversations(orgId: string, projectId: string): Promise<ConversationSummary[]>;

  // Artifacts
  listArtifacts(orgId: string, conversationId: string): Promise<ArtifactListResponse>;
  downloadArtifact(orgId: string, conversationId: string, path: string): Promise<string>;

  // Write ops (deferred -- POC is read-only)
  sendMessage(orgId: string, chatId: string, message: string): Promise<StreamResponse>;
}
```

### Data Models

Data models confirmed via technical spike (2026-03-14). Key finding: artifact content is NOT inline in message text -- it lives in a separate "wiggle" filesystem API.

```typescript
interface Organization {
  id: number;
  uuid: string;
  name: string;
  settings: OrgSettings;              // Feature flags, sharing controls
  capabilities: string[];             // e.g., ["chat", "claude_max"]
  parent_organization_uuid: string | null;
  rate_limit_tier: string;            // e.g., "default_claude_max_20x"
  billing_type: string;               // "stripe_subscription" | "prepaid"
  free_credits_status: unknown;
  data_retention: string;
  raven_type: string | null;
  merchant_of_record: string;
  has_icon: boolean;
  is_csp_managed: boolean;
  created_at: string;
  updated_at: string;
  active_flags: string[];
  data_retention_periods: unknown;
}

interface ConversationSummary {
  uuid: string;
  name: string;
  summary: string;
  model: string;                      // e.g., "claude-opus-4-6"
  created_at: string;
  updated_at: string;
  settings: ConversationSettings;     // Feature flags per conversation
  is_starred: boolean;
  is_temporary: boolean;
  project_uuid: string | null;
  session_id: string | null;
  platform: string;                   // "CLAUDE_AI"
  current_leaf_message_uuid: string;  // Active branch pointer
  user_uuid: string;
  project?: { uuid: string; name: string }; // Embedded when listing globally
}

interface ConversationSettings {
  enabled_bananagrams: boolean;       // Extended thinking?
  enabled_web_search: boolean;
  enabled_compass: boolean | null;
  enabled_sourdough: boolean;
  enabled_foccacia: boolean;
  enabled_mcp_tools: Record<string, boolean>;
}

interface Conversation extends ConversationSummary {
  chat_messages: ChatMessage[];
}

interface ChatMessage {
  uuid: string;
  text: string;                       // Clean text only -- NO artifact content
  sender: 'human' | 'assistant';
  index: number;
  created_at: string;
  updated_at: string;
  truncated: boolean;
  stop_reason?: string;               // Assistant messages only
  input_mode?: string;                // Human messages only
  attachments: Attachment[];
  files: File[];
  files_v2: FileV2[];
  sync_sources: SyncSource[];
  parent_message_uuid: string;        // Tree structure for branching
}

interface Project {
  uuid: string;
  name: string;
  description: string;
  is_private: boolean;
  creator: { uuid: string; full_name: string };
  is_starred: boolean;
  is_starter_project: boolean;
  is_harmony_project: boolean;
  type: string | null;
  subtype: string | null;
  settings: Record<string, unknown>;
  archiver: unknown;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  permissions: string[];              // RBAC-style permission strings
  docs_count: number;
  files_count: number;
}

interface SearchResponse {
  chunks: SearchChunk[];
}

interface SearchChunk {
  doc_uuid: string;                   // Internal document ID
  start: number;                      // Character offset in source
  end: number;
  name: string;                       // Conversation title
  text: string;                       // Matching text snippet
  extras: {
    conversation_uuid: string;
    conversation_title: string;
    doc_type: string;                 // "conversation"
    read_at: string;
    updated_at: string;
    ingestion_date: string;
  };
}
```

Note: Search response is double-JSON-encoded (string containing JSON string containing the actual data). Parse with `JSON.parse(JSON.parse(responseText))`.

### Artifact Client (Wiggle Filesystem)

**Updated 2026-03-14:** The spike proved that artifacts are NOT inline XML markers in message text. They use a separate storage system codenamed "wiggle" with its own filesystem API. The `text` field of assistant messages contains only conversational text.

Artifact access is a two-step process:

1. **List files:** `GET /api/organizations/{org}/conversations/{id}/wiggle/list-files` returns file paths and metadata
2. **Download content:** `GET /api/organizations/{org}/conversations/{id}/wiggle/download-file?path={path}` returns raw file content

Files live at paths like `/mnt/user-data/outputs/filename.md`. Each artifact also has a UUID accessible via `/artifacts/wiggle_artifact/{artifact_id}` endpoints.

```typescript
interface ArtifactFileMetadata {
  path: string;                    // e.g., "/mnt/user-data/outputs/storydex-architecture.md"
  size: number;
  content_type: string;            // e.g., "text/plain"
  created_at: string;
  custom_metadata: {
    filename: string;
  };
}

interface ArtifactListResponse {
  success: boolean;
  files: string[];                 // File paths
  files_metadata: ArtifactFileMetadata[];
}

interface ArtifactClient {
  listFiles(orgId: string, conversationId: string): Promise<ArtifactListResponse>;
  downloadFile(orgId: string, conversationId: string, path: string): Promise<string>;
  getStorageInfo(orgId: string, artifactId: string): Promise<unknown>;
}
```

Artifact versioning must be inferred from file timestamps and conversation message ordering, not from inline markers. The `files_metadata[].created_at` timestamp correlates artifacts to the messages that produced them.

### Git Export Engine

The headline feature. Converts a conversation + artifacts into a git repository structure. Updated to reflect spike findings: artifact content comes from the wiggle API (separate download per file), and branching is supported via `parent_message_uuid` tree traversal.

```typescript
interface GitExportOptions {
  outputPath: string;
  includeConversation: boolean;  // Include conversation.md alongside artifacts
  commitPerMessage: boolean;     // One commit per assistant message, or one per artifact version
  authorName: string;            // Git author for commits
  authorEmail: string;
  branchName: string;            // Default: 'main'
  exportBranches: boolean;       // Export conversation branches as git branches
}

async function exportToGit(
  conversation: Conversation,
  artifacts: ArtifactListResponse,
  artifactContents: Map<string, string>,  // path -> downloaded content
  options: GitExportOptions
): Promise<void>;
```

**Branching strategy:**

Messages form a tree via `parent_message_uuid`. The conversation's `current_leaf_message_uuid` identifies the "main" branch. The export engine:

1. Builds the message tree from `parent_message_uuid` links
2. Finds all leaf nodes (branch tips)
3. The branch containing `current_leaf_message_uuid` becomes `main`
4. Other branches become named git branches (e.g., `branch-1`, `branch-2`)

**Commit strategy:**

```
commit 1: "Initial conversation"
  - conversation.md (full conversation text for main branch)
  - README.md (metadata: model, date, participants)

commit 2: "Create storydex-architecture.md" [timestamp from artifact metadata]
  - artifacts/storydex-architecture.md (downloaded from wiggle API)

commit 3: "Update storydex-architecture.md"
  - artifacts/storydex-architecture.md (next version, inferred from timestamps)
```

Each commit:
- Uses the artifact `created_at` timestamp as the commit date
- Artifact content downloaded separately via `ArtifactClient.downloadFile()`
- Git author is configurable (default: "Claude <claude@anthropic.com>" for assistant, user's name for human messages)
- Tags for conversation metadata

**File extension mapping:**

Artifact files from the wiggle API already have their correct filenames and extensions (e.g., `storydex-architecture.md`). The `content_type` field in metadata provides additional type information. No client-side type-to-extension mapping is needed.

**Non-git fallback formats:**

For the Firefox extension (which can't run `git init`), export as:
- **ZIP with git-compatible structure** — User can `cd` into it and `git init && git add -A` 
- **JSON manifest** — Machine-readable timeline that a CLI tool can replay into git commits

```typescript
// For environments without git (browser extension)
interface GitBundle {
  metadata: ConversationMetadata;
  commits: Array<{
    timestamp: string;
    message: string;
    author: { name: string; email: string };
    files: Record<string, string>;  // path → content
  }>;
}

function exportToGitBundle(
  conversation: Conversation,
  artifacts: ArtifactTimeline[]
): GitBundle;

// CLI/Node.js can replay this into actual git commits:
async function replayBundle(bundle: GitBundle, repoPath: string): Promise<void>;
```

---

## Firefox Extension (`@infinite-room-labs/claudesync-firefox-extension`)

### Manifest

Firefox still supports Manifest V2 (and MV3 with some differences from Chrome). Target MV2 first for maximum compatibility, upgrade path to MV3 later.

### Permissions

```json
{
  "permissions": [
    "cookies",
    "activeTab",
    "downloads"
  ],
  "host_permissions": [
    "https://claude.ai/*"
  ]
}
```

### UX Flow

1. User navigates to a conversation on claude.ai
2. Clicks extension icon → popup shows conversation info + artifact count
3. User selects export format:
   - **Git Bundle (JSON)** — Downloads `.claudesync.json`, can be replayed to git via CLI
   - **Git Bundle (ZIP)** — Downloads ZIP with directory structure ready for `git init`
   - **Markdown** — Flat conversation export (fallback)
   - **JSON** — Raw structured data
4. Download triggers

### Content Script

Injects into claude.ai pages to:
- Detect current conversation ID from URL (`/chat/{uuid}`)
- Optionally intercept network responses (artifact data) for richer extraction
- Communicate with background script via `browser.runtime.sendMessage`

### Background Script

- Manages auth (reads claude.ai cookies)
- Makes API calls via `@infinite-room-labs/claudesync-core`
- Handles export generation and download triggering

---

## Implementation Phases

### Phase 1: SDK Core + Artifact Client (Week 1-2)

**Goal:** `@infinite-room-labs/claudesync-core` can authenticate, fetch conversations, list/download artifacts from the wiggle API, and output a git bundle JSON.

Deliverables:
- [ ] TypeScript project scaffolding (monorepo with pnpm workspaces, Node.js runtime)
- [ ] Auth module (cookie-based)
- [ ] API client (bootstrap, orgs, conversations, projects, search)
- [ ] Artifact client (wiggle list-files + download-file)
- [ ] Message tree builder (parent_message_uuid traversal, branch extraction)
- [ ] Git bundle export (JSON format)
- [ ] Unit tests with fixture data (recorded API responses)
- [ ] README with usage examples

**Risk:** Artifact format risk is resolved (wiggle API confirmed). Remaining risk: correlating artifact files to specific messages for accurate version timelines.

### Phase 2: Firefox Extension (Week 2-3)

**Goal:** Working Firefox extension that exports current conversation as a git bundle ZIP.

Deliverables:
- [ ] Extension scaffolding (MV2)
- [ ] Popup UI (conversation info, export options)
- [ ] Content script for conversation detection
- [ ] Background script with SDK integration
- [ ] ZIP export with git-ready directory structure
- [ ] Extension packaging and testing

### Phase 3: CLI + Git Replay (Week 3-4)

**Goal:** CLI tool that replays git bundles into actual git repositories.

Deliverables:
- [ ] `claudesync` CLI (`npx @infinite-room-labs/claudesync-cli`)
- [ ] `claudesync replay <bundle.json> [--output ./repo]` — Creates git repo from bundle
- [ ] `claudesync export <conversation-url> [--format git|json|md]` — Direct export (requires cookie)
- [ ] `claudesync ls` — List conversations
- [ ] npm publishing setup

### Phase 4: Polish + Expansion (Week 4+)

- [ ] Bulk export (all conversations, or by project)
- [ ] MCP server wrapper (expose via MCP for agent access)
- [ ] Watch mode (live-export artifacts as conversation progresses)
- [ ] Diff view in extension popup (show what changed between artifact versions)
- [ ] Chrome extension port

---

## Technical Risks & Mitigations

### Risk: API Changes Breaking the Client

**Severity:** High (it's an undocumented API)  
**Mitigation:** 
- Version-lock API response schemas with Zod validation
- Graceful degradation when fields are missing
- E2E test suite that runs against live API (CI canary)
- Community-maintained endpoint documentation

### Risk: Artifact Format Unknown

**Severity:** ~~Medium~~ **RESOLVED** (2026-03-14)
Artifacts use the "wiggle" filesystem API, not inline text markers. See Artifact Client section. The `list-files` and `download-file` endpoints are straightforward REST calls. No parsing ambiguity remains.

### Risk: No Pagination on Conversation List

**Severity:** Medium (discovered 2026-03-14)
**Details:** The conversation list endpoint returns ALL conversations in a single response (1,375 observed). This works for moderate usage but could cause memory/performance issues for heavy users (10K+ conversations).
**Mitigation:**
- Design the SDK interface to accept pagination parameters even though the API currently ignores them
- Stream-process the response rather than buffering the entire JSON array
- Monitor for API-side pagination changes

### Risk: Rate Limiting / Account Bans

**Severity:** Medium  
**Mitigation:**
- Read-only operations only in POC (no message sending)
- Respectful rate limiting (1 req/sec default)
- Browser User-Agent required (Cloudflare blocks non-browser UAs; custom "ClaudeSync/0.1" is rejected)
- Clear documentation that this is unofficial and use-at-your-own-risk

### Risk: ToS Violation

**Severity:** Low-Medium (Anthropic hasn't aggressively enforced against export tools)  
**Mitigation:**
- MIT license with prominent disclaimer
- Read-only focus (exporting YOUR data)
- No credential storage, no account sharing
- "Your data, your right" framing
- Monitor Anthropic's ToS for changes

---

## Competitive Positioning (for Infinite Room Labs portfolio)

This project demonstrates:

1. **Reverse engineering chops** — Understanding undocumented APIs, building resilient clients
2. **SDK architecture** — Monorepo, TypeScript, clean separation of concerns
3. **Browser extension development** — Firefox MV2/MV3, content scripts, background workers
4. **Novel problem solving** — The artifact→git-commit mapping is genuinely new
5. **Open source leadership** — Community tool, active maintenance, issue triage
6. **DevOps integration thinking** — Git as the universal interchange format

**Marketing angle:** Blog post — *"I built a tool to turn Claude conversations into git repos"* — hits HN/Reddit/dev.to perfectly. Demonstrates the exact kind of creative engineering that attracts consulting clients.

---

## Naming

**ClaudeSync** — Simple, descriptive, memorable. Alternatives considered:
- `claude-git` — too narrow
- `artifactor` — cute but unclear
- `claude-vault` — conflates with HashiCorp
- `conversync` — meh

NPM scope: `@infinite-room-labs/claudesync-core`, `@infinite-room-labs/claudesync-cli`, `@infinite-room-labs/claudesync-firefox-extension`  
GitHub: `infiniteroomlabs/claudesync` (or `wesgilliland/claudesync` for personal, then transfer)  
Domain: claudesync.dev (check availability)

---

## Open Questions

*Questions 1-3, 6, and 8 were answered by the technical spike (2026-03-14). Questions 4, 5, 7, and 9 remain partially open.*

1. **Artifact format in API responses** -- **ANSWERED.** Artifacts are NOT inline in message text. They use the "wiggle" filesystem API with `list-files` and `download-file` endpoints. The `text` field contains only conversational text. See Artifact Client section.

2. **Branch handling** -- **ANSWERED.** Messages form a linked tree via `parent_message_uuid`. The conversation's `current_leaf_message_uuid` identifies the active branch. Full tree reconstruction is possible by following parent links. Git export maps the active branch to `main` and other branches to named git branches.

3. **Project knowledge files** -- **ANSWERED.** Fully accessible via `GET /api/organizations/{org}/projects/{id}/docs` with full text content inline in the `content` field. No separate download step needed. Projects also have a `files` endpoint for uploaded binary files. Both `docs_count` and `files_count` are available on the Project object.

4. **Image artifacts** -- **PARTIALLY ANSWERED.** The wiggle filesystem stores artifacts as files with `content_type` metadata. Image artifacts would appear as files with image content types in `list-files`. The `download-file` endpoint returns raw content, so binary images should be directly downloadable. Needs empirical testing with an actual image artifact.

5. **Streaming responses** -- **NOT TESTED.** Reference implementations confirm SSE streaming via the `/completion` endpoint. The spike focused on read-only endpoints. Still needs investigation for live export use cases.

6. **Full endpoint map** -- **ANSWERED.** ~24 unique endpoints discovered across 6 categories: Bootstrap/Account (3), Organizations (3), Conversations (6 including search), Projects (6), Artifacts/Wiggle (6), File Upload (1). See API Client section for the full table.

7. **Anti-bot measures** -- **ANSWERED (CLI tested 2026-03-14).** Cloudflare performs TLS fingerprinting. Node.js v25 (undici/OpenSSL) passes and returns 200. Bun (BoringSSL) and curl (OpenSSL 3.0.13) are both blocked with 403 "Just a moment..." challenge pages. No `curl_cffi`-style TLS impersonation needed when using Node.js. A full browser User-Agent string is required (any browser works -- Chrome, Firefox, any version). Non-browser UAs like "ClaudeSync/0.1" are rejected by Cloudflare.

8. **Auth evolution** -- **ANSWERED.** Still cookie-based. The session cookie is httpOnly (invisible to JavaScript). Visible cookies include `anthropic-device-id`, `lastActiveOrg`, and `ajs_user_id`. No evidence of token-based auth, PKCE, or OAuth flows. The `cookies.sqlite` approach remains valid.

9. **UA validation** -- **ANSWERED (CLI tested 2026-03-14).** claude.ai does NOT validate User-Agent against the session. Tested with Node.js: Chrome UA (200), Firefox UA (200), Chrome different version (200), custom "ClaudeSync/0.1" UA (403), no UA (403). Cloudflare requires a plausible browser UA but does NOT check consistency with the session cookie. Hardcoding a Chrome UA string is sufficient. The session cookie is named `sessionKey` (httpOnly, 131 chars).

### New Questions (from spike)

10. **Wiggle artifact UUID derivation** -- How does the wiggle filesystem associate artifacts with specific conversation messages? The artifact `created_at` timestamp correlates loosely, but there may be an explicit link (perhaps via the `wiggle_artifact/{id}` UUID). Needs further investigation.

11. **User artifacts endpoints stability** -- The `/user_artifacts` and `/user_artifacts/count` endpoints both returned HTTP 500. Are these new/unstable, or do they require specific parameters? May become useful for cross-conversation artifact listing.

12. **Double-JSON encoding** -- The search endpoint returns double-JSON-encoded responses. Is this intentional or a bug? Need to handle gracefully in the SDK regardless.

---

*Last updated: 2026-03-14*
*Author: Wes Gilleland / Infinite Room Labs LLC*
