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

# sqlite3 is optional now: cookie reading is handled by rookie (auto-downloaded
# by the broker). sqlite3 is only used as a fallback for the Claude Desktop
# store on Linux. Warn, don't fail.
if ! command -v sqlite3 >/dev/null 2>&1; then
    warn "sqlite3 not found (optional -- only used for the Claude Desktop fallback on Linux)."
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
# Generate the shell function bodies
# ---------------------------------------------------------------------------
# Cookie reading is delegated entirely to the shared broker
# (scripts/lib/harvest-cookie.sh), installed below. The wrapper functions just
# call it and pass the result to Docker. Browser discovery + decryption happen
# at runtime via rookie, so there is no install-time Firefox probing here.

BASH_ZSH_FUNCTION='
claudesync() {
  # -- dependency check --
  if ! command -v docker >/dev/null 2>&1; then
    echo "claudesync: docker is not installed." >&2
    echo "  Install Docker: https://docs.docker.com/get-docker/" >&2
    return 1
  fi

  # -- resolve cookie via the shared broker (rookie-based, host-side) --
  # The broker prints "sessionKey=<value>" on stdout and guidance on stderr.
  local _cs_broker="${XDG_DATA_HOME:-$HOME/.local/share}/claudesync/harvest-cookie.sh"
  if [ ! -f "${_cs_broker}" ]; then
    echo "claudesync: cookie broker missing at ${_cs_broker}" >&2
    echo "  Re-run the installer, or set CLAUDE_AI_COOKIE manually." >&2
    return 1
  fi
  local _cs_cookie_header
  _cs_cookie_header="$(sh "${_cs_broker}")" || return 1
  [ -n "${_cs_cookie_header}" ] || return 1

  # -- run container --
  # Use -it (interactive + TTY) for the tui subcommand so Ink gets raw mode
  local _cs_tty_flag=""
  case "${1:-}" in tui) _cs_tty_flag="-it" ;; esac
  CLAUDE_AI_COOKIE="${_cs_cookie_header}" \
    docker run --rm ${_cs_tty_flag} \
      -e CLAUDE_AI_COOKIE \
      -v "$(pwd):/data" \
      deathnerd/claudesync:latest \
      "$@"
}
'

FISH_FUNCTION='function claudesync
    # -- dependency check --
    if not command -q docker
        echo "claudesync: docker is not installed." >&2
        echo "  Install Docker: https://docs.docker.com/get-docker/" >&2
        return 1
    end

    # -- resolve cookie via the shared broker (rookie-based, host-side) --
    set -l _cs_broker "$HOME/.local/share/claudesync/harvest-cookie.sh"
    if set -q XDG_DATA_HOME; and test -n "$XDG_DATA_HOME"
        set _cs_broker "$XDG_DATA_HOME/claudesync/harvest-cookie.sh"
    end
    if not test -f "$_cs_broker"
        echo "claudesync: cookie broker missing at $_cs_broker" >&2
        echo "  Re-run the installer, or set CLAUDE_AI_COOKIE manually." >&2
        return 1
    end
    set -l _cs_cookie_header (sh "$_cs_broker")
    or return 1
    test -n "$_cs_cookie_header"; or return 1

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

# ---------------------------------------------------------------------------
# Install the shared cookie broker (scripts/lib/harvest-cookie.sh)
# Both the CLI wrapper and the MCP wrapper call this at runtime. It is the
# single source of cookie-resolution logic (rookie-based, host-side).
# ---------------------------------------------------------------------------
install_broker() {
    _broker_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/claudesync"
    _broker_dest="${_broker_dir}/harvest-cookie.sh"
    mkdir -p "${_broker_dir}"

    # Source order: local repo (dev) -> the pulled image (version-locked) ->
    # GitHub raw (fallback for images that predate the bundled scripts).
    _broker_local="${_script_dir}/lib/harvest-cookie.sh"
    if [ -f "${_broker_local}" ]; then
        cp "${_broker_local}" "${_broker_dest}"
        success "Installed cookie broker from local repo into ${_broker_dest}"
    elif _extract_from_image "/opt/claudesync/host/lib/harvest-cookie.sh" "${_broker_dest}"; then
        success "Installed cookie broker from image into ${_broker_dest}"
    else
        warn "FALLBACK: could not source the broker from the local repo or the Docker image."
        warn "  Fetching the LATEST broker from GitHub (main branch) instead --"
        warn "  this may not match your pinned image version."
        _broker_url="https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/lib/harvest-cookie.sh"
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "${_broker_url}" -o "${_broker_dest}" || die "Failed to download cookie broker from ${_broker_url}"
        elif command -v wget >/dev/null 2>&1; then
            wget -qO "${_broker_dest}" "${_broker_url}" || die "Failed to download cookie broker from ${_broker_url}"
        else
            die "Need curl or wget to install the cookie broker."
        fi
        success "Installed cookie broker from GitHub (main) into ${_broker_dest}"
    fi
    chmod +x "${_broker_dest}" 2>/dev/null || true
}

# Copy a file out of the pulled CLI image via a temporary container.
# Args: $1 = path inside image, $2 = destination on host. Returns 1 on failure.
_extract_from_image() {
    _img_path="$1"
    _dest="$2"
    command -v docker >/dev/null 2>&1 || return 1
    _cid="$(docker create deathnerd/claudesync:latest 2>/dev/null)" || return 1
    if docker cp "${_cid}:${_img_path}" "${_dest}" >/dev/null 2>&1; then
        docker rm -f "${_cid}" >/dev/null 2>&1 || true
        [ -f "${_dest}" ]
    else
        docker rm -f "${_cid}" >/dev/null 2>&1 || true
        return 1
    fi
}

install_broker

# Try local repo first, then fall back to downloading from GitHub
# Source order matches the broker: local repo (dev) -> pulled image
# (version-locked) -> GitHub raw (fallback). Everything except this installer
# itself is sourced from the image when running from a curl|sh install.
_get_completion_file() {
    _comp_name="$1"
    _comp_dest="$2"
    _local_src="${_script_dir}/completions/${_comp_name}"
    if [ -f "${_local_src}" ]; then
        cp "${_local_src}" "${_comp_dest}"
        return 0
    fi
    if _extract_from_image "/opt/claudesync/host/completions/${_comp_name}" "${_comp_dest}"; then
        return 0
    fi
    # Download from GitHub
    warn "FALLBACK: fetching completion '${_comp_name}' from GitHub (main) -- may differ from your image version."
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
