#!/bin/sh
# ClaudeSync MCP installer -- back-compat shim.
# Delegates to claudesync-setup with the `install --mcp` subcommand.
#
# Usage:
#   curl -fsSL <url>/install-mcp.sh | sh
#   curl -fsSL <url>/install-mcp.sh | bash -s -- --dry-run --pin-digest
set -eu

IMAGE_MCP="deathnerd/claudesync-mcp"
RAW_BASE="https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main"
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"

SETUP=""
CLEANUP=""

if [ -f "${SCRIPT_DIR}/claudesync-setup.sh" ]; then
    SETUP="${SCRIPT_DIR}/claudesync-setup.sh"
else
    SETUP="$(mktemp)"
    CLEANUP="${SETUP}"
    _got=0
    if command -v docker >/dev/null 2>&1; then
        _cid="$(docker create "${IMAGE_MCP}:latest" 2>/dev/null || true)"
        if [ -n "${_cid}" ]; then
            if docker cp "${_cid}:/opt/claudesync/host/claudesync-setup.sh" "${SETUP}" >/dev/null 2>&1; then _got=1; fi
            docker rm -f "${_cid}" >/dev/null 2>&1 || true
        fi
    fi
    if [ "${_got}" = "0" ]; then
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "${RAW_BASE}/scripts/claudesync-setup.sh" -o "${SETUP}" && _got=1
        elif command -v wget >/dev/null 2>&1; then
            wget -qO "${SETUP}" "${RAW_BASE}/scripts/claudesync-setup.sh" && _got=1
        fi
    fi
    if [ "${_got}" != "1" ]; then
        echo "install-mcp.sh: could not obtain claudesync-setup.sh (need docker, curl, or wget)." >&2
        rm -f "${CLEANUP}"
        exit 1
    fi
fi

if sh "${SETUP}" install --mcp "$@"; then _rc=0; else _rc=$?; fi
[ -n "${CLEANUP}" ] && rm -f "${CLEANUP}"
exit "${_rc}"
