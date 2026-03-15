#!/bin/sh
# ClaudeSync uninstaller
# Removes shell functions, wrapper scripts, and optionally Docker images.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/uninstall.sh | sh
#   ./scripts/uninstall.sh
#   ./scripts/uninstall.sh --force    # skip all prompts
#
# POSIX-compatible.

set -eu

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
FORCE=0
for _arg in "$@"; do
    case "${_arg}" in
        --force|-f) FORCE=1 ;;
        -h|--help)
            printf "Usage: %s [--force|-f]\n" "$0"
            printf "  --force, -f   Skip all interactive prompts (answer yes to everything)\n"
            exit 0
            ;;
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

info()    { printf "%b[claudesync]%b %s\n" "${CYAN}"   "${RESET}" "$*"; }
success() { printf "%b[claudesync]%b %s\n" "${GREEN}"  "${RESET}" "$*"; }
warn()    { printf "%b[claudesync]%b %s\n" "${YELLOW}" "${RESET}" "$*"; }
error()   { printf "%b[claudesync]%b %s\n" "${RED}"    "${RESET}" "$*" >&2; }

# Interactive prompt: returns 0 (yes) or 1 (no).
# When --force is set, always returns 0.
# Args: $1 = prompt message
confirm() {
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
printf "  ClaudeSync -- uninstaller\n"
printf "  https://github.com/InfiniteRoomLabs/claudesync\n"
printf "%b\n" "${RESET}"

# ---------------------------------------------------------------------------
# Detect shell
# ---------------------------------------------------------------------------
detect_shell() {
    _shell="${SHELL:-}"
    case "${_shell}" in
        */fish) echo "fish"; return ;;
        */zsh)  echo "zsh";  return ;;
        */bash) echo "bash"; return ;;
    esac
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

# Track what was removed for the summary.
REMOVED=""

# ---------------------------------------------------------------------------
# Marker used by the installer
# ---------------------------------------------------------------------------
MARKER="# claudesync -- installed by https://github.com/InfiniteRoomLabs/claudesync"

# ---------------------------------------------------------------------------
# Remove shell function from rc files
# ---------------------------------------------------------------------------

# Remove the claudesync function block from a bash/zsh rc file.
# The block starts at the MARKER line and ends after the closing `}` of the
# last function definition (followed by an optional blank line).
remove_from_rc() {
    _rc="$1"
    if [ ! -f "${_rc}" ]; then
        info "No ${_rc} found -- nothing to remove."
        return 0
    fi
    if ! grep -qF "claudesync()" "${_rc}" 2>/dev/null; then
        info "No claudesync function in ${_rc} -- nothing to remove."
        return 0
    fi

    _tmp_rc="${_rc}.claudesync-uninstall.tmp"
    # Remove everything from the marker line through the end of the function
    # block. The block contains multiple functions (claudesync, _cs_try_firefox,
    # _cs_try_chrome_macos) separated by blank lines. We skip until we hit a
    # non-blank line that is NOT part of the installed block (i.e., after we've
    # passed the trailing single-quote that closes the heredoc variable).
    awk -v marker="${MARKER}" '
        BEGIN { skip=0 }
        $0 == marker { skip=1; next }
        skip { next }
        { print }
    ' "${_rc}" > "${_tmp_rc}" && mv "${_tmp_rc}" "${_rc}"
    success "Removed claudesync function from ${_rc}"
    REMOVED="${REMOVED}  - claudesync function from ${_rc}\n"
}

remove_fish_functions() {
    _fish_dir="${HOME}/.config/fish/functions"
    _removed_any=0
    for _fish_file in \
        "${_fish_dir}/claudesync.fish" \
        "${_fish_dir}/__claudesync_try_firefox.fish"; do
        if [ -f "${_fish_file}" ]; then
            rm -f "${_fish_file}"
            success "Removed ${_fish_file}"
            REMOVED="${REMOVED}  - ${_fish_file}\n"
            _removed_any=1
        fi
    done
    if [ "${_removed_any}" = "0" ]; then
        info "No fish function files found -- nothing to remove."
    fi
}

