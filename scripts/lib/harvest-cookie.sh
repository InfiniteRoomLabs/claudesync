#!/bin/sh
# claudesync cookie broker (POSIX) -- shared by the CLI wrapper, the fish
# wrapper (which calls this via `sh`), and the MCP wrapper.
#
# Contract:
#   stdout : on success, exactly "sessionKey=<value>" (nothing else)
#   stderr : all logging, guidance, and errors
#   exit   : 0 on success, 1 when no cookie could be resolved
#
# Resolution order:
#   1. $CLAUDE_AI_COOKIE (escape hatch, always wins)
#   2. rookie-cli (auto-downloaded + SHA256-verified) across browsers
#   3. Claude Desktop store (best-effort; may be stale)
#   4. guided manual instructions -> exit 1
#
# Harvesting MUST run host-side: the Docker container is an isolated Linux
# box and cannot reach the macOS Keychain / Linux libsecret that Chromium
# cookie decryption requires. rookie does the keychain access + decrypt.

set -u

# ---------------------------------------------------------------------------
# Pinned rookie release. Assets carry no API-provided digest, so we pin the
# tag AND verify a hardcoded SHA256 computed at authoring time.
# ---------------------------------------------------------------------------
ROOKIE_TAG="v0.5.6"
ROOKIE_BASE="https://github.com/thewh1teagle/rookie/releases/download/${ROOKIE_TAG}"

SHA_linux_x86_64="48bd2a458ce9e6c5374067e1ebae1da65d309aaf33824d49ff2928e8b8a19305"
SHA_darwin_x86_64="dd8886e80d61216f7cc887f85802609ce9cea72d99a6a61ebd93864aee77d61b"
SHA_darwin_aarch64="c41159807fee942d88b21e1ea6cb20854dc50a89d3ff1433326d304c7e1f75a0"

log()  { printf '[claudesync] %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# OS / arch -> rookie asset name + expected SHA256
# Echoes "<asset_name> <sha256>" or returns 1 if no prebuilt CLI exists
# (e.g. linux/win arm64 -- caller falls through to manual guidance).
# ---------------------------------------------------------------------------
_hc_rookie_asset() {
  _os="$(uname -s)"
  _arch="$(uname -m)"
  case "${_os}:${_arch}" in
    Linux:x86_64)            echo "rookie-cli-x86_64-unknown-linux-gnu ${SHA_linux_x86_64}" ;;
    Darwin:x86_64)           echo "rookie-cli-x86_64-apple-darwin ${SHA_darwin_x86_64}" ;;
    Darwin:arm64|Darwin:aarch64) echo "rookie-cli-aarch64-apple-darwin ${SHA_darwin_aarch64}" ;;
    *) return 1 ;;
  esac
}

# Portable SHA256 of a file -> stdout (hex only).
_hc_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    return 1
  fi
}

