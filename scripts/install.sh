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
# Argument parsing
# ---------------------------------------------------------------------------
FORCE=0
for _arg in "$@"; do
    case "${_arg}" in
        --force|-f) FORCE=1 ;;
        *) printf "Unknown argument: %s\n" "${_arg}" >&2; exit 1 ;;
    esac
done

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

# Interactive prompt: returns 0 (yes) or 1 (no).
# When --force is set, always returns 0.
# Args: $1 = prompt message
confirm_replace() {
    if [ "${FORCE}" = "1" ]; then
        return 0
    fi
    printf "%b[claudesync]%b %s [y/N] " "${YELLOW}" "${RESET}" "$1"
    read -r _answer </dev/tty
    case "${_answer}" in
        [Yy]|[Yy][Ee][Ss]) return 0 ;;
        *) return 1 ;;
    esac
}

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
  # -- dependency checks --
  if ! command -v docker >/dev/null 2>&1; then
    echo "claudesync: docker is not installed." >&2
    echo "  Install Docker: https://docs.docker.com/get-docker/" >&2
    return 1
  fi

  # -- resolve cookie (fallback chain) --
  local _cs_cookie_header=""

  # 1. If CLAUDE_AI_COOKIE is already set, use it directly
  if [ -n "${CLAUDE_AI_COOKIE:-}" ]; then
    _cs_cookie_header="${CLAUDE_AI_COOKIE}"
  else
    # Need sqlite3 for browser cookie reading
    if ! command -v sqlite3 >/dev/null 2>&1; then
      echo "claudesync: sqlite3 is not installed (needed to read browser cookies)." >&2
      case "$(uname -s)" in
        Darwin) echo "  Install: brew install sqlite3" >&2 ;;
        *)      echo "  Install: sudo apt install sqlite3  (or your package manager)" >&2 ;;
      esac
      echo "  Or set CLAUDE_AI_COOKIE manually (see below)." >&2
      echo "" >&2
      echo "  Manual method: open claude.ai in your browser, press F12," >&2
      echo "  go to Application > Cookies > claude.ai, copy the sessionKey value, then:" >&2
      echo "    export CLAUDE_AI_COOKIE='"'"'sessionKey=<paste-value-here>'"'"'" >&2
      return 1
    fi

    # 2. Try Firefox
    _cs_cookie_header="$(_cs_try_firefox)"

    # 3. Try Chrome/Chromium (macOS only -- Linux Chrome cookies are encrypted)
    if [ -z "${_cs_cookie_header}" ] && [ "$(uname -s)" = "Darwin" ]; then
      _cs_cookie_header="$(_cs_try_chrome_macos)"
    fi

    # 4. Nothing worked -- guide the user
    if [ -z "${_cs_cookie_header}" ]; then
      echo "claudesync: could not read sessionKey cookie from any browser." >&2
      echo "" >&2
      echo "  Tried:" >&2
      echo "    - Firefox (all known profile paths)" >&2
      [ "$(uname -s)" = "Darwin" ] && echo "    - Chrome (macOS Keychain)" >&2
      echo "" >&2
      echo "  To fix, either:" >&2
      echo "    1. Log in to claude.ai in Firefox and try again" >&2
      echo "    2. Set the cookie manually:" >&2
      echo "       Open claude.ai > F12 > Application > Cookies > sessionKey" >&2
      echo "       export CLAUDE_AI_COOKIE='"'"'sessionKey=<paste-value>'"'"'" >&2
      [ "$(uname -s)" != "Darwin" ] && \
        echo "    3. Chrome users on Linux: pip install pycookiecheat, then:" >&2 && \
        echo "       export CLAUDE_AI_COOKIE=\"sessionKey=\$(python3 -c \"from pycookiecheat import chrome_cookies; c=chrome_cookies('"'"'https://claude.ai'"'"'); print(c.get('"'"'sessionKey'"'"','"'"''"'"'))\" )\"" >&2
      return 1
    fi
  fi

  # -- run container --
  # Use -it (interactive + TTY) for the tui subcommand so Ink gets raw mode
  local _cs_tty_flag=""
  case "$1" in tui) _cs_tty_flag="-it" ;; esac
  CLAUDE_AI_COOKIE="${_cs_cookie_header}" \
    docker run --rm ${_cs_tty_flag} \
      -e CLAUDE_AI_COOKIE \
      -v "$(pwd):/data" \
      deathnerd/claudesync:latest \
      "$@"
}

# -- Firefox cookie reader (returns "sessionKey=<value>" or empty) --
_cs_try_firefox() {
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
    return 0  # not found, return empty
  fi

  local _cs_val
  _cs_val="$(sqlite3 -readonly "file:${_cs_profile}/cookies.sqlite?immutable=1" \
    "SELECT value FROM moz_cookies WHERE host LIKE '"'"'%claude.ai%'"'"' AND name='"'"'sessionKey'"'"' LIMIT 1;" \
    2>/dev/null || true)"
  if [ -n "${_cs_val}" ]; then
    printf "sessionKey=%s" "${_cs_val}"
  fi
}

