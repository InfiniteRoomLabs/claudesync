#!/bin/sh
# ClaudeSync uninstaller -- back-compat shim.
# Delegates to claudesync-setup uninstall (removes everything by default;
# pass --synchronizer / --mcp / --broker to scope it).
set -eu

IMAGE_SYNC="deathnerd/claudesync"
RAW_BASE="https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main"
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"

# Prefer an already-installed manager (no docker/network needed to remove).
if command -v claudesync-setup >/dev/null 2>&1; then
    exec claudesync-setup uninstall "$@"
fi
if [ -x "${HOME}/.local/bin/claudesync-setup" ]; then
    exec sh "${HOME}/.local/bin/claudesync-setup" uninstall "$@"
fi

SETUP=""
CLEANUP=""
if [ -f "${SCRIPT_DIR}/claudesync-setup.sh" ]; then
    SETUP="${SCRIPT_DIR}/claudesync-setup.sh"
else
    SETUP="$(mktemp)"
    CLEANUP="${SETUP}"
    _got=0
    if command -v docker >/dev/null 2>&1; then
        _cid="$(docker create "${IMAGE_SYNC}:latest" 2>/dev/null || true)"
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
        echo "uninstall.sh: could not obtain claudesync-setup.sh." >&2
        rm -f "${CLEANUP}"
        exit 1
    fi
fi

if sh "${SETUP}" uninstall "$@"; then _rc=0; else _rc=$?; fi
[ -n "${CLEANUP}" ] && rm -f "${CLEANUP}"
exit "${_rc}"
