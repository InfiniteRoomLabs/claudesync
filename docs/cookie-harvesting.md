# Cookie harvesting

ClaudeSync runs inside Docker, but the container cannot read your browser
cookies: it's an isolated Linux box with no access to the host's macOS
Keychain, Windows DPAPI, or Linux libsecret -- exactly the secrets needed to
decrypt modern Chromium cookies. So cookie harvesting happens **host-side** in a
small broker, which passes the result to the container as `CLAUDE_AI_COOKIE`.

## The broker

Installed by `install.sh` / `install.ps1` (and the MCP installers) to:

- macOS/Linux: `${XDG_DATA_HOME:-~/.local/share}/claudesync/harvest-cookie.sh`
- Windows: `%LOCALAPPDATA%\claudesync\Harvest-Cookie.ps1`

It is sourced, in order, from: the local repo (dev) -> the pulled Docker image
(version-locked) -> GitHub `main` (loud fallback). The wrappers call it, then run
the container.

### Resolution order
1. `$CLAUDE_AI_COOKIE` if already set (escape hatch).
2. [rookie](https://github.com/thewh1teagle/rookie) across browsers
   (firefox -> chrome -> edge -> brave -> chromium [-> safari on macOS]),
   filtered to `claude.ai`, first `sessionKey` wins.
3. Claude Desktop store (best-effort, last -- may be stale). See
   [claude-desktop-linux.md](./claude-desktop-linux.md).
4. Guided manual instructions, then fail.

## rookie

We shell out to the MIT-licensed `rookie-cli` (pinned to **v0.5.6**,
SHA256-verified) rather than hand-rolling AES/Keychain/DPAPI/libsecret across
three OSes. It is auto-downloaded on first run and cached in
`~/.cache/claudesync` (`%LOCALAPPDATA%\claudesync` on Windows). The `--domains
claude.ai` filter means only claude.ai cookies are read -- not your whole cookie
database.

## Support matrix

| Browser | Linux | macOS | Windows |
|---------|-------|-------|---------|
| Firefox | rookie | rookie | rookie (recommended on Windows) |
| Chrome / Edge / Brave | rookie (libsecret) | rookie (Keychain) | rookie v10 only |
| Safari | -- | rookie (needs Full Disk Access) | -- |
| Claude Desktop | SQLite (plaintext, maybe stale) | manual | manual |
| Manual `CLAUDE_AI_COOKIE` | always | always | always |

### Known limits
- **Windows Chrome/Edge >= 127 (App-Bound Encryption / "v20"):** cannot be
  decrypted by any clean OSS tool. Use **Firefox** on Windows, or set
  `CLAUDE_AI_COOKIE` manually. (macOS/Linux are unaffected.)
- **Safari (macOS):** requires granting your terminal **Full Disk Access**
  (System Settings > Privacy & Security > Full Disk Access). The broker detects
  the permission error and tells you. Also, `rookie-cli`'s Safari support depends
  on the macOS build's browser list -- verify on a Mac.
- **Linux/Windows arm64:** no prebuilt `rookie-cli` asset -> manual cookie only.

## Manual cookie

Always works, everywhere:

1. Open claude.ai, press F12 -> Application -> Cookies -> `claude.ai`.
2. Copy the `sessionKey` value.
3. Set the env var:
   - sh/zsh/fish: `export CLAUDE_AI_COOKIE='sessionKey=<value>'`
   - PowerShell: `$env:CLAUDE_AI_COOKIE = "sessionKey=<value>"`

## Security notes
- The broker only ever reads the `claude.ai` `sessionKey` (domain-filtered).
- rookie is pinned by release tag and verified against a hardcoded SHA256.
- The cookie is passed to the container via an env var and never written to disk.