# -- Chrome cookie reader for macOS (returns "sessionKey=<value>" or empty) --
_cs_try_chrome_macos() {
  local _cs_chrome_db="${HOME}/Library/Application Support/Google/Chrome/Default/Cookies"
  [ -f "${_cs_chrome_db}" ] || return 0

  # Get Chrome Safe Storage key from macOS Keychain
  local _cs_key
  _cs_key="$(security find-generic-password -s "Chrome Safe Storage" -w 2>/dev/null || true)"
  [ -z "${_cs_key}" ] && return 0

  # Chrome cookies are AES-128-CBC encrypted with a PBKDF2-derived key
  # Derive the key: PBKDF2(password=keychain_value, salt="saltysalt", iterations=1003, keylen=16)
  local _cs_derived
  _cs_derived="$(printf "%s" "${_cs_key}" | openssl dgst -sha1 -hmac "saltysalt" 2>/dev/null || true)"
  # Full decryption requires more complex PBKDF2 -- punt to manual method
  # This is a known limitation: Chrome cookie decryption from shell is fragile
  return 0
}
'

FISH_FUNCTION='function claudesync
    # -- dependency checks --
    if not command -q docker
        echo "claudesync: docker is not installed." >&2
        echo "  Install Docker: https://docs.docker.com/get-docker/" >&2
        return 1
    end

    # -- resolve cookie (fallback chain) --
    set -l _cs_cookie_header ""

    # 1. If CLAUDE_AI_COOKIE is already set, use it
    if set -q CLAUDE_AI_COOKIE; and test -n "$CLAUDE_AI_COOKIE"
        set _cs_cookie_header "$CLAUDE_AI_COOKIE"
    else
        # Need sqlite3 for browser cookie reading
        if not command -q sqlite3
            echo "claudesync: sqlite3 is not installed (needed to read browser cookies)." >&2
            if test (uname -s) = "Darwin"
                echo "  Install: brew install sqlite3" >&2
            else
                echo "  Install: sudo apt install sqlite3  (or your package manager)" >&2
            end
            echo "  Or set CLAUDE_AI_COOKIE manually:" >&2
            echo "  Open claude.ai > F12 > Application > Cookies > sessionKey" >&2
            echo "  set -gx CLAUDE_AI_COOKIE '"'"'sessionKey=<paste-value>'"'"'" >&2
            return 1
        end

        # 2. Try Firefox
        set _cs_cookie_header (__claudesync_try_firefox)

        # 3. Nothing worked -- guide the user
        if test -z "$_cs_cookie_header"
            echo "claudesync: could not read sessionKey cookie from any browser." >&2
            echo "" >&2
            echo "  Tried:" >&2
            echo "    - Firefox (all known profile paths)" >&2
            echo "" >&2
            echo "  To fix, either:" >&2
            echo "    1. Log in to claude.ai in Firefox and try again" >&2
            echo "    2. Set the cookie manually:" >&2
            echo "       Open claude.ai > F12 > Application > Cookies > sessionKey" >&2
            echo "       set -gx CLAUDE_AI_COOKIE '"'"'sessionKey=<paste-value>'"'"'" >&2
            if test (uname -s) != "Darwin"
                echo "    3. Chrome users on Linux: pip install pycookiecheat, then:" >&2
                echo "       set -gx CLAUDE_AI_COOKIE (python3 -c \"from pycookiecheat import chrome_cookies; c=chrome_cookies('"'"'https://claude.ai'"'"'); print('"'"'sessionKey='"'"'+c.get('"'"'sessionKey'"'"','"'"''"'"'))\")" >&2
            end
            return 1
        end
    end

    # -- run container --
    # Use -it for the tui subcommand so Ink gets raw mode
    set -l _cs_tty_flag
    if test (count $argv) -ge 1; and test "$argv[1]" = "tui"
        set _cs_tty_flag -it
    end
    CLAUDE_AI_COOKIE="$_cs_cookie_header" \
        docker run --rm $_cs_tty_flag \
            -e CLAUDE_AI_COOKIE \
            -v (pwd)":/data" \
            deathnerd/claudesync:latest \
            $argv
end

# -- Firefox cookie reader helper --
function __claudesync_try_firefox
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
        return 0
    end

    set -l _cs_val (sqlite3 -readonly "file:$_cs_profile/cookies.sqlite?immutable=1" \
        "SELECT value FROM moz_cookies WHERE host LIKE '"'"'%claude.ai%'"'"' AND name='"'"'sessionKey'"'"' LIMIT 1;" 2>/dev/null; or true)

    if test -n "$_cs_val"
        echo "sessionKey=$_cs_val"
    end
end
'

# ---------------------------------------------------------------------------
# Install into the appropriate shell config
# ---------------------------------------------------------------------------
MARKER="# claudesync -- installed by https://github.com/InfiniteRoomLabs/claudesync"

