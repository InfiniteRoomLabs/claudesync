# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Installer could silently write a broken shell wrapper with an empty image ref.** `resolve_ref` failures inside command substitution could not abort the installer (`die` in `$()` only exits the subshell), so a transient registry error produced a wrapper whose `docker run` had no image. Both install paths now hard-fail with a clear re-run message instead. Caught by dogfooding the 0.10.1 wrapper upgrade.

## [0.10.1] - 2026-07-17

### Fixed
- **`claudesync --version` reported a stale hardcoded version** (stuck at 0.8.0 since that release). The CLI now reads its version from `package.json` at startup, so it can never drift from the published version again. Caught by dogfooding the 0.10.0 wrapper upgrade.

## [0.10.0] - 2026-07-16

### Added
- **Project memory PUSH (Phase 2).** New SDK write `putProjectMemoryControls`
  (90 s timeout, no retry -- a retry could double-apply or stack two ~57 s
  server-side regenerations) and `getAccount`, a three-way controls merge, and
  a push planner/apply engine that merges local `edits.md` against a fresh
  remote read before every `PUT` (never a blind whole-array replace), verifies
  the write with a follow-up read after it lands (hybrid post-PUT verify:
  materializes on a confirmed match, preserves `edits.md` and the merge base
  on a mismatch so nothing is silently lost), and holds a per-project advisory
  lock for the duration so a user re-running a push that looks stuck cannot
  race itself. New CLI `projects memory push`, `edits clear`, and
  `--adopt-legacy-principal`; a gated MCP `put_project_memory_controls` tool
  (only registered when launched with
  `CLAUDESYNC_MCP_WRITE_SCOPE=project-memory`). All project-memory commands
  (`pull`, `status`, `push`) now derive their principal from the account uuid
  (via a new `getAccount` read), replacing the org-scoped principal from
  Phase 1. See
  `docs/superpowers/specs/2026-07-13-project-memory-sync-design.md`.
- **Project memory pull (Phase 1).** New SDK `getProjectMemory` read, a
  `packages/core/src/memory/` module (canonicalization, `edits.md`
  serialization, hash sidecar, idempotent + atomic pull engine with a full
  clean/dirty/conflict decision table and a principal-fingerprint guard), CLI
  `projects memory show|pull|status`, and a read-only `get_project_memory` MCP
  tool. Pull materializes `memory/MEMORY.md` (server-generated doc) +
  `memory/edits.md` (the `controls` list) + an owner-only hash sidecar; local
  hand-edits are never silently overwritten (reported as conflicts). Read-only;
  no writes to claude.ai (Phase 2 adds push). See
  `docs/superpowers/specs/2026-07-13-project-memory-sync-design.md`.

### Documentation
- **Added the Phase 1 (pull) implementation plan** for project memory
  (`docs/superpowers/plans/2026-07-13-memory-pull-phase1.md`): task-by-task TDD
  plan for `getProjectMemory` + a `packages/core/src/memory/` module + CLI
  `projects memory show|pull|status` + a read-only MCP tool. Plan only.
- **Ran the project-memory endpoint discovery spike (Phase 0)** and revised the
  design accordingly. Findings in `docs/spike-results/memory-findings.md`: edits
  are a single `controls` string array (no per-entry IDs), the only write is a
  whole-array `PUT .../memory/controls` that regenerates the doc synchronously
  (~57 s), and the memory doc is GET-only. This collapsed the push model from a
  per-edit resumable saga to one merge-before-PUT call and removed the direct-edit
  phase. Spec and spike plan updated (`docs/superpowers/`). Docs only.
- **Added the project-memory sync design spec**
  (`docs/superpowers/specs/2026-07-13-project-memory-sync-design.md`):
  bidirectional sync for the new claude.ai per-project memory feature (pull the
  server-generated memory doc, push only the user-authored edits list via an
  outbox + compare-and-delete saga, explicit regenerate, opt-in export,
  principal-fingerprint privacy guard). Produced by two independent plans
  (Claude + Codex) reconciled and cross-reviewed. Design only; not yet
  implemented.
- **Full TSDoc coverage across the core SDK** (`packages/core/src`, 51 files).
  Every declaration and member -- exported and internal -- now carries a TSDoc
  comment (no `{type}` annotations, per-member docs, `{@link}` cross-references),
  converting the JetBrains-generated JSDoc and filling all gaps. Docs only; no
  code, type, or behavior change. The convention is now mandated in `CLAUDE.md`.
