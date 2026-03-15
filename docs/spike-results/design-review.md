# ClaudeSync Design Review -- Consolidated Report

**Date:** 2026-03-14
**Reviewers:** Backend Architect, DevOps Manager, Security Lead, CTO
**Verdict:** **GO** -- with scope adjustments and pre-build fixes

---

## Strategic Assessment (CTO)

**Recommendation: GO.** Ship the MCP server as v0.1 within two weeks.

The project is sound, strategically positioned, and the spike de-risked the biggest unknowns. The core value proposition is intact. However:

1. **Reorder phases:** MCP server first (not extension). Fastest path to usable product, validates SDK without UI complexity, larger immediate audience.
2. **Ship fast.** The API instability is existential -- Anthropic could lock down access at any time. Every week of polish is a week the window might close.
3. **Implementation plan is stale** -- still references Bun throughout. Must be rewritten before engineering starts.

---

## Critical Findings (must fix before building)

### 1. `.gitignore` is incomplete (Security)
**Severity: CRITICAL-BEFORE-BUILD**
No `.env`, `node_modules/`, or `dist/` exclusions. The session cookie will live in `.env` -- this must never reach git.
**Fix:** Add exclusions immediately, before any auth code is written.

### 2. Artifact-to-message correlation is unsolved (Architecture)
**Severity: HIGH**
The git export engine depends on mapping artifact files to specific messages. The wiggle API gives timestamps but no explicit message link. If wiggle only stores the latest version (likely), "versioning" degrades to "snapshot."
**Fix:** Run a targeted follow-up spike before designing the git export engine. Create a conversation with known artifact revisions, inspect the wiggle response.

### 3. `listConversations` interface is wrong for scale (Architecture)
**Severity: HIGH**
Returns `Promise<ConversationSummary[]>` but the API dumps 1,375+ conversations in one call. For heavy users this is 50-100MB unbuffered.
**Fix:** Change to `AsyncIterable<ConversationSummary>` or add a convenience `listConversationsAll()`. CTO disagrees this is urgent (200-400KB for 1,375 convos is fine) -- resolve based on actual usage.

### 4. Bun references in implementation plan (Documentation)
**Severity: HIGH**
`docs/plans/2026-03-10-claudesync-implementation.md` has 20+ Bun references. Engineers will scaffold Bun and discover nothing works.
**Fix:** Rewrite implementation plan for Node.js/pnpm/Vitest before any engineering starts.

---

## Warnings (fix before first release)

### Architecture & SDK

| # | Finding | Reviewer | Fix |
|---|---------|----------|-----|
| 5 | Rate limit response shape unconfirmed; no retry/backoff policy | Backend + Security | Add configurable delay (300ms default) + honor `resets_at` on 429 |
| 6 | Search double-JSON-parse is brittle | Backend | Use defensive parser: `typeof firstPass === 'string' ? JSON.parse(firstPass) : firstPass` |
| 7 | `ConversationSettings` codenames (`bananagrams`, `sourdough`) are unstable | Backend | Use `.passthrough()` on settings object, extract only known stable fields |
| 8 | `downloadArtifact` returns `string` -- no binary support | Backend | Return `string \| Uint8Array` or `Response` for image artifacts |
| 9 | `ExtensionAuth` httpOnly constraint undocumented | Backend | Document that `sessionKey` is only accessible to background scripts, not content scripts |

### Security

| # | Finding | Fix |
|---|---------|-----|
| 10 | `extract-cookie.ts` prints session cookie to stdout (shell history risk) | Write to `.env` file or clipboard, not stdout. Gate stdout behind `--stdout` flag |
| 11 | `FirefoxProfileAuth` reads live browser DB without SQLite WAL safety | Use `immutable=1` URI flag; scope query to `sessionKey` only; close connection immediately |
| 12 | `CLAUDE_AI_COOKIE` visible in `/proc/<pid>/environ` and `docker inspect` | `delete process.env.CLAUDE_AI_COOKIE` after reading; document Docker secrets usage |
| 13 | `downloadArtifact` path is unvalidated -- path traversal risk on export | Validate API paths match `/mnt/user-data/outputs/*`; use `path.basename()` for local writes |
| 14 | PII in spike findings doc and potential test fixtures | Sanitize `findings.md`; create synthetic fixture data, never commit real API responses |