case "${USER_SHELL}" in
    fish)
        remove_fish_functions
        ;;
    zsh)
        remove_from_rc "${HOME}/.zshrc"
        ;;
    *)
        remove_from_rc "${HOME}/.bashrc"
        ;;
esac

# Also check other shells the user might have installed into.
# (The installer only installs for the detected shell, but be thorough.)
case "${USER_SHELL}" in
    bash)
        if grep -qF "claudesync()" "${HOME}/.zshrc" 2>/dev/null; then
            info "Also found claudesync in ~/.zshrc (non-primary shell)."
            remove_from_rc "${HOME}/.zshrc"
        fi
        ;;
    zsh)
        if grep -qF "claudesync()" "${HOME}/.bashrc" 2>/dev/null; then
            info "Also found claudesync in ~/.bashrc (non-primary shell)."
            remove_from_rc "${HOME}/.bashrc"
        fi
        ;;
esac

# ---------------------------------------------------------------------------
# Remove shell completion files
# ---------------------------------------------------------------------------
COMPLETION_MARKER="# claudesync completions"

remove_bash_completions() {
    _comp_dir="${HOME}/.local/share/claudesync/completions"
    if [ -d "${_comp_dir}" ]; then
        rm -rf "${_comp_dir}"
        success "Removed completions directory: ${_comp_dir}"
        REMOVED="${REMOVED}  - ${_comp_dir}\n"
    fi

    # Remove the parent directory if empty
    _parent="${HOME}/.local/share/claudesync"
    if [ -d "${_parent}" ]; then
        rmdir "${_parent}" 2>/dev/null && \
            success "Removed empty directory: ${_parent}" || true
    fi

    # Remove the source line from .bashrc
    _rc="${HOME}/.bashrc"
    if grep -qF "${COMPLETION_MARKER}" "${_rc}" 2>/dev/null; then
        _tmp_rc="${_rc}.claudesync-comp.tmp"
        grep -vF "${COMPLETION_MARKER}" "${_rc}" > "${_tmp_rc}" && mv "${_tmp_rc}" "${_rc}"
        success "Removed completion sourcing from ${_rc}"
        REMOVED="${REMOVED}  - completion source line from ${_rc}\n"
    fi
}

remove_zsh_completions() {
    _comp_dir="${HOME}/.local/share/claudesync/completions"
    if [ -d "${_comp_dir}" ]; then
        rm -rf "${_comp_dir}"
        success "Removed completions directory: ${_comp_dir}"
        REMOVED="${REMOVED}  - ${_comp_dir}\n"
    fi

    # Remove the parent directory if empty
    _parent="${HOME}/.local/share/claudesync"
    if [ -d "${_parent}" ]; then
        rmdir "${_parent}" 2>/dev/null && \
            success "Removed empty directory: ${_parent}" || true
    fi

    # Remove the fpath/compinit lines from .zshrc
    _rc="${HOME}/.zshrc"
    if grep -qF "${COMPLETION_MARKER}" "${_rc}" 2>/dev/null; then
        _tmp_rc="${_rc}.claudesync-comp.tmp"
        grep -vF "${COMPLETION_MARKER}" "${_rc}" > "${_tmp_rc}" && mv "${_tmp_rc}" "${_rc}"
        success "Removed completion sourcing from ${_rc}"
        REMOVED="${REMOVED}  - completion lines from ${_rc}\n"
    fi
}

remove_fish_completions() {
    _fish_comp="${HOME}/.config/fish/completions/claudesync.fish"
    if [ -f "${_fish_comp}" ]; then
        rm -f "${_fish_comp}"
        success "Removed ${_fish_comp}"
        REMOVED="${REMOVED}  - ${_fish_comp}\n"
    fi
}

info "Removing shell completions..."
case "${USER_SHELL}" in
    fish)
        remove_fish_completions
        ;;
    zsh)
        remove_zsh_completions
        ;;
    *)
        remove_bash_completions
        ;;
esac

# Also check non-primary shells
case "${USER_SHELL}" in
    bash)
        remove_fish_completions
        remove_zsh_completions
        ;;
    zsh)
        remove_fish_completions
        remove_bash_completions
        ;;
    fish)
        remove_bash_completions
        remove_zsh_completions
        ;;
