# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- `@claudesync/core` SDK with Zod schemas, auth module, HTTP client, message tree utilities (44 tests passing)
- `@claudesync/mcp-server` with 4 MCP tools: list_organizations, list_conversations, get_conversation, search_conversations
- Zod schemas for 12 API response types with `.passthrough()` for forward compatibility
- `EnvAuth` with security hardening (clears cookie from process.env after reading)
- `ClaudeSyncClient` with configurable rate limiting (300ms default), defensive search double-parse
- Message tree utilities: `buildMessageTree()`, `getLinearBranch()`, `findLeafMessages()`
- `downloadArtifact()` with path traversal protection and binary content support
- Technical spike: mapped 24 claude.ai API endpoints across 6 categories
- Discovered "wiggle" artifact filesystem API (artifacts are NOT inline XML)
- Documented message tree structure via `parent_message_uuid` branching
- CLI auth testing: confirmed Node.js v24 LTS passes Cloudflare TLS fingerprinting
- Answered all 9 PRD open questions (auth, UA validation, search, artifacts, projects)
- Design review from 4 specialist agents (architecture, devops, security, CTO)
- Dockerfile: 3-stage multi-stage build with `node:24-slim` for MCP server
- CI pipeline: `.github/workflows/ci.yml` (typecheck, lint, test, build)
- Release pipeline: `.github/workflows/release.yml` (docker push + npm publish)
- `.dockerignore` for lean Docker builds
- Spike results documentation (`docs/spike-results/findings.md`)
- Consolidated design review (`docs/spike-results/design-review.md`)
- Sprint architecture and task documents

### Changed
- PRD updated to v0.3.0 with all spike findings and confirmed data models
- Implementation plan rewritten: Bun replaced with Node.js v24 LTS / pnpm / Vitest
- Phase reorder: MCP server first (Phase 1), extension deferred (Phase 4)
- `tsconfig.base.json`: `moduleResolution` changed from `bundler` to `NodeNext`
- `@claudesync/core` package.json: added `build` script, `exports` pointing to `dist/`
- `@claudesync/mcp-server` package.json: added `build` script, `bin` pointing to `dist/`
- Root `package.json`: `engines.node` changed to `>=24.0.0`, added `engines.pnpm`
- `.gitignore`: added `.env`, `node_modules/`, `dist/`, coverage, IDE files
- `CLAUDE.md`: updated to reflect completed spike and Phase 1 status
- Monorepo design doc: updated endpoints, data models, auth findings, deferred scope