# Ensure rookie-cli is cached + verified. Echoes its path on success.
_hc_ensure_rookie() {
  _cache="${XDG_CACHE_HOME:-${HOME}/.cache}/claudesync"
  _bin="${_cache}/rookie-cli"

  if [ -x "${_bin}" ]; then
    echo "${_bin}"
    return 0
  fi

  _asset_line="$(_hc_rookie_asset)" || {
    log "No prebuilt rookie-cli for $(uname -s)/$(uname -m); skipping auto cookie reading."
    return 1
  }
  _asset="${_asset_line% *}"
  _want_sha="${_asset_line#* }"

  command -v curl >/dev/null 2>&1 || { log "curl not found; cannot download rookie-cli."; return 1; }

  mkdir -p "${_cache}" || return 1
  _tmp="${_cache}/.rookie-cli.download.$$"
  log "Fetching rookie-cli ${ROOKIE_TAG} (one-time, cached in ${_cache}) ..."
  if ! curl -fsSL -o "${_tmp}" "${ROOKIE_BASE}/${_asset}"; then
    log "Download failed: ${ROOKIE_BASE}/${_asset}"
    rm -f "${_tmp}"
    return 1
  fi

  _got_sha="$(_hc_sha256 "${_tmp}" 2>/dev/null || true)"
  if [ -z "${_got_sha}" ]; then
    log "No sha256 tool available; refusing to use unverified binary."
    rm -f "${_tmp}"
    return 1
  fi
  if [ "${_got_sha}" != "${_want_sha}" ]; then
    log "SHA256 mismatch for ${_asset}!"
    log "  expected ${_want_sha}"
    log "  got      ${_got_sha}"
    rm -f "${_tmp}"
    return 1
  fi

  if chmod +x "${_tmp}" && mv "${_tmp}" "${_bin}"; then
    echo "${_bin}"
  else
    rm -f "${_tmp}"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Extract the sessionKey value from rookie's JSON array on stdin.
# Prefers jq, then python3, then a line-window awk fallback.
# rookie objects are pretty-printed with "name" before "value".
# ---------------------------------------------------------------------------
_hc_extract() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.[] | select(.name=="sessionKey") | .value' 2>/dev/null | head -n1
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for c in data if isinstance(data, list) else []:
    if isinstance(c, dict) and c.get("name") == "sessionKey":
        print(c.get("value", ""))
        break
' 2>/dev/null
  else
    awk '
      /"name"[[:space:]]*:[[:space:]]*"sessionKey"/ { hit=1 }
      hit && /"value"[[:space:]]*:/ {
        sub(/.*"value"[[:space:]]*:[[:space:]]*"/, "")
        sub(/".*/, "")
        print; exit
      }
    '
  fi
}

# Try one rookie browser. Echoes "sessionKey=<value>" on hit.
_hc_try_browser() {
  _rookie="$1"; _browser="$2"
  _val="$("${_rookie}" -b "${_browser}" -d claude.ai -f json 2>/dev/null | _hc_extract)"
  [ -n "${_val}" ] && printf 'sessionKey=%s' "${_val}"
}

# Safari needs Full Disk Access; detect the permission-shaped failure so we
# can guide the user instead of failing silently. macOS only.
# Runs inside command substitution, so signal "FDA blocked" via a sentinel
# file (a shell variable set here would not survive the subshell).
HC_SAFARI_FLAG="${TMPDIR:-/tmp}/.claudesync_safari_fda.$$"
_hc_try_safari() {
  _rookie="$1"
  _safari_out="${TMPDIR:-/tmp}/.claudesync_safari_out.$$"
  _err="$("${_rookie}" -b safari -d claude.ai -f json 2>&1 1>"${_safari_out}" || true)"
  _val="$(_hc_extract <"${_safari_out}" 2>/dev/null)"
  rm -f "${_safari_out}"
  if [ -n "${_val}" ]; then
    printf 'sessionKey=%s' "${_val}"
    return 0
  fi
  case "${_err}" in
    *[Pp]ermission*|*"not permitted"*|*"Operation not"*) : >"${HC_SAFARI_FLAG}" ;;
  esac
}

# Claude Desktop (best-effort; cookie may be stale -- app may use token auth).
# Linux store is plaintext sqlite; mac store is safeStorage-encrypted.
_hc_try_claude_desktop() {
  _rookie="$1"
  case "$(uname -s)" in
    Linux)  _cd="${HOME}/.config/Claude/Cookies" ;;
    Darwin) _cd="${HOME}/Library/Application Support/Claude/Cookies" ;;
    *)      return 0 ;;
  esac
  [ -f "${_cd}" ] || return 0

  # Try rookie with an explicit path first.
  _val="$("${_rookie}" -p "${_cd}" -d claude.ai -f json 2>/dev/null | _hc_extract)"
  # Linux plaintext fallback: read the value column directly.
  if [ -z "${_val}" ] && [ "$(uname -s)" = "Linux" ] && command -v sqlite3 >/dev/null 2>&1; then
    _val="$(sqlite3 -readonly "file:${_cd}?immutable=1" \
      "SELECT value FROM cookies WHERE host_key LIKE '%claude.ai%' AND name='sessionKey' AND value<>'' LIMIT 1;" \
      2>/dev/null || true)"
  fi
  if [ -n "${_val}" ]; then
    log "Using Claude Desktop cookie (note: may be stale if the app uses token auth)."
    printf 'sessionKey=%s' "${_val}"
  fi
}

# ---------------------------------------------------------------------------
# Manual guidance (also covers the Windows Chrome ABE dead-end indirectly via
# the Firefox steer; this script does not run on Windows -- see Harvest-Cookie.ps1).
# ---------------------------------------------------------------------------
_hc_guidance() {
  log ""
  log "Could not read the claude.ai sessionKey cookie automatically."
  log ""
  log "Fix it one of these ways:"
  log "  1. Log in to claude.ai in Firefox or Chrome, then re-run."
  log "  2. Set it manually -- claude.ai > F12 > Application > Cookies > sessionKey:"
  log "       export CLAUDE_AI_COOKIE='sessionKey=<paste-value>'"
  if [ -f "${HC_SAFARI_FLAG}" ]; then
    log "  3. Safari was blocked: grant your terminal Full Disk Access"
    log "       (System Settings > Privacy & Security > Full Disk Access), then re-run."
    rm -f "${HC_SAFARI_FLAG}"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
hc_main() {
  # 1. explicit env var wins
  if [ -n "${CLAUDE_AI_COOKIE:-}" ]; then
    printf '%s' "${CLAUDE_AI_COOKIE}"
    return 0
  fi

  _rookie="$(_hc_ensure_rookie)" || { _hc_guidance; return 1; }

  # 2. browsers, freshest sources first
  for _b in firefox chrome edge brave chromium; do
    _hit="$(_hc_try_browser "${_rookie}" "${_b}")"
    if [ -n "${_hit}" ]; then printf '%s' "${_hit}"; return 0; fi
  done

  # 3. Safari (macOS only; FDA-aware)
  if [ "$(uname -s)" = "Darwin" ]; then
    _hit="$(_hc_try_safari "${_rookie}")"
    if [ -n "${_hit}" ]; then printf '%s' "${_hit}"; return 0; fi
  fi

  # 4. Claude Desktop (best-effort, last because it may be stale)
  _hit="$(_hc_try_claude_desktop "${_rookie}")"
  if [ -n "${_hit}" ]; then printf '%s' "${_hit}"; return 0; fi

  _hc_guidance
  return 1
}

hc_main
