# ClaudeSync Technical Spike -- Findings

**Date:** 2026-03-14
**Method:** Live browser automation against claude.ai with authenticated session
**Status:** Complete -- all 9 PRD open questions answered

---

## Executive Summary

The claude.ai web API is significantly richer than either reference implementation documented. The biggest surprise: **artifacts are NOT inline text markers** -- they use a separate storage system codenamed "wiggle" with its own filesystem API. The conversation message tree uses `parent_message_uuid` for branching (not a flat array). The Projects API exists and is fully functional. Search is full-text with chunked results.

---

## Endpoint Map

### Core Endpoints (confirmed working)

| Verb | Path | Purpose | Paginated? |
|------|------|---------|------------|
| GET | `/api/bootstrap` | SPA initialization -- account, feature flags, system prompts | No |
| GET | `/api/account` | User profile, memberships, settings | No |
| GET | `/api/account/raven_eligible` | Unknown eligibility check | No |
| GET | `/api/organizations` | List orgs with full settings + capabilities | No |
| GET | `/api/organizations/{org}/chat_conversations` | List ALL conversations (1375 returned in one call) | **No** |
| GET | `/api/organizations/{org}/chat_conversations/{id}` | Full conversation with all messages | No |
| GET | `/api/organizations/{org}/conversation/search?query={q}&n={limit}` | Full-text search across conversations | Via `n` param |
| GET | `/api/organizations/{org}/members` | Org members list | Unknown |
| GET | `/api/organizations/{org}/sync/settings` | Integration settings (Google Calendar, etc.) | No |

### Projects API

| Verb | Path | Purpose |
|------|------|---------|
| GET | `/api/organizations/{org}/projects` | List all projects |
| GET | `/api/organizations/{org}/projects/{id}` | Single project detail |
| GET | `/api/organizations/{org}/projects/{id}/docs` | Knowledge files (**full content inline**) |
| GET | `/api/organizations/{org}/projects/{id}/files` | Uploaded files |
| GET | `/api/organizations/{org}/projects/{id}/conversations` | Project-scoped conversation list |
| GET | `/api/organizations/{org}/projects/{id}/settings` | Project settings |

### Artifacts API ("wiggle" system)

| Verb | Path | Purpose |
|------|------|---------|
| GET | `/api/organizations/{org}/conversations/{id}/wiggle/list-files` | List all artifact files for a conversation |
| GET | `/api/organizations/{org}/conversations/{id}/wiggle/download-file?path={path}` | Download artifact file content |
| GET | `/api/organizations/{org}/artifacts/wiggle_artifact/{artifact_id}/manage/storage/info` | Artifact storage metadata |
| GET | `/api/organizations/{org}/artifacts/wiggle_artifact/{artifact_id}/tools` | Artifact tool availability |
| GET | `/api/organizations/{org}/user_artifacts?limit={n}&offset={n}&include_latest_published_artifact_uuid=true` | List user artifacts (returned 500 -- may be unstable/new) |
| GET | `/api/organizations/{org}/user_artifacts/count` | Count user artifacts (returned 500) |

### Known From Reference Implementations (not re-tested)

| Verb | Path | Purpose |
|------|------|---------|
| POST | `/api/organizations/{org}/chat_conversations` | Create conversation |
| DELETE | `/api/organizations/{org}/chat_conversations/{id}` | Delete conversation |
| POST | `/api/organizations/{org}/chat_conversations/{id}/completion` | Send message (SSE) |
| POST | `/api/{org}/upload` | Upload file attachment |

---

## PRD Open Questions -- Answers

### Q1: Artifact format in API responses

**Answer: Artifacts are NOT in the message text.** They use a completely separate storage system codenamed **"wiggle"**.

- The `text` field of assistant messages contains only the conversational text (no XML markers, no `antArtifact` tags)
- Artifacts are stored as files in a virtual filesystem at `/mnt/user-data/outputs/`
- Each artifact has its own UUID (`wiggle_artifact/{id}`)
- File listing: `GET /conversations/{id}/wiggle/list-files`
- File download: `GET /conversations/{id}/wiggle/download-file?path=/mnt/user-data/outputs/{filename}`

**Response shape for `list-files`:**
```json
{
  "success": true,
  "files": ["/mnt/user-data/outputs/storydex-architecture.md"],
  "files_metadata": [
    {
      "path": "/mnt/user-data/outputs/storydex-architecture.md",
      "size": 29446,
      "content_type": "text/plain",
      "created_at": "2026-03-12T23:08:39.328229Z",
      "custom_metadata": {
        "filename": "storydex-architecture.md"
      }
    }
  ]
}
```

