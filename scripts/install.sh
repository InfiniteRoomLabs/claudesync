#!/bin/sh
# ClaudeSync bootstrap installer -- obtains claudesync-setup and runs it.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/install.sh | sh
#   curl -fsSL <url> | bash -s -- [install|update|uninstall] [--mcp] [--synchronizer] [--dry-run] ...
#
# With no arguments this installs everything (the happy path). All other
# behavior lives in claudesync-setup; this script just bootstraps it.
set -eu

IMAGE_SYNC="deathnerd/claudesync"
RAW_BASE="https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main"
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"

printf '\n  ClaudeSync -- your claude.ai data, your way\n'
printf '  https://github.com/InfiniteRoomLabs/claudesync\n\n'

SETUP=""
CLEANUP=""

if [ -f "${SCRIPT_DIR}/claudesync-setup.sh" ]; then
    SETUP="${SCRIPT_DIR}/claudesync-setup.sh"
else
    SETUP="$(mktemp)"
    CLEANUP="${SETUP}"
    _got=0
    # Prefer extracting from the pulled image (version-locked).
    if command -v docker >/dev/null 2>&1; then
        _cid="$(docker create "${IMAGE_SYNC}:latest" 2>/dev/null || true)"
        if [ -n "${_cid}" ]; then
            if docker cp "${_cid}:/opt/claudesync/host/claudesync-setup.sh" "${SETUP}" >/dev/null 2>&1; then _got=1; fi
            docker rm -f "${_cid}" >/dev/null 2>&1 || true
        fi
    fi
    # Fall back to GitHub.
    if [ "${_got}" = "0" ]; then
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "${RAW_BASE}/scripts/claudesync-setup.sh" -o "${SETUP}" && _got=1
        elif command -v wget >/dev/null 2>&1; then
            wget -qO "${SETUP}" "${RAW_BASE}/scripts/claudesync-setup.sh" && _got=1
        fi
    fi
    if [ "${_got}" != "1" ]; then
        echo "install.sh: could not obtain claudesync-setup.sh (need docker, curl, or wget)." >&2
        rm -f "${CLEANUP}"
        exit 1
    fi
fi

if sh "${SETUP}" "$@"; then _rc=0; else _rc=$?; fi
[ -n "${CLEANUP}" ] && rm -f "${CLEANUP}"
exit "${_rc}"
