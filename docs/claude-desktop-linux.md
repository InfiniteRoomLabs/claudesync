# Claude Desktop on Linux (unofficial)

Anthropic ships no official Claude Desktop for Linux. The community package
`claude-desktop` (an Electron repack of the official app) is what ClaudeSync's
cookie broker targets on Linux.

## Install (community apt repo)

The package comes from a third-party Debian repository, GPG-signed:

```sh
# Signing key -> /usr/share/keyrings/claude-desktop.gpg
# Source list -> /etc/apt/sources.list.d/claude-desktop.list
deb [signed-by=/usr/share/keyrings/claude-desktop.gpg arch=amd64,arm64] http://pkg.claude-desktop-debian.dev stable main
```

- Primary repo: `http://pkg.claude-desktop-debian.dev`
- Fallback repo: `https://aaddrick.github.io/claude-desktop-debian`
- Package: `claude-desktop` (Electron 41.x; binary at `/usr/bin/claude-desktop`)
- Upstream project: <https://github.com/aaddrick/claude-desktop-debian>

> This is **not** an Anthropic-published package. Review the repo before
> trusting it on your machine.

## Where it stores cookies

Like any Chromium/Electron app, session state lives under `~/.config/Claude/`:

| Path | Notes |
|------|-------|
| `~/.config/Claude/Cookies` | SQLite DB (`cookies` table) |
| `~/.config/Claude/Local State` | JSON; on this build it carries **no** `os_crypt.encrypted_key` |

On the Linux build we inspected, the `sessionKey` cookie is stored
**unencrypted** (the `value` column is populated; `encrypted_value` is empty).
So ClaudeSync reads it with a plain SQLite query -- no keychain, no decryption:

```sql
SELECT value FROM cookies
WHERE host_key LIKE '%claude.ai%' AND name='sessionKey' AND value <> '';
```

## Caveat: the cookie may be stale

Claude Desktop increasingly authenticates via tokens (`~/.config/Claude/buddy-tokens.json`),
not a long-lived `claude.ai` `sessionKey`. The `Cookies` DB can therefore hold an
**expired** sessionKey. ClaudeSync tries browsers first (fresher) and only falls
back to the Claude Desktop store last, with a warning. If exports fail with an
auth error, log in to claude.ai in a browser instead.

## macOS / Windows

Claude Desktop on macOS/Windows stores cookies with the OS `safeStorage`
(Keychain / DPAPI) under a bespoke path the broker does not target. Those
platforms are **manual-only** for Claude Desktop: set `CLAUDE_AI_COOKIE`
yourself, or just use a browser (Firefox/Chrome) which the broker reads natively.
