# ClaudeSync

Unofficial TypeScript SDK wrapping the [claude.ai](https://claude.ai) web API. Export your conversations, artifacts, and project knowledge as git repositories.

> **Your data, your way.** ClaudeSync is a community tool. It is not affiliated with or endorsed by Anthropic. Use at your own risk -- accessing the undocumented web API may violate Anthropic's Terms of Service and could result in account suspension.

## Quick Install

### CLI (bash, zsh, fish)

```sh
curl -fsSL https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/install.sh | sh
```

### CLI (PowerShell / Windows)

```powershell
irm https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/install.ps1 | iex
```

### MCP Server (Claude Code / Claude Desktop)

```sh
# Unix
curl -fsSL https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/install-mcp.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/install-mcp.ps1 | iex
```

### Uninstall

```sh
# Unix
curl -fsSL https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/uninstall.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/uninstall.ps1 | iex
```

## What It Does

ClaudeSync reads your session cookie from Firefox (or Chrome on Windows/macOS) and uses it to access the claude.ai web API. It can:

- **List conversations** with model, date, and project info
- **Export conversations** as git repositories (conversation text + artifacts)
- **Search** across all your conversations (full-text)
- **List projects** and download project knowledge files
- **List and download artifacts** from the "wiggle" filesystem

## Usage

### CLI

```sh
# List your conversations
claudesync ls

# Export a conversation to a git repo
claudesync export <conversation-id>
claudesync export <conversation-id> --output ./my-export

# Export as JSON bundle instead of git
claudesync export <conversation-id> --format json

# Search conversations
claudesync search "typescript generics"

# List projects
claudesync projects

# All commands support --json for machine-readable output
claudesync ls --json
claudesync projects --json
```

### MCP Server

Once installed, the MCP server exposes 8 tools to Claude Code / Claude Desktop:

| Tool | Description |
|------|-------------|
| `list_organizations` | List your claude.ai organizations |
| `list_conversations` | List conversations with metadata |
| `get_conversation` | Get full conversation with all messages |
| `search_conversations` | Full-text search across conversations |
| `list_projects` | List your projects |
| `get_project_docs` | Get project knowledge file contents |
| `list_artifacts` | List artifact files for a conversation |
| `download_artifact` | Download an artifact file |

### Docker

```sh
# CLI via Docker (manual cookie)
docker run --rm -e CLAUDE_AI_COOKIE='sessionKey=...' \
  -v "$(pwd):/data" deathnerd/claudesync:latest ls

# MCP server via Docker
docker run --rm -i -e CLAUDE_AI_COOKIE='sessionKey=...' \
  deathnerd/claudesync-mcp:latest
```

## Authentication

ClaudeSync reads your `sessionKey` cookie automatically:

| Browser | Platform | Method |
|---------|----------|--------|
| Firefox | Linux, macOS | Reads `cookies.sqlite` directly (standard, Snap, Flatpak paths) |
| Chrome | Windows | DPAPI decryption (native, no external deps) |
| Chrome | macOS | Keychain access via `security` CLI |
| Chrome | Linux | Not auto-supported -- use `pycookiecheat` or manual paste |
| Any | Any | Set `CLAUDE_AI_COOKIE` env var manually |

**Manual method:** Open claude.ai, press F12, go to Application > Cookies > claude.ai, copy the `sessionKey` value, then:

```sh
# Unix
export CLAUDE_AI_COOKIE='sessionKey=<paste-value>'

# PowerShell
$env:CLAUDE_AI_COOKIE = 'sessionKey=<paste-value>'
```

## Architecture

```
Consumers:     CLI  |  MCP Server  |  (Firefox Extension -- future)
                |          |
Core SDK:    @claudesync/core (TypeScript)
               Auth | API Client | Export Engine | Message Tree
                |
Transport:   claude.ai Web API (undocumented, cookie auth)
```

**Monorepo packages:**

| Package | Description |
|---------|-------------|
| `@claudesync/core` | SDK: auth, HTTP client, Zod schemas, git export engine |
| `@claudesync/mcp-server` | MCP server with 8 tools (stdio transport) |
| `@claudesync/cli` | CLI tool (ls, export, search, projects) |

## Requirements

- **Node.js v24+** (required -- Cloudflare blocks Bun and curl via TLS fingerprinting)
- **Docker** (for containerized usage)
- **sqlite3** CLI (for Firefox cookie reading on Unix)
- **pnpm** (for development)

## Development

```sh
git clone https://github.com/InfiniteRoomLabs/claudesync.git
cd claudesync
pnpm install
pnpm build
pnpm test
```

## Installer Options

All install scripts support:

| Flag | Description |
|------|-------------|
| `--force` / `-f` | Overwrite existing installations without asking |
| (no flag) | Prompts interactively before replacing existing files |

The MCP installer also supports:

| Flag | Description |
|------|-------------|
| `--target claude-code` | Configure for Claude Code (skip interactive menu) |
| `--target claude-desktop` | Configure for Claude Desktop |
| `--target mcp-json` | Write project-level `.mcp.json` |

## License

MIT

## Disclaimer

ClaudeSync is an unofficial, community-built tool. It is not affiliated with, endorsed by, or supported by Anthropic. It accesses the undocumented claude.ai web API using your own session credentials to export your own data. Use of this tool may violate Anthropic's Terms of Service. The authors assume no liability for any consequences of using this tool, including but not limited to account suspension.