- **Added two design specs under `docs/superpowers/specs/`**: write-back sync
  (push local project knowledge to claude.ai, with 3-way conflict detection and a
  per-level audit journal) and atomic/auditable/idempotent transactional core
  actions (idea 099, the foundational reliability layer the former builds on).
  Design only; not yet implemented.
- **Added a Related Ideas pointer in `CLAUDE.md`** to IRL ideas-repo idea 099 (atomic, auditable, idempotent, transactional core actions) -- an agent-facing roadmap breadcrumb; no code change.

### Changed
- **Tests relocated from co-located `src/**/__tests__/` to a per-package
  `test/` directory** (`packages/core/test/`, mirroring the source tree). Vitest
  `include` globs and the `tsconfig` `exclude` updated to match; no test behavior
  changed (27 files, 200 tests still green).
- **Added the `@core/*` -> `src/*` path alias** for test imports (vitest
  `resolve.alias` + `tsconfig` `paths`), replacing deep `../../src/...` relative
  paths. Cross-package imports continue to use the workspace package name.
- **Committed curated IntelliJ project config** (`.idea/claudesync.iml`,
  `modules.xml`, `misc.xml`, `vcs.xml`) so source/test roots auto-apply on clone;
  `.gitignore` now tracks only those files and ignores the rest of `.idea/`.

## [0.9.2] - 2026-06-17

### Fixed
- **`downloadArtifact` mislabeled text artifacts as binary.** The wiggle
  `download-file` endpoint serves text files (e.g. `.md`, `.json`) with
  `application/octet-stream`, so the content-type prefix check returned a
  `Uint8Array` and the MCP server's `download_artifact` rendered valid UTF-8
  markdown as `[Binary content: N bytes]` -- making `.md`/`.json` artifacts
  unreadable through the SDK and MCP. `downloadArtifact` now decides text vs
  binary by an explicit text content-type, OR a known text file extension, OR a
  successful strict UTF-8 decode; only genuinely binary content (images,
  archives, non-UTF-8 bytes) is returned as a `Uint8Array`.

## [0.9.1] - 2026-06-12

### Fixed
- **Slug collisions silently overwrote same-named conversations** (data loss).
  `safeSlug` discarded the uuid for any non-empty name, so two conversations
  titled the same mapped to one directory and the last sync clobbered the
  rest -- and because they shared one `.claudesync-state.json`, `--skip-same`
  never matched, so colliding conversations re-synced every run. `export-all`
  now disambiguates per directory namespace (standalone convs, projects,
  per-project convs) via `disambiguateSlugs`: any slug shared by >1 uuid gets
  every member suffixed with its uuid head (`casual-greeting-099ff180`);
  unique slugs stay bare, so non-colliding directories are untouched.
  Note: the separate `projects` subcommand (`projects.ts`) still has a
  hand-rolled slugify with the same latent bug -- not in the `export-all`
  path, left for a follow-up.

## [0.9.0] - 2026-06-01

### Changed
- Setup scripts (`claudesync-setup.sh`, `claudesync-setup.ps1`): extracted
  inline function bodies to standalone template files in `scripts/lib/`.
  Broker path now resolved at runtime; only the image ref (`__REF__`) is
  substituted at install time.
- Added doc comments to every function in both setup scripts.
- MCP wrapper names its container `claudesync-mcp-{project}` (first 10 chars
  of the working directory basename, non-alphanumeric chars replaced with `-`).

## [0.8.0] - 2026-05-28

### Added
- Parallel `export-all` with an adaptive worker pool. Conversation fetches now
  run concurrently through one priority queue (project discovery, then
  per-project conversations, then standalone conversations fill leftover
  worker slots). An AIMD controller starts conservative, ramps up on sustained
  success, and backs off -- halving concurrency and honoring the server's
  `resets_at` -- on 429/529.
- New `export-all` flags: `--workers`, `--min-workers`, `--start-workers`,
  `--project-workers`, `--no-parallel`, with `CLAUDESYNC_*` env equivalents and
  optional `.claudesyncrc.json` config (precedence: flag > env > file > default).
- SIGINT-safe shutdown for `export-all` (stops scheduling new work, drains
  in-flight) with meaningful exit codes (130 on interrupt, 1 on errors).

### Fixed
- `export-all --format json` no longer fails with ENOENT when writing a project
  bundle into a not-yet-created `projects/` directory.