esac

# ---------------------------------------------------------------------------
# Remove MCP wrapper script
# ---------------------------------------------------------------------------
WRAPPER_PATH="${HOME}/.local/bin/claudesync-mcp"

if [ -f "${WRAPPER_PATH}" ]; then
    rm -f "${WRAPPER_PATH}"
    success "Removed MCP wrapper: ${WRAPPER_PATH}"
    REMOVED="${REMOVED}  - ${WRAPPER_PATH}\n"
else
    info "No MCP wrapper at ${WRAPPER_PATH} -- nothing to remove."
fi

# ---------------------------------------------------------------------------
# Optionally remove Docker images
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
    _has_cli_image=0
    _has_mcp_image=0
    docker image inspect deathnerd/claudesync:latest >/dev/null 2>&1 && _has_cli_image=1
    docker image inspect deathnerd/claudesync-mcp:latest >/dev/null 2>&1 && _has_mcp_image=1

    if [ "${_has_cli_image}" = "1" ] || [ "${_has_mcp_image}" = "1" ]; then
        if confirm "Remove Docker images (deathnerd/claudesync, deathnerd/claudesync-mcp)?"; then
            if [ "${_has_cli_image}" = "1" ]; then
                docker rmi deathnerd/claudesync:latest 2>/dev/null && \
                    success "Removed Docker image: deathnerd/claudesync:latest" && \
                    REMOVED="${REMOVED}  - Docker image: deathnerd/claudesync:latest\n" || \
                    warn "Could not remove deathnerd/claudesync:latest (may be in use)."
            fi
            if [ "${_has_mcp_image}" = "1" ]; then
                docker rmi deathnerd/claudesync-mcp:latest 2>/dev/null && \
                    success "Removed Docker image: deathnerd/claudesync-mcp:latest" && \
                    REMOVED="${REMOVED}  - Docker image: deathnerd/claudesync-mcp:latest\n" || \
                    warn "Could not remove deathnerd/claudesync-mcp:latest (may be in use)."
            fi
        else
            info "Keeping Docker images."
        fi
    else
        info "No ClaudeSync Docker images found."
    fi
else
    info "Docker not installed -- skipping image cleanup."
fi

# ---------------------------------------------------------------------------
# MCP config file advisory (NOT auto-edited)
# ---------------------------------------------------------------------------
_mcp_configs=""
_check_mcp_config() {
    if [ -f "$1" ] && grep -q '"claudesync"' "$1" 2>/dev/null; then
        _mcp_configs="${_mcp_configs}  - $1\n"
    fi
}

_check_mcp_config "${HOME}/.claude.json"
_check_mcp_config "$(pwd)/.mcp.json"
case "$(uname -s)" in
    Darwin)
        _check_mcp_config "${HOME}/Library/Application Support/Claude/claude_desktop_config.json"
        ;;
    *)
        _check_mcp_config "${HOME}/.config/Claude/claude_desktop_config.json"
        ;;
esac

if [ -n "${_mcp_configs}" ]; then
    printf "\n"
    warn "The following MCP config files still reference claudesync:"
    printf "%b" "${_mcp_configs}"
    printf "\n"
    info "To remove manually, open each file and delete the \"claudesync\" entry"
    info "from the \"mcpServers\" object. Example:"
    info "  jq 'del(.mcpServers.claudesync)' ~/.claude.json > tmp && mv tmp ~/.claude.json"
    printf "\n"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf "\n%b" "${BOLD}"
printf "  Uninstall complete.\n"
printf "%b\n" "${RESET}"

if [ -n "${REMOVED}" ]; then
    printf "  Removed:\n"
    printf "%b" "${REMOVED}"
else
    printf "  Nothing was removed -- ClaudeSync does not appear to be installed.\n"
fi

printf "\n  Reload your shell to pick up the changes:\n"
case "${USER_SHELL}" in
    fish) printf "    exec fish\n" ;;
    zsh)  printf "    exec zsh\n" ;;
    *)    printf "    exec bash\n" ;;
esac
printf "\n"