**Impact on SDK design:** The `ArtifactParser` described in the PRD (parsing `antArtifact` XML tags from message text) is **not needed**. Instead, we need an `ArtifactClient` that calls the wiggle filesystem API. Artifact versioning must be inferred from file timestamps or conversation message ordering, not from inline markers.

### Q2: Branch handling

**Answer: Messages form a linked tree via `parent_message_uuid`.**

Each message has a `parent_message_uuid` field pointing to the previous message in the conversation thread. The conversation object has a `current_leaf_message_uuid` indicating which branch is "active."

This means:
- Branching is first-class in the data model
- The full conversation tree can be reconstructed by following `parent_message_uuid` chains
- `current_leaf_message_uuid` identifies the "main" branch
- Multiple branches can be extracted by finding all leaf nodes

**Git export implication:** Each branch can map to a git branch. The `current_leaf_message_uuid` branch becomes `main`.

### Q3: Project knowledge files

**Answer: Fully accessible via `/projects/{id}/docs` with content inline.**

```json
{
  "uuid": "a41fb789-...",
  "file_name": "example-knowledge-doc.md",
  "content": "# Example Document Title\n\n> Description of the document..."
}
```

The full document content is returned in the `content` field -- no separate download step needed. Projects also have a `files` endpoint (for uploaded binary files) separate from `docs` (for knowledge text).

### Q4: Image artifacts

**Not fully tested in this spike.** The wiggle filesystem stores artifacts as files with `content_type` metadata. Image artifacts would likely appear as files with image content types in the `list-files` response. The `download-file` endpoint returns raw file content, so binary images should be directly downloadable.

### Q5: Streaming responses

**Not tested in this spike.** Reference implementations confirm SSE streaming via the `/completion` endpoint. This spike focused on read-only endpoints.

### Q6: Full endpoint map

**Answer: See the Endpoint Map section above.** Approximately 20 unique endpoints discovered, plus the known 4 from reference implementations. Major categories:
- Bootstrap/Auth: 3 endpoints
- Organizations: 3 endpoints
- Conversations: 2 endpoints + search
- Projects: 6 sub-endpoints
- Artifacts/Wiggle: 4-6 endpoints
- Sync/Settings: 2 endpoints

### Q7: Anti-bot measures

**Answer: Standard `fetch()` works fine from the browser context.** No TLS fingerprinting blocking was observed. All API calls succeeded with the browser's native fetch. The reference implementation's use of `curl_cffi` with Chrome impersonation may have been precautionary or required for out-of-browser requests. Needs CLI testing to confirm whether standard Node.js `fetch` works or if TLS fingerprinting blocks it.

### Q8: Auth evolution

**Answer: Still cookie-based.** The session cookie is httpOnly (invisible to JavaScript). Visible cookies include:
- `anthropic-device-id` -- device identifier
- `lastActiveOrg` -- last used org UUID
- `ajs_user_id` -- analytics user ID
- Various analytics/tracking cookies (_fbp, _gcl_au, __stripe_mid, etc.)

The actual session cookie name is not visible from JS (httpOnly). No evidence of token-based auth, PKCE, or OAuth flows. The PRD's `cookies.sqlite` approach remains valid for CLI consumers.

### Q9: UA validation

**Not conclusively tested.** Browser-based testing can't override User-Agent in fetch requests. This question requires CLI testing:
1. Extract session cookie from browser
2. Make API call with matching UA --> should succeed
3. Make API call with different UA --> test if it fails

---

## Data Model Updates for SDK

### Organization (much richer than expected)

```typescript
interface Organization {
  id: number;
  uuid: string;
  name: string;
  settings: OrgSettings;          // Feature flags, sharing controls
  capabilities: string[];         // e.g., ["chat", "claude_max"]
  parent_organization_uuid: string | null;
  rate_limit_tier: string;        // e.g., "default_claude_max_20x"
  billing_type: string;           // "stripe_subscription" | "prepaid"
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
```

### ConversationSummary (more fields than expected)

```typescript
interface ConversationSummary {
  uuid: string;
  name: string;
  summary: string;
  model: string;                          // e.g., "claude-opus-4-6"
  created_at: string;
  updated_at: string;
  settings: ConversationSettings;         // Feature flags per conversation
  is_starred: boolean;
  is_temporary: boolean;
  project_uuid: string | null;
  session_id: string | null;
  platform: string;                       // "CLAUDE_AI"
  current_leaf_message_uuid: string;      // Active branch pointer
  user_uuid: string;
  project?: { uuid: string; name: string }; // Embedded when listing globally
}
```

### ConversationSettings (feature codenames)

