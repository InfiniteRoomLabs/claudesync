# CLAUDE.md -- ClaudeSync

## What This Is

ClaudeSync is a TypeScript/Node.js SDK wrapping the undocumented claude.ai web API, enabling programmatic access to conversations, artifacts, and projects. First consumer: an MCP server exposing conversation data to Claude Code and other MCP clients. Future consumers: CLI for export/sync, Firefox extension for in-browser export.

**Philosophy:** yt-dlp energy. Unofficial, community tool, your-data-is-yours. MIT licensed.

## Key Documents

- `docs/PRD.md` -- Full product requirements document (v0.3.0, updated with spike findings)
- `docs/plans/2026-03-10-claudesync-implementation.md` -- Implementation plan
- `docs/plans/2026-03-10-claudesync-monorepo-design.md` -- Monorepo architecture decisions
- `docs/spike-results/findings.md` -- Technical spike results (API shapes, auth, artifacts)
- `docs/spike-results/design-review.md` -- Consolidated design review from 4 specialist agents

**Read `docs/PRD.md` first.** Then `docs/spike-results/findings.md` for ground-truth API data.

## Architecture

Three-layer design:

```
Consumers (thin shells): MCP Server | CLI | Firefox Extension
                              |        |        |
Core SDK:              @infinite-room-labs/claudesync-core (TypeScript)
                       Auth | API Client | Artifact Client | Git Export
                              |
Transport:             claude.ai Web API (undocumented, cookie auth)
```

Monorepo using pnpm workspaces:
- `packages/core/` -- The SDK (`@infinite-room-labs/claudesync-core`)
- `packages/mcp-server/` -- MCP server (`@infinite-room-labs/claudesync-mcp-server`)
- `packages/cli/` -- CLI tool (`@infinite-room-labs/claudesync-cli`) -- stub
- `packages/extension/` -- Firefox extension -- future

## Current Phase: Implementation (Phase 1)

Technical spike is complete. All 9 PRD open questions answered. Key findings:
- Artifacts use "wiggle" filesystem (NOT inline XML) -- separate list/download API
- Messages form a tree via `parent_message_uuid` (NOT a flat array)
- Wiggle stores latest version only -- no version history
- Node.js v24 LTS passes Cloudflare TLS; Bun and curl are blocked
- Session cookie is `sessionKey` (httpOnly); any browser UA string works

Phase 1 deliverables: Core SDK + MCP Server (3 tools: list_orgs, list_convos, get_convo).

## Tech Stack

- Node.js v24 LTS (required -- Bun blocked by Cloudflare TLS fingerprinting)
- TypeScript (strict mode, ESM, NodeNext module resolution)
- pnpm (package management + workspaces)
- Zod (API response validation with `.passthrough()` for forward compat)
- Vitest (testing)
- better-sqlite3 (Firefox cookie reading)
- @modelcontextprotocol/sdk (MCP server)

## Conventions

### Node/TypeScript
- Use `pnpm` for package management
- ESM modules (`"type": "module"`)
- Strict TypeScript (`strict: true`, no `any`)
- Module resolution: `NodeNext` (requires `.js` extensions on imports)
- Zod schemas for all API response types
- Tests with Vitest using synthetic fixtures (no real PII)

### Security
- Never commit `.env` files or session cookies
- Clear `CLAUDE_AI_COOKIE` from `process.env` after reading
- Validate artifact paths; use `path.basename()` for local file writes
- MCP server: stdio transport only (network transport is unsafe without auth)

### File Encoding
**UTF-8 only.** No smart quotes, em dashes, or Office characters.

### Git Discipline
- Imperative mood commit messages
- Never rewrite shared branch history
- Never commit secrets or credentials

## Spec Kitty

This repo uses Spec Kitty for structured development.

### Workflow Phases
`specify` -> `plan` -> `tasks` -> `implement` -> `review` -> `accept` -> `merge`

Each phase has a corresponding `/spec-kitty.{phase}` command.

## Agent Marketplace

This project uses the IRL private marketplace:
```
/plugin install agency@infinite-room-labs
```
