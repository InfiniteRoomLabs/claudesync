#!/bin/sh
# claudesync-mcp wrapper -- resolves the cookie via the shared broker, runs the
# MCP container. Installed by claudesync-setup.
set -eu
_mcp_error() { printf '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"claudesync-mcp: %s"}}' "$1" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || _mcp_error "docker not found"
_b="${XDG_DATA_HOME:-${HOME}/.local/share}/claudesync/harvest-cookie.sh"
[ -f "${_b}" ] || _mcp_error "cookie broker missing; run claudesync-setup"
_c="$(sh "${_b}" 2>/dev/null)" || _mcp_error "Could not read sessionKey cookie"
[ -n "${_c}" ] || _mcp_error "Could not read sessionKey cookie"
exec docker run --rm -i -e "CLAUDE_AI_COOKIE=${_c}" __REF__
