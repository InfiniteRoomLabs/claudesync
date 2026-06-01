
# claudesync -- installed by https://github.com/InfiniteRoomLabs/claudesync
claudesync() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "claudesync: docker is not installed." >&2
    return 1
  fi
  local _cs_broker="${XDG_DATA_HOME:-${HOME}/.local/share}/claudesync/harvest-cookie.sh"
  if [ ! -f "${_cs_broker}" ]; then
    echo "claudesync: cookie broker missing at ${_cs_broker}; run claudesync-setup" >&2
    return 1
  fi
  local _cs_cookie
  _cs_cookie="$(sh "${_cs_broker}")" || return 1
  [ -n "${_cs_cookie}" ] || return 1
  local _cs_tty=""
  case "${1:-}" in tui) _cs_tty="-it" ;; esac
  CLAUDE_AI_COOKIE="${_cs_cookie}" \
    docker run --rm ${_cs_tty} -e CLAUDE_AI_COOKIE -v "$(pwd):/data" __REF__ "$@"
}