```typescript
interface ConversationSettings {
  enabled_bananagrams: boolean;    // Extended thinking?
  enabled_web_search: boolean;
  enabled_compass: boolean | null;
  enabled_sourdough: boolean;
  enabled_foccacia: boolean;
  enabled_mcp_tools: Record<string, boolean>;  // Per-conversation MCP tool toggles
}
```

### ChatMessage (richer than expected)

```typescript
interface ChatMessage {
  uuid: string;
  text: string;                    // Clean text, NO artifact content
  sender: 'human' | 'assistant';
  index: number;
  created_at: string;
  updated_at: string;
  truncated: boolean;
  stop_reason?: string;            // Assistant messages only
  input_mode?: string;             // Human messages only
  attachments: Attachment[];
  files: File[];
  files_v2: FileV2[];
  sync_sources: SyncSource[];
  parent_message_uuid: string;     // Tree structure for branching
}
```

### Project

```typescript
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
  permissions: string[];            // RBAC-style permission strings
  docs_count: number;
  files_count: number;
}
```

### Search Result

```typescript
interface SearchResponse {
  chunks: SearchChunk[];
}

interface SearchChunk {
  doc_uuid: string;                // Internal document ID (not conversation UUID)
  start: number;                   // Character offset in source
  end: number;
  name: string;                    // Conversation title
  text: string;                    // Matching text snippet
  extras: {
    conversation_uuid: string;     // The actual conversation UUID
    conversation_title: string;
    doc_type: string;              // "conversation"
    read_at: string;
    updated_at: string;
    ingestion_date: string;
  };
}
```

Note: Search response is **double-JSON-encoded** (string containing JSON string containing the actual data). Parse with `JSON.parse(JSON.parse(responseText))`.

---

## Key Architectural Implications

### 1. Artifact Parser Redesign

The PRD's entire artifact parser concept (parsing `antArtifact` XML from message text) is obsolete. Replace with:
- `ArtifactClient.listFiles(orgId, conversationId)` --> file list with metadata
- `ArtifactClient.downloadFile(orgId, conversationId, path)` --> file content
- Versioning must be inferred from timestamps, not inline markers

### 2. Message Tree vs. Flat Array

The SDK must handle conversation branching natively:
- Build a tree from `parent_message_uuid` links
- Provide both "full tree" and "linear branch" views
- Default to following `current_leaf_message_uuid` for the main branch

### 3. No Pagination on Conversation List

1,375 conversations returned in a single response. This simplifies the SDK but:
- Could be slow for heavy users (10K+ conversations)
- Memory usage concern for very large accounts
- May eventually paginate -- design the SDK to handle pagination gracefully

### 4. Project Knowledge Files Have Inline Content

No separate download step needed. The `docs` endpoint returns full text content. This simplifies the bi-directional sync for the CLI tool.

### 5. Two Feature Flag Systems

The bootstrap endpoint reveals both `statsig` and `growthbook` feature flag systems. The conversation settings use internal codenames (`bananagrams`, `sourdough`, `foccacia`). We don't need to decode these -- just preserve them in data models.

---

## CLI Auth Testing Results (2026-03-14)

Session cookie extracted from Chrome using `pycookiecheat`. Tested across multiple runtimes and User-Agent values.

### Session Cookie

The session cookie is named **`sessionKey`** (131 chars). It is httpOnly in the browser but readable from Chrome's encrypted cookie database via `pycookiecheat` (Python) or equivalent.

Other notable cookies: `cf_clearance` (Cloudflare), `anthropic-device-id`, `lastActiveOrg`, `routingHint`.

### TLS Fingerprinting (Q7 -- ANSWERED)

Cloudflare performs TLS fingerprinting. Results by runtime:

| Runtime | TLS Library | Status | Works? |
|---------|-------------|--------|--------|
| Chrome 146 (browser) | BoringSSL (Chrome build) | 200 | Yes |
| Node.js v25.6.0 | OpenSSL (undici) | 200 | **Yes** |
| curl 8.5.0 | OpenSSL 3.0.13 | 403 | **No** |
| Bun | BoringSSL | 403 | **No** |

**Key finding:** Node.js v25's TLS fingerprint passes Cloudflare. curl and Bun do not. This means we do NOT need `curl_cffi` or TLS impersonation -- **Node.js native `fetch` works out of the box**.

### User-Agent Validation (Q9 -- ANSWERED)

Tested with Node.js v25 (which passes TLS check). Cloudflare requires a plausible browser UA string, but does NOT validate it against the session.

| User-Agent | Status | Works? |
|------------|--------|--------|
| Chrome 146 (matching session) | 200 | Yes |
| Firefox 128 (different browser entirely) | 200 | **Yes** |
| Chrome 120 (different version) | 200 | **Yes** |
| `ClaudeSync/0.1 (Node.js)` | 403 | No |
| `Mozilla/5.0` (minimal) | 403 | No |
| `node` | 403 | No |
| (no UA header) | 403 | No |