### DevOps & Build

| # | Finding | Fix |
|---|---------|-----|
| 15 | No `build` script in `@claudesync/core` | Add `tsc -p tsconfig.json`; core's exports point at `./src/index.ts` (won't work in Docker/npm) |
| 16 | `bin` in mcp-server points at TypeScript source | Change to `./dist/index.js` before publishing |
| 17 | `moduleResolution: bundler` won't work with plain `tsc` | Change to `NodeNext` with `"module": "NodeNext"` -- requires `.js` extensions on imports |
| 18 | Node.js v25 is not LTS (odd release) | Test v24 LTS against claude.ai; use v24 if TLS check passes |
| 19 | `better-sqlite3` native module needs build toolchain in Docker | Use `node:25-slim` (not alpine); install `python3 make g++` in deps stage |

---

## Recommendations Summary

### Phase Reorder (CTO recommendation)

| Phase | Original | Proposed |
|-------|----------|----------|
| 1 | SDK + Artifact Parser | **SDK + MCP Server** (3 tools: list_orgs, list_convos, get_convo) |
| 2 | Firefox Extension | **Artifact Client + Git Export Design** (wiggle API + versioning spike) |
| 3 | CLI + Git Replay | **CLI** (export, replay, ls) + Firefox profile auth |
| 4 | Polish | **Extension** (only if artifact versioning question answered) |

### Cut from v1

- Conversation branching in git export (follow `current_leaf_message_uuid` only)
- Watch mode / live export (requires SSE streaming, untested)
- Chrome extension port
- Bulk export (single conversation is the v1 unit)
- `FirefoxProfileAuth` in Phase 1 (`EnvAuth` is sufficient for MCP + CLI)

### Build vs Buy (CTO)

| Component | Recommendation |
|-----------|---------------|
| Git operations | `isomorphic-git` (pure JS, works in browser + Node) |
| HTTP client | Native `fetch` (confirmed working) |
| SQLite reading | `better-sqlite3` (standard Node.js choice) |
| ZIP creation | `archiver` or `JSZip` |
| CLI framework | `commander` or `citty` |
| MCP server | `@modelcontextprotocol/sdk` |

### Dockerfile (DevOps)

Three-stage build: **deps** (install + native compile) -> **builder** (tsc) -> **runtime** (slim, production only). Use `node:25-slim` (not alpine -- `better-sqlite3` needs glibc). Only containerize `@claudesync/mcp-server`.

### CI Pipeline (DevOps)

Two workflow files:
- **`ci.yml`**: install -> [typecheck + lint + test in parallel] -> build (all branches/PRs)
- **`release.yml`**: build -> docker push -> npm publish (tags only)

Use Changesets for coordinated versioning across packages.

---

## Strengths Noted by Reviewers

1. **Spike-first discipline** -- invalidated wrong assumptions before building (all reviewers)
2. **Three-layer SDK architecture** -- correct decomposition, testable in isolation (Backend, CTO)
3. **Zod with `.passthrough()`** -- right validation strategy for undocumented API (Backend)
4. **Message tree design** -- `parent_message_uuid` is first-class with clean API (Backend)
5. **`AuthProvider` interface** -- extensible, clean abstraction (Backend, CTO)
6. **GitBundle as IR** -- enables extension export without git access (Backend)
7. **Strategic positioning** -- OSS credibility + content marketing + ecosystem wedge (CTO)

---

## Decisions Needed from Chairman

1. **Confirm phase reorder** -- MCP server first, extension later?
2. **Approve artifact versioning follow-up spike** -- half-day investigation before git export design?
3. **`listConversations` interface** -- `AsyncIterable` (Backend's recommendation) or `Promise<T[]>` (CTO says it's fine)?
4. **Node.js version** -- test v24 LTS first, or commit to v25?
5. **Rewrite implementation plan** -- do it now or delegate to first sprint task?

---

*Generated from 4 parallel agent reviews on 2026-03-14*
