# Changelog

All notable changes to this project will be documented in this file.

## [0.2.1] - 2026-03-15

### Added
- `@infinite-room-labs/claudesync-core` SDK with Zod schemas, auth module, HTTP client, message tree utilities (44 tests passing)
- `@infinite-room-labs/claudesync-mcp-server` with 4 MCP tools: list_organizations, list_conversations, get_conversation, search_conversations
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

### Added (TUI)
- Interactive terminal browser: run `claudesync` with no subcommand to launch
- Miller Columns (Finder-style) navigation: 3-column drill-down through orgs > conversations > details
- Vim keybinds: h/j/k/l for navigation, / for search, e for export, q to quit
- Detail pane shows conversation metadata (model, dates, starred, project)
- Search overlay filters current column items
- Built with React + Ink (terminal React renderer)

### Added (CLI)
- `--query` flag on all commands with `--json` output (JMESPath filtering, AWS CLI style)
  - `claudesync ls --query "[].{uuid: uuid, name: name}"`
  - `claudesync projects list --query "[].name"`
  - `claudesync search kotlin --query "chunks[].extras.conversation_uuid"`
  - `--query` implies `--json` automatically

### Improved
- `claudesync projects list` now shows UUIDs for easy copy-paste into `projects export`
- `claudesync ls` and `projects list` show export hint at the bottom

### Added (Project Export)
- `claudesync projects export <project-id>` -- exports entire project as git repo
  - Knowledge docs in `knowledge/`, conversations in `conversations/{slug}/`
  - Each conversation includes conversation.md, README.md, and artifacts/
  - Supports `--skip-artifacts` for faster export, `--format json` for GitBundle output
- `claudesync projects list` (default subcommand, same as before)
- `ClaudeSyncClient.getProjectConversations()` method added to core SDK

### Added (Installer Scripts)
- `scripts/install.sh` -- pipe-to-shell installer (bash, zsh, fish)
  - Auto-reads Firefox cookie via sqlite3 (standard, Snap, Flatpak, macOS paths)
  - Fallback chain: CLAUDE_AI_COOKIE env var > Firefox > Chrome (macOS) > manual paste
  - Runtime dependency checks with OS-specific install guidance
- `scripts/install.ps1` -- PowerShell installer (Windows)
  - Chrome DPAPI decryption (native, no external deps) tried first
  - Firefox fallback, then manual paste instructions
  - Works on both PowerShell 5.1 and 7+
- `scripts/install-mcp.sh` -- MCP server config for Claude Code / Desktop / .mcp.json (Unix)
- `scripts/install-mcp.ps1` -- MCP server config (Windows/PowerShell)
- `scripts/uninstall.sh` -- Unix uninstaller (removes function, wrapper, optionally Docker images)
- `scripts/uninstall.ps1` -- Windows uninstaller (removes function, wrapper, PATH entry, optionally Docker images)
- All scripts support `--force` / `-f` to skip interactive prompts (upgrade scenarios)
- All scripts prompt interactively before replacing existing installations
- README.md with full usage documentation, install instructions, and architecture overview

### Added (Infrastructure)
- Docker Hub repositories: `deathnerd/claudesync-mcp` (MCP server) and `deathnerd/claudesync` (CLI)
- Dockerfile supports two targets: `--target mcp` and `--target cli`
- CLI container includes git for `exportToGit()`, runs as UID 1000 (host-compatible)
- Release pipeline pushes to both Docker Hub and ghcr.io

### Added (Phase 3)
- `claudesync` CLI tool with 4 commands: `ls`, `export`, `projects`, `search`
- `claudesync export <id>` creates a git repo from a conversation with artifacts
- `FirefoxProfileAuth`: reads session cookies from Firefox's cookies.sqlite (supports standard, Snap, Flatpak paths)
- CLI supports `--json` output, `--starred` filter, configurable git author

### Added (Phase 2)
- Git export engine: `exportToGit()` creates real git repos from conversations using `isomorphic-git`
- `GitBundle` JSON format: intermediate representation for environments without git
- `buildGitBundle()`: converts conversation + artifacts into a structured commit plan
- `formatConversation()`: renders message threads as markdown
- MCP tools: `list_projects`, `get_project_docs`, `list_artifacts`, `download_artifact`
- Live-tested: successfully exported a conversation with artifacts to a 2-commit git repo

### Fixed
- CI pipeline: merged typecheck into build job (CLI depends on core's compiled output)
- Interactive prompts read from `/dev/tty` so `curl | sh` pipe-to-shell works correctly
- Dockerfile CLI target: WORKDIR changed to /data so exports write to mounted volume, not /app
- Dockerfile: add `--legacy` flag to `pnpm deploy` for pnpm v10 compatibility
- Docker image builds and runs successfully (385MB, node:24-slim)

### Added (Shell Completions)
- `scripts/completions/claudesync.bash` -- Bash completion for subcommands and flags
- `scripts/completions/claudesync.zsh` -- Zsh completion with _arguments style
- `scripts/completions/claudesync.fish` -- Fish completion with subcommand gating
- PowerShell completion via Register-ArgumentCompleter (embedded in install.ps1)
- All installers auto-install completions; uninstallers clean them up
- Zod schemas now accept `null` for `current_leaf_message_uuid`, `enabled_web_search`, `enabled_mcp_tools`, `docs_count`, `files_count` (discovered via live API testing against 1,375 conversations)

### Security
- Release pipeline uses OIDC trusted publishing (no long-lived NPM_TOKEN)
- Packages renamed from `@claudesync/*` to `@infinite-room-labs/*`
- Split release.yml into `publish-npm.yml` and `publish-docker.yml` (independent failure domains)
- Docker publish builds both MCP and CLI targets in parallel via matrix strategy

### Changed
- PRD updated to v0.3.0 with all spike findings and confirmed data models
- Implementation plan rewritten: Bun replaced with Node.js v24 LTS / pnpm / Vitest
- Phase reorder: MCP server first (Phase 1), extension deferred (Phase 4)
- `tsconfig.base.json`: `moduleResolution` changed from `bundler` to `NodeNext`
- `@infinite-room-labs/claudesync-core` package.json: added `build` script, `exports` pointing to `dist/`
- `@infinite-room-labs/claudesync-mcp-server` package.json: added `build` script, `bin` pointing to `dist/`
- Root `package.json`: `engines.node` changed to `>=24.0.0`, added `engines.pnpm`
- `.gitignore`: added `.env`, `node_modules/`, `dist/`, coverage, IDE files
- `CLAUDE.md`: updated to reflect completed spike and Phase 1 status
- Monorepo design doc: updated endpoints, data models, auth findings, deferred scope