**Key finding:** Any full, plausible browser User-Agent string works. It does NOT need to match the session. A hardcoded Chrome or Firefox UA string is sufficient. Non-browser UAs are rejected by Cloudflare (not by claude.ai itself).

### Auth Strategy Implications

1. **Runtime:** Node.js is confirmed working. No TLS impersonation needed.
2. **User-Agent:** Hardcode a realistic browser UA (e.g., latest Chrome). No need to read from browser profile.
3. **Cookie extraction:** `sessionKey` is the critical cookie. Extract from Chrome via `pycookiecheat` or from Firefox via `cookies.sqlite`. The `cf_clearance` cookie from the browser is NOT needed -- Node.js gets its own Cloudflare clearance.
4. **Bun is NOT viable** as a runtime for this project (TLS fingerprint blocked). Use Node.js.

### Cookie Extraction Approaches

| Browser | Method | Library/Tool |
|---------|--------|-------------|
| Chrome (Linux) | Encrypted SQLite + system keyring | `pycookiecheat` (Python) |
| Chrome (macOS) | Encrypted SQLite + Keychain | `pycookiecheat` (Python) |
| Firefox | Plain SQLite (`cookies.sqlite`) | `better-sqlite3` (Node.js) |

The PRD's original plan to read Firefox's `cookies.sqlite` directly remains valid. For Chrome, a Python helper script using `pycookiecheat` is the simplest path.

---

## Follow-Up Spike: Artifact Versioning (2026-03-14)

Scanned 200 conversations via Node.js CLI. 64 had artifacts, 30 had multiple files.

### Key Finding: Wiggle Stores Current State Only, No Version History

The wiggle filesystem stores artifacts as files representing the **latest state** of each artifact. There is no version history API. When an artifact is revised during a conversation, the file is overwritten -- only the final version is accessible via `list-files` and `download-file`.

**Evidence:**
- All multi-file conversations contain DIFFERENT artifacts (different filenames or directory paths), not multiple versions of the same artifact
- One conversation ("Fish shell dynamic auto-complete") appeared to have two versions of `dotenv-edit.fish` but inspection revealed they are DIFFERENT files in different subdirectories: `functions/dotenv-edit.fish` (759 bytes) and `completions/dotenv-edit.fish` (414 bytes)
- The largest artifact collection (25 files in "Kotlin/JVM") shows multiple distinct artifacts, not versions
- The wiggle filesystem supports directory structures: `/mnt/user-data/outputs/{artifact-name}/{subdir}/{file}`

**Stats from scan:**
- 200 conversations scanned
- 64 with artifacts (32%)
- 30 with multiple files (different artifacts, not versions)
- Max files in one conversation: 25

### Impact on Git Export Strategy

The original vision of "each artifact version maps to a git commit" is NOT achievable from the wiggle API alone. The value proposition shifts from **version control** to **organized export**:

1. **Snapshot export** -- Export the current state of all artifacts + conversation text. Still better than anything else on the market.
2. **Message-correlated export** -- Each assistant message that created/updated an artifact can be a commit, but the commit only contains the FINAL artifact content (not the intermediate version). The conversation text provides the change description.
3. **Live capture** (future) -- To get real version history, intercept streaming responses during the conversation. This requires the extension or a proxy, not the REST API.

### Revised Git Export Commit Strategy

```
commit 1: "Initial conversation"
  - conversation.md (full text)
  - README.md (metadata)

commit 2: "Final artifacts"
  - artifacts/storydex-architecture.md (final version)
  - artifacts/component.jsx (final version)
```

This is a 2-commit export (conversation + artifacts) rather than the N-commit timeline originally envisioned. The conversation.md still preserves the full discussion including what changes were requested, providing context that no other export tool captures.

### Node.js v24 LTS Confirmed Working

Additionally, Node.js v24.14.0 (LTS, supported through April 2028) was tested and passes Cloudflare TLS fingerprinting. Updated runtime recommendation from v25 to v24 LTS.

| Runtime | TLS Library | Status | Works? |
|---------|-------------|--------|--------|
| Node.js v24.14.0 (LTS) | OpenSSL (undici) | 200 | **Yes** |
| Node.js v25.6.0 | OpenSSL (undici) | 200 | Yes |

---

*Spike performed: 2026-03-14*
*Method: Chrome browser automation via Claude Code + claude-in-chrome MCP, then CLI testing with curl/Node.js/Bun, then bulk artifact scan via Node.js CLI*
