# ClaudeSync

Unofficial TypeScript SDK + tooling for the [claude.ai](https://claude.ai) web API. Export your conversations, artifacts, and project knowledge as git repositories -- from the CLI or as an MCP server.

> **Your data, your way.** ClaudeSync is a community tool, not affiliated with or endorsed by Anthropic. Accessing the undocumented web API may violate Anthropic's Terms of Service and could result in account suspension. Use at your own risk.

---

## Install

```sh
# Unix (bash, zsh, fish) -- installs everything: CLI + MCP server + cookie broker
curl -fsSL https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/install.sh | sh
```

```powershell
# Windows PowerShell (5.1 or 7+)
irm https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/install.ps1 | iex
```

Everything runs in Docker; the installer only places thin host-side wrappers and a
cookie reader. The one-liner bootstraps **`claudesync-setup`** (a small manager)
onto your PATH and runs it. After that, manage everything with `claudesync-setup`.

> **Requires Docker.** Node/pnpm are only needed for development -- users run the
> published images.

---

## Managing the install

```sh
claudesync-setup                       # install everything, latest
claudesync-setup install 0.6.1         # pin all components to 0.6.1
claudesync-setup install --mcp --synchronizer=0.6.1   # choose components / per-component versions
claudesync-setup update                # re-install at latest (honors recorded pins)
claudesync-setup uninstall --mcp       # remove just the MCP wrapper
claudesync-setup uninstall             # remove everything
```

```
SYNOPSIS
    claudesync-setup [SUBCOMMAND] [VERSION] [COMPONENTS] [OPTIONS]

SUBCOMMANDS
    install      (default) install components
    update       re-install at a (possibly new) version
    uninstall    remove components

COMPONENTS   (omit all => everything)
    --synchronizer[=VER]   the `claudesync` CLI wrapper + image
    --mcp[=VER]            the MCP server wrapper + image
    --broker               the host-side cookie reader only

OPTIONS
    --target=TARGET   MCP client to configure: claude-code | claude-desktop | mcp-json
                      (omit => prompt; non-interactive skips with instructions)
    --pin-digest      resolve image tags to @sha256 and pin the wrappers
                      (auto-enabled when the Docker daemon refuses tag pulls)
    --dry-run         print every action, change nothing
    --force           do not prompt before replacing files
    -h, --help        show help

VERSIONS
    positional VERSION is a default applied per component; --mcp=VER overrides it.
    Each component resolves against its OWN image -- versions are not assumed
    in lockstep.
```

**PowerShell** uses native switches:

```powershell
claudesync-setup install -Mcp -Synchronizer -McpVersion 0.5.2 -PinDigest -Target claude-code
```

### Passing options to the piped installer

```sh
# bash: -s -- forwards args to a script read from stdin
curl -fsSL <install.sh-url> | bash -s -- install --mcp --target=mcp-json --dry-run
```

```powershell
# irm | iex cannot take args; build a scriptblock instead:
& ([scriptblock]::Create((irm <install.ps1-url>))) install -Mcp -DryRun
```

`install-mcp.{sh,ps1}` and `uninstall.{sh,ps1}` remain as back-compat shims that
delegate to `claudesync-setup`.

---

## What it does

ClaudeSync reads your `claude.ai` session cookie from your browser and uses it to
access the web API. It can:

- **List conversations** with model, date, and project info
- **Export conversations** as git repositories (text + artifacts) or JSON bundles
- **Search** across all conversations (full-text)
- **List projects** and download project knowledge files
- **List / download artifacts** from the "wiggle" filesystem

### CLI

```
SYNOPSIS
    claudesync <command> [options]        (runs in Docker; reads the cookie automatically)

COMMANDS
    ls                          list conversations
    export <conversation-id>    export one conversation
    export-all                  export the entire organization
    projects [list]             list projects
    projects export <id>        export a project (knowledge + conversations)
    search <query>              full-text search
    tui                         interactive browser (Miller Columns)

COMMON OPTIONS
    --org <id>                  organization ID (auto-detected if omitted)
    --json                      machine-readable output (ls / search / projects)
    --query <jmespath>          filter JSON output (implies --json)

LIST OPTIONS                    (ls, search)
    --limit <n>                 max rows (ls: 20, search: 10)
    --starred                   ls only: starred conversations

EXPORT OPTIONS                  (export, export-all, projects export)
    --output <path>             output directory
    --format git|json|files     export format (default: git; export-all: files)
    --author-name <name>        git author name (default: Claude)
    --author-email <email>      git author email
    --skip-artifacts            do not download artifacts
    --skip-existing             skip if the output directory already exists
    --skip-same                 skip if unchanged since the last sync
    --preserve <glob>           keep locally-added files across re-syncs
                                (repeatable; --format files; CHANGELOG.md always kept)

    -h, --help                  --version
```

```sh
# Examples
claudesync ls                                   # list conversations
claudesync export <conversation-id>             # export to a git repo
claudesync export <conversation-id> --output ./my-export --format files
claudesync export-all --format files            # whole org
claudesync search "typescript generics"
claudesync projects
claudesync ls --json --query "[?starred]"       # machine output, JMESPath-filtered
```

### MCP server

Installed via `--mcp` and registered with your client through `--target`. Exposes
8 tools over stdio:

| Tool | Description |
|------|-------------|
| `list_organizations` | List your claude.ai organizations |
| `list_conversations` | List conversations with metadata |
| `get_conversation` | Full conversation with all messages |
| `search_conversations` | Full-text search across conversations |
| `list_projects` | List your projects |
| `get_project_docs` | Project knowledge file contents |
| `list_artifacts` | List artifact files for a conversation |
| `download_artifact` | Download an artifact file |

To (re)configure the client later:

```sh
claudesync-setup install --mcp --target=claude-code   # or claude-desktop / mcp-json
```

### Docker (manual, no wrappers)

```sh
docker run --rm -e CLAUDE_AI_COOKIE='sessionKey=...' -v "$(pwd):/data" deathnerd/claudesync:latest ls
docker run --rm -i -e CLAUDE_AI_COOKIE='sessionKey=...' deathnerd/claudesync-mcp:latest   # MCP
```

---

## Authentication

The cookie is read host-side by a small broker built on
[rookie](https://github.com/thewh1teagle/rookie) (auto-downloaded, SHA256-pinned on
first run). Harvesting must run on the host -- the container can't reach your OS
keychain. Full details: [docs/cookie-harvesting.md](docs/cookie-harvesting.md).

| Browser | Linux | macOS | Windows |
|---------|-------|-------|---------|
| Firefox | yes | yes | yes (recommended on Windows) |
| Chrome / Edge / Brave | yes | yes | v10 only -- see note |
| Safari | -- | yes (needs Full Disk Access) | -- |
| Claude Desktop | yes (plaintext, may be stale) | manual | manual |
| Manual `CLAUDE_AI_COOKIE` | always | always | always |

> **Windows Chrome/Edge >= 127** use App-Bound Encryption, which no clean
> open-source tool can decrypt -- use **Firefox** on Windows, or set the cookie
> manually. macOS and Linux are unaffected.

**Manual cookie** (always works): claude.ai > F12 > Application > Cookies >
`sessionKey`, then:

```sh
export CLAUDE_AI_COOKIE='sessionKey=<paste-value>'        # sh/zsh/fish
$env:CLAUDE_AI_COOKIE = 'sessionKey=<paste-value>'        # PowerShell
```

---

## Architecture

```
Consumers:   CLI  |  MCP Server  |  (Firefox Extension -- future)
                |        |
Core SDK:    @infinite-room-labs/claudesync-core (TypeScript)
               Auth | API Client | Export Engine | Message Tree
                |
Transport:   claude.ai Web API (undocumented, cookie auth)
```

Host-side wrappers (`claudesync`, `claudesync-mcp`) and the cookie broker are the
only things installed locally; the SDK/CLI/MCP code runs in Docker. The installers
ship those wrappers inside the image and extract them via `docker cp`, so they stay
version-locked to the image (GitHub raw is only a loud fallback).

| Package | Description |
|---------|-------------|
| `@infinite-room-labs/claudesync-core` | SDK: auth, HTTP client, Zod schemas, git export engine |
| `@infinite-room-labs/claudesync-mcp-server` | MCP server, 8 tools (stdio) |
| `@infinite-room-labs/claudesync-cli` | CLI (ls, export, search, projects) |

---

## Requirements

- **Docker** -- for all normal usage
- **Node.js v24+** -- development only (Cloudflare blocks Bun/curl via TLS fingerprinting)
- **pnpm** -- development only
- **sqlite3** -- optional; only the Claude-Desktop-on-Linux cookie fallback uses it

## Development

```sh
git clone https://github.com/InfiniteRoomLabs/claudesync.git
cd claudesync
pnpm install
pnpm build
pnpm test
```

## License

MIT

## Disclaimer

ClaudeSync is an unofficial, community-built tool, not affiliated with, endorsed
by, or supported by Anthropic. It accesses the undocumented claude.ai web API using
your own session credentials to export your own data. Use may violate Anthropic's
Terms of Service. The authors assume no liability for any consequences, including
account suspension.
