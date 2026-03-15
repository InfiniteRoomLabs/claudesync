#!/bin/sh
# ClaudeSync installer -- pipe-to-shell version
# Usage: curl -fsSL https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/install.sh | sh
#
# Installs a `claudesync` shell function that:
#   1. Reads your Firefox sessionKey cookie via sqlite3
#   2. Passes it as CLAUDE_AI_COOKIE to the Docker container
#   3. Mounts the current directory as /data for export commands
#
# Supports: bash, zsh, fish
# Dependencies: sh, sqlite3, docker
# POSIX-compatible at top level; generated functions are shell-specific.

set -eu

# ---------------------------------------------------------------------------
# Terminal color helpers (POSIX-safe, only when stdout is a tty)
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    RESET='\033[0m'
else
    RED='' GREEN='' YELLOW='' CYAN='' BOLD='' RESET=''
fi

info()    { printf "%b[claudesync]%b %s\n" "${CYAN}"  "${RESET}" "$*"; }
success() { printf "%b[claudesync]%b %s\n" "${GREEN}" "${RESET}" "$*"; }
warn()    { printf "%b[claudesync]%b %s\n" "${YELLOW}" "${RESET}" "$*"; }
error()   { printf "%b[claudesync]%b %s\n" "${RED}"   "${RESET}" "$*" >&2; }
die()     { error "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
printf "\n%b" "${BOLD}"
printf "  ClaudeSync -- your claude.ai data, your way\n"
printf "  https://github.com/InfiniteRoomLabs/claudesync\n"
printf "%b\n" "${RESET}"

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    die "Docker is not installed or not on PATH. Install Docker first: https://docs.docker.com/get-docker/"
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
    die "sqlite3 is not installed. Install it with your package manager (e.g. 'apt install sqlite3' or 'brew install sqlite3')."
fi

info "Checking Docker image deathnerd/claudesync:latest ..."
if ! docker image inspect deathnerd/claudesync:latest >/dev/null 2>&1; then
    info "Image not found locally -- pulling from Docker Hub ..."
    docker pull deathnerd/claudesync:latest || die "Failed to pull deathnerd/claudesync:latest. Check your internet connection and Docker login."
fi
success "Docker image ready."

# ---------------------------------------------------------------------------
# Detect shell
# ---------------------------------------------------------------------------
detect_shell() {
    # Prefer $SHELL; fall back to inspecting parent process.
    _shell="${SHELL:-}"
    case "${_shell}" in
        */fish) echo "fish"; return ;;
        */zsh)  echo "zsh";  return ;;
        */bash) echo "bash"; return ;;
    esac
    # If piped (no $SHELL set cleanly), check parent process name.
    _parent="$(ps -p $$ -o comm= 2>/dev/null || true)"
    case "${_parent}" in
        fish) echo "fish"; return ;;
        zsh)  echo "zsh";  return ;;
        bash) echo "bash"; return ;;
    esac
    echo "bash"  # safe default
}

USER_SHELL="$(detect_shell)"
info "Detected shell: ${USER_SHELL}"

# ---------------------------------------------------------------------------
# Firefox profile path resolver (POSIX)
# Returns the path to the default profile directory, or empty string.
# ---------------------------------------------------------------------------
find_firefox_profile() {
    # Candidate base directories in priority order.
    _candidates=""
    case "$(uname -s)" in
        Darwin)
            _candidates="${HOME}/Library/Application Support/Firefox/Profiles"
            ;;
        *)
            # Standard Linux, Ubuntu Snap, Flatpak
            _candidates="${HOME}/.mozilla/firefox
${HOME}/snap/firefox/common/.mozilla/firefox
${HOME}/.var/app/org.mozilla.firefox/.mozilla/firefox"
            ;;
    esac

    IFS='