- A project whose conversation hard-fails is still written with its surviving
  conversations instead of being silently skipped.
- Moved pnpm `onlyBuiltDependencies` from the `package.json` `pnpm` field to
  `pnpm-workspace.yaml` (pnpm 11 no longer reads the former).

### Notes
- Single-shot commands (`ls`, `export`, `search`) and the MCP server are
  unchanged: with no limiter injected the client keeps its legacy fixed throttle.

## [0.7.1] - 2026-05-27

### Added
- `LICENSE` file (MIT) -- the README already declared MIT, but the repository
  was missing the actual license text.
- `"license": "MIT"` field in every `package.json` (root + the three published
  packages), so npm reports the correct license instead of UNLICENSED.

## [0.7.0] - 2026-05-27

### Added
- **Cross-platform cookie harvesting** via a host-side broker built on the MIT
  [rookie](https://github.com/thewh1teagle/rookie) CLI (auto-downloaded,
  SHA256-pinned). Reads the `claude.ai` `sessionKey` from Firefox / Chrome / Edge
  / Brave (and Safari on macOS), with a Claude Desktop best-effort fallback and a
  manual `CLAUDE_AI_COOKIE` escape hatch. Harvesting runs host-side because the
  container can't reach the OS keychain. See `docs/cookie-harvesting.md` and
  `docs/claude-desktop-linux.md`.
- **`claudesync-setup` management CLI** (`install` / `update` / `uninstall`) with
  full PowerShell parity. Components `--synchronizer` / `--mcp` / `--broker`
  (each with independent `=VERSION`), `--dry-run`, `--force`, `--target` for MCP
  client config (claude-code / claude-desktop / mcp-json), and `--pin-digest`
  (resolve image tags to `@sha256` and pin wrappers).
- **Auto digest-pinning**: when the Docker daemon refuses tag pulls (digest- or
  content-trust-enforcing), `--pin-digest` is enabled automatically and persisted.
- Tab-completions for `claudesync-setup` (bash / zsh / fish / PowerShell).
- Installers ship host scripts into the Docker images and extract them via
  `docker cp` (version-locked; GitHub-raw is a loud fallback).

### Changed
- `install.{sh,ps1}` are now thin bootstraps that fetch and run `claudesync-setup`;
  `install-mcp.{sh,ps1}` and `uninstall.{sh,ps1}` are back-compat shims.
- `sqlite3` is no longer required for cookie reading (only the Claude-Desktop-on-Linux fallback uses it).

### Notes
- Windows Chrome/Edge >= 127 use App-Bound Encryption, which no clean OSS tool can
  decrypt -- use Firefox or set `CLAUDE_AI_COOKIE` manually. macOS/Linux unaffected.

## [0.6.1] - 2026-05-27

### Fixed
- **`--preserve` now rescues project-nested conversation files.** `--preserve` globs are matched relative to the directory being rewritten. For project exports that directory is the project root, but conversation files live under `conversations/<slug>/`, so a bare `--preserve INDEX.md` only protected the project-root `INDEX.md` and silently dropped every nested conversation's `INDEX.md` on re-sync. `writeProjectBundle` now expands each preserve pattern with a globstar-prefixed variant (via the new `expandPreserveForProject` core export) so a bare pattern applies at the project root and at any nesting depth. Standalone-conversation exports are unaffected.

### Added
- Conversation `model` is now persisted to `.claudesync-state.json` (nullable, backward-compatible -- no `schema_version` bump). This lights up the existing "Model changed: X -> Y" changelog diff, which previously could never fire because the prior model was never stored. Note: only standalone conversations get a per-conversation state file; project-nested conversations still record their model via `README.md` only.
- New core export `expandPreserveForProject()` -- expands `--preserve` globs for the project-bundle scope.

## [0.6.0] - 2026-05-12

### Added
- `--preserve <glob>` repeatable flag on `export` and `export-all`. Preserves locally-added files inside the conversation/project directory across re-syncs in `--format files`. Pattern is a POSIX-style glob (single-segment `*`, multi-segment `**`, `?`, `[]` classes -- no brace expansion, no extglob) matched against paths relative to the directory being rewritten. `CHANGELOG.md` continues to be preserved unconditionally. Examples: `--preserve INDEX.md`, `--preserve 'notes/**'`, `--preserve '*.local.md'`.
- New core export `replaceWithPreserve()` -- the stash-and-rebuild primitive that powers preservation. Available to SDK consumers that build their own file-mode exporters.
- New core export `walkRelative()` -- generator that yields POSIX-relative paths under a root.
- New core exports `matchGlob` / `matchAnyGlob` / `compileGlob` -- zero-dep glob matcher safe for relative path matching. Not a full minimatch replacement.