install_bash_zsh() {
    _rc="$1"
    if grep -qF "claudesync()" "${_rc}" 2>/dev/null; then
        if confirm_replace "Replace existing claudesync function in ${_rc}?"; then
            # Remove old installation: everything from the marker line through
            # the function body. We delete from the marker to the next blank
            # line after a closing brace, which covers the full function block.
            _tmp_rc="${_rc}.claudesync.tmp"
            awk -v marker="${MARKER}" '
                BEGIN { skip=0 }
                $0 == marker { skip=1; next }
                skip && /^[[:space:]]*$/ && saw_brace { skip=0; next }
                skip && /^}/ { saw_brace=1; next }
                skip { next }
                { print }
            ' "${_rc}" > "${_tmp_rc}" && mv "${_tmp_rc}" "${_rc}"
            info "Removed old claudesync function from ${_rc}"
        else
            warn "Skipping -- existing installation in ${_rc} left unchanged."
            return 0
        fi
    fi
    printf "\n%s\n%s\n" "${MARKER}" "${BASH_ZSH_FUNCTION}" >> "${_rc}"
    success "Installed claudesync function into ${_rc}"
}

install_fish() {
    _fish_dir="${HOME}/.config/fish/functions"
    _fish_file="${_fish_dir}/claudesync.fish"
    _fish_helper="${_fish_dir}/__claudesync_try_firefox.fish"
    if [ -f "${_fish_file}" ]; then
        if confirm_replace "Replace existing ${_fish_file}?"; then
            rm -f "${_fish_file}" "${_fish_helper}"
            info "Removed old fish function files."
        else
            warn "Skipping -- existing installation at ${_fish_file} left unchanged."
            return 0
        fi
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
# Install shell completions
# ---------------------------------------------------------------------------

# URL base for downloading completion scripts (or local path when running from repo)
_script_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"

# Try local repo first, then fall back to downloading from GitHub
_get_completion_file() {
    _comp_name="$1"
    _comp_dest="$2"
    _local_src="${_script_dir}/completions/${_comp_name}"
    if [ -f "${_local_src}" ]; then
        cp "${_local_src}" "${_comp_dest}"
        return 0
    fi
    # Download from GitHub
    _url="https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/completions/${_comp_name}"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "${_url}" -o "${_comp_dest}" 2>/dev/null && return 0
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "${_comp_dest}" "${_url}" 2>/dev/null && return 0
    fi
    warn "Could not download completion file: ${_comp_name}"
    return 1
}

COMPLETION_MARKER="# claudesync completions"

install_bash_completions() {
    _comp_dir="${HOME}/.local/share/claudesync/completions"
    _comp_file="${_comp_dir}/claudesync.bash"
    mkdir -p "${_comp_dir}"

    if _get_completion_file "claudesync.bash" "${_comp_file}"; then
        _rc="$1"
        _source_line="source ${_comp_file}  ${COMPLETION_MARKER}"
        if ! grep -qF "${COMPLETION_MARKER}" "${_rc}" 2>/dev/null; then
            printf "\n%s\n" "${_source_line}" >> "${_rc}"
            success "Installed bash completions into ${_rc}"
        else
            info "Completion sourcing already present in ${_rc}"
        fi
    fi
}

install_zsh_completions() {
    _comp_dir="${HOME}/.local/share/claudesync/completions"
    _comp_file="${_comp_dir}/_claudesync"
    mkdir -p "${_comp_dir}"

    if _get_completion_file "claudesync.zsh" "${_comp_file}"; then
        _rc="${HOME}/.zshrc"
        _fpath_line="fpath=(${_comp_dir} \$fpath)  ${COMPLETION_MARKER}"
        if ! grep -qF "${COMPLETION_MARKER}" "${_rc}" 2>/dev/null; then
            # Insert fpath line before any compinit call, or append to end
            if grep -qF "compinit" "${_rc}" 2>/dev/null; then
                _tmp_rc="${_rc}.claudesync-comp.tmp"
                awk -v line="${_fpath_line}" '
                    !inserted && /compinit/ { print line; inserted=1 }
                    { print }
                ' "${_rc}" > "${_tmp_rc}" && mv "${_tmp_rc}" "${_rc}"
            else
                printf "\n%s\nautoload -Uz compinit && compinit  %s\n" "${_fpath_line}" "${COMPLETION_MARKER}" >> "${_rc}"
            fi
            success "Installed zsh completions into ${_rc}"
        else
            info "Completion sourcing already present in ${_rc}"
        fi
    fi
}

install_fish_completions() {
    _fish_comp_dir="${HOME}/.config/fish/completions"
    mkdir -p "${_fish_comp_dir}"

    if _get_completion_file "claudesync.fish" "${_fish_comp_dir}/claudesync.fish"; then
        success "Installed fish completions into ${_fish_comp_dir}/claudesync.fish"
    fi
}

info "Installing shell completions..."
case "${USER_SHELL}" in
    fish)
        install_fish_completions
        ;;
    zsh)
        install_zsh_completions
        ;;
    *)
        install_bash_completions "${HOME}/.bashrc"
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
printf "\n  Shell completions have been installed. Press <TAB> to complete\n"
printf "  subcommands and flags.\n"
printf "\n  Files written by export commands land in the current directory\n"
printf "  (mounted as /data inside the container).\n\n"
