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

## Related Ideas (ideas repo)

- **Idea 099 -- Atomic, auditable, idempotent, transactional core actions**: every claudesync action (export, write, git-commit, sync) should either fully complete or cleanly roll back (atomic/transactional), leave an auditable trail of exactly what changed, and be a no-op on unchanged inputs (idempotent). Captured at `../ideas/ideas/099-claudesync-atomic-auditable-idempotent-transactional-core-actions.md` (InfiniteRoomLabs/ideas, idea 099).

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
- **Run `nvm use` before any Node work** (node/pnpm/vitest/tsc/build/scripts). This repo pins Node 24 via `.nvmrc`, but the agent's non-interactive Bash shell defaults to system Node v20 -- `BASH_ENV`/direnv autoswitching does not stick because the harness re-pins `PATH` after startup. So prefix node commands in a compound, e.g. `nvm use && pnpm test`. (Interactive fish auto-switches; this note is for the agent.)
- Use `pnpm` for package management
- ESM modules (`"type": "module"`)
- Strict TypeScript (`strict: true`, no `any`)
- Module resolution: `NodeNext` (requires `.js` extensions on imports)
- Zod schemas for all API response types
- Tests with Vitest using synthetic fixtures (no real PII)

### Documentation (TSDoc) -- MANDATORY
**Full TSDoc coverage on every TypeScript declaration we write, down to the smallest
detail -- matching the standard already set in `packages/core/src`.** This applies to
you AND any subagents you dispatch; pass this requirement into their prompts.

- A `/** */` on EVERY declaration AND every member: interfaces/types/classes/
  functions/enums/consts, and each field/method/enum-member/parameter-bag property
  gets its own comment. No undocumented exports, and no undocumented internals either.
- TSDoc, not classic JSDoc: NO `{Type}` annotations (the signature has the type), NO
  `@property`/`@interface`/`@typedef`/`@extends`. Use `@param name - desc`, `@returns`,
  `@throws`, and `{@link Symbol}` cross-references.
- Lead with substance (what it IS + any non-obvious invariant), not filler. Document
  WHY where the code does not say it.
- New code is not "done" until its TSDoc is complete; treat missing or low-quality docs as a
  failing review. The `/tsdoc` skill (agency:tsdoc) is the canonical reference.

### Security
- Never commit `.env` files or session cookies
- Clear `CLAUDE_AI_COOKIE` from `process.env` after reading
- Validate artifact paths; use `path.basename()` for local file writes
- MCP server: stdio transport only (network transport is unsafe without auth)

### Cookie harvesting
Host-side only -- the container can't reach the OS keychain. A shared broker
(`scripts/lib/harvest-cookie.sh`, `Harvest-Cookie.ps1`) shells out to the pinned
MIT `rookie` CLI (auto-downloaded, SHA256-verified) to read the `claude.ai`
`sessionKey` from browsers, then passes it via `CLAUDE_AI_COOKIE`. Installers
ship the broker into the Docker image and extract it (local repo -> image ->
GitHub fallback). Windows Chrome >= 127 (App-Bound Encryption) is unsupported ->
Firefox/manual. See `docs/cookie-harvesting.md` and `docs/claude-desktop-linux.md`.

### File Encoding
**UTF-8 only.** No smart quotes, em dashes, or Office characters.

### Git Discipline
- Imperative mood commit messages
- Never rewrite shared branch history
- Never commit secrets or credentials

## Cutting a Release

Docker images and npm packages are published **only on a `v*` git tag** -- pushing
`main` runs CI (lint/test) but never publishes. `.github/workflows/publish-docker.yml`
and `publish-npm.yml` both trigger on `push: tags: "v*"`.

To release:

1. Bump the version in all three packages to the same value:
   `packages/core/package.json`, `packages/cli/package.json`,
   `packages/mcp-server/package.json`. (Internal deps use `workspace:*`, which
   pnpm resolves to the real version at publish -- no dep-range edits needed.)
2. `nvm use && pnpm install` (the global hardening enforces deps-before-run), then
   `pnpm build && pnpm test` to de-risk the publish.
3. Add a `## [X.Y.Z]` entry to `CHANGELOG.md`.
4. Commit, then tag: `git tag vX.Y.Z`.
5. **Push the tag to the `github` remote** (not just `origin`/Gitea -- GitHub
   Actions only fire on the github remote): `git push github main && git push github vX.Y.Z`.

The tag build produces images tagged `X.Y.Z`, `X.Y`, `X`, `latest`, and the commit
sha, on both ghcr.io and Docker Hub, with the host-side wrapper scripts baked into
`/opt/claudesync/host/`. npm publishes via OIDC trusted publishing (no token).

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