'
    for _base in ${_candidates}; do
        _ini="${_base}/profiles.ini"
        if [ -f "${_ini}" ]; then
            # Extract the path of the default profile.
            # profiles.ini has sections like:
            #   [Profile0]
            #   Default=1
            #   Path=abcd1234.default-release
            #   IsRelative=1
            #
            # Strategy: walk lines; when we see Default=1 in a section,
            # the Path= in the same section is the one we want.
            _profile_path=""
            _is_default=0
            _current_path=""
            while IFS= read -r _line; do
                case "${_line}" in
                    \[*)
                        # New section; commit previous if it was default.
                        if [ "${_is_default}" = "1" ] && [ -n "${_current_path}" ]; then
                            _profile_path="${_current_path}"
                            break
                        fi
                        _is_default=0
                        _current_path=""
                        ;;
                    Default=1*)
                        _is_default=1
                        ;;
                    Path=*)
                        _current_path="${_line#Path=}"
                        ;;
                    IsRelative=1*)
                        : # handled below
                        ;;
                esac
            done < "${_ini}"
            # Handle the last section if it was default.
            if [ -z "${_profile_path}" ] && [ "${_is_default}" = "1" ] && [ -n "${_current_path}" ]; then
                _profile_path="${_current_path}"
            fi

            if [ -n "${_profile_path}" ]; then
                # Determine if path is relative to _base.
                case "${_profile_path}" in
                    /*)
                        _full="${_profile_path}"
                        ;;
                    *)
                        _full="${_base}/${_profile_path}"
                        ;;
                esac
                if [ -d "${_full}" ]; then
                    printf "%s" "${_full}"
                    return 0
                fi
            fi
        fi
    done
    return 1
}

# Validate that Firefox profile and cookies.sqlite are present.
FIREFOX_PROFILE=""
if _fp="$(find_firefox_profile 2>/dev/null)"; then
    FIREFOX_PROFILE="${_fp}"
    if [ ! -f "${FIREFOX_PROFILE}/cookies.sqlite" ]; then
        warn "Firefox profile found at ${FIREFOX_PROFILE} but cookies.sqlite is missing."
        warn "Log in to claude.ai in Firefox first, then re-run this installer."
        FIREFOX_PROFILE=""
    fi
fi

if [ -z "${FIREFOX_PROFILE}" ]; then
    warn "Could not locate a Firefox profile with cookies.sqlite."
    warn "The claudesync function will still be installed, but cookie reading"
    warn "may fail at runtime. Log in to claude.ai in Firefox and re-run if needed."
fi

# Quick smoke-test: can we read the cookie right now?
if [ -n "${FIREFOX_PROFILE}" ]; then
    _test_cookie="$(sqlite3 -readonly "file:${FIREFOX_PROFILE}/cookies.sqlite?immutable=1" \
        "SELECT value FROM moz_cookies WHERE host LIKE '%claude.ai%' AND name='sessionKey' LIMIT 1;" \
        2>/dev/null || true)"
    if [ -z "${_test_cookie}" ]; then
        warn "No sessionKey cookie found for claude.ai in Firefox."
        warn "Make sure you are logged in to claude.ai in Firefox."
    else
        success "Found sessionKey cookie. Firefox auth is ready."
    fi
fi

# ---------------------------------------------------------------------------
# Generate the shell function bodies
# ---------------------------------------------------------------------------

# We embed the profile path at install time as a cached default so the
# function works even without firefox running.  At runtime the function
# re-checks all candidate paths so it stays valid after Firefox upgrades.

# POSIX variant used inside bash/zsh functions (shared logic, no bashisms)
# The function re-discovers the profile at each invocation so it survives
# Firefox profile updates.

BASH_ZSH_FUNCTION='
claudesync() {
  # -- locate Firefox profile --
  local _cs_profile=""
  local _cs_candidates=""
  case "$(uname -s)" in
    Darwin)
      _cs_candidates="${HOME}/Library/Application Support/Firefox/Profiles"
      ;;
    *)
      _cs_candidates="${HOME}/.mozilla/firefox
${HOME}/snap/firefox/common/.mozilla/firefox
${HOME}/.var/app/org.mozilla.firefox/.mozilla/firefox"
      ;;
  esac
  local _cs_base
  while IFS= read -r _cs_base; do
    local _cs_ini="${_cs_base}/profiles.ini"
    if [ -f "${_cs_ini}" ]; then
      local _cs_cur="" _cs_def=0 _cs_found=""
      while IFS= read -r _cs_line; do
        case "${_cs_line}" in
          \[*) [ "${_cs_def}" = "1" ] && [ -n "${_cs_cur}" ] && { _cs_found="${_cs_cur}"; break; }; _cs_def=0; _cs_cur="" ;;
          Default=1*) _cs_def=1 ;;
          Path=*) _cs_cur="${_cs_line#Path=}" ;;
        esac
      done < "${_cs_ini}"
      [ -z "${_cs_found}" ] && [ "${_cs_def}" = "1" ] && _cs_found="${_cs_cur}"
      if [ -n "${_cs_found}" ]; then
        case "${_cs_found}" in
          /*) _cs_profile="${_cs_found}" ;;
          *)  _cs_profile="${_cs_base}/${_cs_found}" ;;
        esac
        [ -d "${_cs_profile}" ] && break
        _cs_profile=""
      fi
    fi
  done <<_CS_EOF
${_cs_candidates}
_CS_EOF

  if [ -z "${_cs_profile}" ] || [ ! -f "${_cs_profile}/cookies.sqlite" ]; then
    echo "claudesync: could not find Firefox cookies.sqlite" >&2
    echo "  Make sure Firefox is installed and you are logged in to claude.ai." >&2
    return 1
  fi

  # -- read sessionKey cookie --
  local _cs_cookie
  _cs_cookie="$(sqlite3 -readonly "file:${_cs_profile}/cookies.sqlite?immutable=1" \
    "SELECT value FROM moz_cookies WHERE host LIKE '"'"'%claude.ai%'"'"' AND name='"'"'sessionKey'"'"' LIMIT 1;" \
    2>/dev/null)"
  if [ -z "${_cs_cookie}" ]; then
    echo "claudesync: sessionKey cookie not found -- are you logged in to claude.ai in Firefox?" >&2
    return 1
  fi

  # -- run container --
  CLAUDE_AI_COOKIE="sessionKey=${_cs_cookie}" \
    docker run --rm \
      -e CLAUDE_AI_COOKIE \
      -v "$(pwd):/data" \
      deathnerd/claudesync:latest \
      "$@"
}
'

FISH_FUNCTION='function claudesync
    # Locate Firefox profile
    set -l _cs_profile ""
    set -l _cs_candidates \
        "$HOME/.mozilla/firefox" \
        "$HOME/snap/firefox/common/.mozilla/firefox" \
        "$HOME/.var/app/org.mozilla.firefox/.mozilla/firefox"
    if test (uname -s) = "Darwin"
        set _cs_candidates "$HOME/Library/Application Support/Firefox/Profiles"
    end

    for _cs_base in $_cs_candidates
        set -l _cs_ini "$_cs_base/profiles.ini"
        if test -f "$_cs_ini"
            set -l _cs_cur ""
            set -l _cs_def 0
            set -l _cs_found ""
            for _cs_line in (cat "$_cs_ini")
                switch "$_cs_line"
                    case "\\[*"
                        if test "$_cs_def" = "1" -a -n "$_cs_cur"
                            set _cs_found "$_cs_cur"
                            break
                        end
                        set _cs_def 0
                        set _cs_cur ""
                    case "Default=1*"
                        set _cs_def 1
                    case "Path=*"
                        set _cs_cur (string replace -r "^Path=" "" -- "$_cs_line")
                end
            end
            if test -z "$_cs_found" -a "$_cs_def" = "1"
                set _cs_found "$_cs_cur"
            end
            if test -n "$_cs_found"
                switch "$_cs_found"
                    case "/*"
                        set _cs_profile "$_cs_found"
                    case "*"
                        set _cs_profile "$_cs_base/$_cs_found"
                end
                if test -d "$_cs_profile"
                    break
                end
                set _cs_profile ""
            end
        end
    end

    if test -z "$_cs_profile" -o ! -f "$_cs_profile/cookies.sqlite"
        echo "claudesync: could not find Firefox cookies.sqlite" >&2
        echo "  Make sure Firefox is installed and you are logged in to claude.ai." >&2
        return 1
    end

    # Read sessionKey cookie
    set -l _cs_cookie (sqlite3 -readonly "file:$_cs_profile/cookies.sqlite?immutable=1" \
        "SELECT value FROM moz_cookies WHERE host LIKE '"'"'%claude.ai%'"'"' AND name='"'"'sessionKey'"'"' LIMIT 1;" 2>/dev/null)

    if test -z "$_cs_cookie"
        echo "claudesync: sessionKey cookie not found -- are you logged in to claude.ai in Firefox?" >&2
        return 1
    end

    # Run container
    CLAUDE_AI_COOKIE="sessionKey=$_cs_cookie" \
        docker run --rm \
            -e CLAUDE_AI_COOKIE \
            -v (pwd)":/data" \
            deathnerd/claudesync:latest \
            $argv
end
'

# ---------------------------------------------------------------------------
# Install into the appropriate shell config
# ---------------------------------------------------------------------------
MARKER="# claudesync -- installed by https://github.com/InfiniteRoomLabs/claudesync"

install_bash_zsh() {
    _rc="$1"
    if grep -qF "claudesync()" "${_rc}" 2>/dev/null; then
        warn "claudesync function already present in ${_rc} -- skipping."
        return 0
    fi
    printf "\n%s\n%s\n" "${MARKER}" "${BASH_ZSH_FUNCTION}" >> "${_rc}"
    success "Installed claudesync function into ${_rc}"
}

install_fish() {
    _fish_dir="${HOME}/.config/fish/functions"
    _fish_file="${_fish_dir}/claudesync.fish"
    if [ -f "${_fish_file}" ]; then
        warn "claudesync.fish already exists at ${_fish_file} -- skipping."
        return 0
    fi
    mkdir -p "${_fish_dir}"
    printf "%s\n%s\n" "${MARKER}" "${FISH_FUNCTION}" > "${_fish_file}"
    success "Installed claudesync function into ${_fish_file}"
}

case "${USER_SHELL}" in
    fish)
        install_fish
        ;;
    zsh)
        install_bash_zsh "${HOME}/.zshrc"
        ;;
    *)
        install_bash_zsh "${HOME}/.bashrc"
        ;;
esac

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
printf "\n%b" "${BOLD}"
printf "  Installation complete!\n"
printf "%b\n" "${RESET}"
printf "  Reload your shell or run:\n"
case "${USER_SHELL}" in
    fish) printf "    source ~/.config/fish/functions/claudesync.fish\n" ;;
    zsh)  printf "    source ~/.zshrc\n" ;;
    *)    printf "    source ~/.bashrc\n" ;;
esac
printf "\n  Then use claudesync as you would the CLI:\n"
printf "    claudesync --help\n"
printf "    claudesync export --org <id> --conversation <id>\n"
printf "\n  Files written by export commands land in the current directory\n"
printf "  (mounted as /data inside the container).\n\n"