### Fixed
- **`export-all` no longer wipes locally-added files inside project directories.** `writeProjectBundle()` previously did an unconditional `rmSync(outputPath)` before writing, deleting any non-bundle file (downstream indexer output, hand-written notes, etc.). Both the standalone-conversation path (`writeFilesMode`) and the project path (`writeProjectBundle`) now route through the new `replaceWithPreserve` helper. Without `--preserve` flags the only behavior change is that the rescue mechanism now exists.

### Changed
- `SyncConversationOptions` gained an optional `preserve?: string[]` field.
- Docker image now pins `pnpm@10.32.1` instead of `pnpm@latest` for reproducible builds.

## [0.5.2] - 2026-04-30

### Changed
- `export-all` project loop now goes through the same `fetchAndBuild()` core helper as the standalone-conversation loop, eliminating a duplicate fetch/build/name-handling code path. Project-conversation log lines now also fall back to `<unnamed <uuid>>` for nameless conversations.

### Added
- Core SDK exports: `fetchAndBuild`, `safeSlug`, `displayName`, `slugify` (consolidated naming + fetch helpers).
- `SyncConversationResult.displayName` field so callers always have a human-readable label without recomputing it.

## [0.5.1] - 2026-04-30

### Fixed
- `export-all` printed empty `Updated:` / `Exported:` log line when a conversation had a null/blank name. Now logs `<unnamed <uuid>>` and writes to `unnamed-<uuid>/` so multiple unnamed conversations no longer collide on the same directory.

## [0.5.0] - 2026-04-30

### Added
- `--skip-same` flag on `export` and `export-all`: cheap re-sync that compares list-endpoint `updated_at` + `current_leaf_message_uuid` against a `.claudesync-state.json` sidecar to skip unchanged conversations entirely
- `--skip-existing` flag on `export` (was `export-all`-only) for parity
- `?tree=True` opt-in on `getConversation()` exposes orphaned/edited-away message branches that the default response hides
- Branch capture per output format: `git` mode creates real refs (`main` + `alt-<short-leaf-uuid>`); `files`/`json` modes write alts under `branches/<short-leaf-uuid>/`
- Per-conversation `CHANGELOG.md` recording datestamped sync events (messages added per branch, artifacts added/changed/removed, metadata renames)
- `.claudesync-state.json` sidecar (in repo root, `.gitignore`'d) carrying the cursor for the next incremental sync; written every successful run regardless of flags
- Incremental git mode: re-syncing an existing repo appends new commits per affected branch via the new `appendToGit()` exporter instead of refusing to overwrite
- Core SDK exports: `getAllBranches`, `findDivergencePoint`, `shortLeafLabel`, `appendToGit`, `syncConversation`, `diffConversation`, `renderChangelogSection`, `appendChangelog`, `readSyncState`, `writeSyncState`

### Changed
- `--skip-same` and `--skip-existing` are mutually exclusive at the CLI layer (exits 1 with a clear message if both are passed)
- `export-all` standalone-conversation loop now routes through the shared `syncConversation()` orchestrator

### Fixed
- Bundle builder no longer drops alternate branches; `multiBranch: true` opt-in emits one commit per leaf with files under `branches/<short>/`

## [0.4.0] - 2026-04-02

### Added
- `claudesync export-all` command: export entire organization (all projects + standalone conversations) in one shot
- `--format files` option on `export`, `projects export`, and `export-all`: plain file tree output (no .git)
- `--skip-existing` flag on `export-all` for resumable exports after interruption or rate limiting

### Fixed
- Schema now tolerates absent `model`, `current_leaf_message_uuid`, and `parent_message_uuid` fields in API responses (some conversations omit these entirely)

## [0.3.1] - 2026-03-15

### Changed
- TUI is now `claudesync tui` subcommand (was auto-launch on no args, unreliable across npx/Docker)

### Fixed
- Docker wrapper passes `-it` flags when running `tui` subcommand (Ink requires TTY for raw mode)

## [0.3.0] - 2026-03-15

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

### Fixed
- TUI only launches when stdin is a TTY (prevents help-instead-of-TUI via npx/pipe)
- Docker wrapper uses `-it` flags when no args so TUI gets a proper terminal

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
