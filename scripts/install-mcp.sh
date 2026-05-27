#!/bin/sh
# ClaudeSync MCP installer
# Configures the ClaudeSync MCP server for Claude Code, Claude Desktop, or a project .mcp.json.
#
# Usage:
#   ./scripts/install-mcp.sh
#   ./scripts/install-mcp.sh --target claude-code
#   ./scripts/install-mcp.sh --target claude-desktop
#   ./scripts/install-mcp.sh --target mcp-json
#
# Dependencies: sh, sqlite3, docker, optionally jq
# POSIX-compatible.

set -eu

# ---------------------------------------------------------------------------
# Terminal color helpers
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

info()    { printf "%b[claudesync-mcp]%b %s\n" "${CYAN}"   "${RESET}" "$*"; }
success() { printf "%b[claudesync-mcp]%b %s\n" "${GREEN}"  "${RESET}" "$*"; }
warn()    { printf "%b[claudesync-mcp]%b %s\n" "${YELLOW}" "${RESET}" "$*"; }
error()   { printf "%b[claudesync-mcp]%b %s\n" "${RED}"    "${RESET}" "$*" >&2; }
die()     { error "$*"; exit 1; }

# Interactive prompt: returns 0 (yes) or 1 (no).
# When --force is set, always returns 0.
# Args: $1 = prompt message
confirm_replace() {
    if [ "${FORCE}" = "1" ]; then
        return 0
    fi
    printf "%b[claudesync-mcp]%b %s [y/N] " "${YELLOW}" "${RESET}" "$1"
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
printf "  ClaudeSync MCP Server installer\n"
printf "  https://github.com/InfiniteRoomLabs/claudesync\n"
printf "%b\n" "${RESET}"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
TARGET=""
FORCE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --target)
            shift
            TARGET="${1:-}"
            ;;
        --target=*)
            TARGET="${1#--target=}"
            ;;
        --force|-f)
            FORCE=1
            ;;
        -h|--help)
            printf "Usage: %s [--target claude-code|claude-desktop|mcp-json] [--force|-f]\n" "$0"
            exit 0
            ;;
        *)
            die "Unknown argument: $1  (use --help for usage)"
            ;;
    esac
    shift
done

# Validate target if provided.
case "${TARGET}" in
    ""|claude-code|claude-desktop|mcp-json) ;;
    *) die "Invalid --target '${TARGET}'. Must be: claude-code, claude-desktop, or mcp-json." ;;
esac

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    die "Docker is not installed or not on PATH. Install Docker first: https://docs.docker.com/get-docker/"
fi

# sqlite3 is optional now (cookie reading is handled by rookie via the broker;
# sqlite3 is only a Claude-Desktop-on-Linux fallback).
if ! command -v sqlite3 >/dev/null 2>&1; then
    warn "sqlite3 not found (optional -- only used for the Claude Desktop fallback on Linux)."
fi

JQ_AVAILABLE=0
if command -v jq >/dev/null 2>&1; then
    JQ_AVAILABLE=1
fi

info "Checking Docker image deathnerd/claudesync-mcp:latest ..."
if ! docker image inspect deathnerd/claudesync-mcp:latest >/dev/null 2>&1; then
    info "Image not found locally -- pulling from Docker Hub ..."
    docker pull deathnerd/claudesync-mcp:latest || die "Failed to pull deathnerd/claudesync-mcp:latest. Check your internet connection and Docker login."
fi
success "Docker image ready."

# ---------------------------------------------------------------------------
# Install the shared cookie broker (scripts/lib/harvest-cookie.sh)
# The generated wrapper calls this at runtime. Same broker the CLI uses.
# Source order: local repo (dev) -> pulled MCP image (version-locked) -> GitHub.
# ---------------------------------------------------------------------------
_script_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"

_extract_from_image() {
    _img_path="$1"
    _dest="$2"
    command -v docker >/dev/null 2>&1 || return 1
    _cid="$(docker create deathnerd/claudesync-mcp:latest 2>/dev/null)" || return 1
    if docker cp "${_cid}:${_img_path}" "${_dest}" >/dev/null 2>&1; then
        docker rm -f "${_cid}" >/dev/null 2>&1 || true
        [ -f "${_dest}" ]
    else
        docker rm -f "${_cid}" >/dev/null 2>&1 || true
        return 1
    fi
}

install_broker() {
    _broker_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/claudesync"
    BROKER_PATH="${_broker_dir}/harvest-cookie.sh"
    mkdir -p "${_broker_dir}"

    _broker_local="${_script_dir}/lib/harvest-cookie.sh"
    if [ -f "${_broker_local}" ]; then
        cp "${_broker_local}" "${BROKER_PATH}"
        success "Installed cookie broker from local repo into ${BROKER_PATH}"
    elif _extract_from_image "/opt/claudesync/host/lib/harvest-cookie.sh" "${BROKER_PATH}"; then
        success "Installed cookie broker from image into ${BROKER_PATH}"
    else
        warn "FALLBACK: could not source the broker from the local repo or the Docker image."
        warn "  Fetching the LATEST broker from GitHub (main branch) instead --"
        warn "  this may not match your pinned image version."
        _broker_url="https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/lib/harvest-cookie.sh"
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL "${_broker_url}" -o "${BROKER_PATH}" || die "Failed to download cookie broker from ${_broker_url}"
        elif command -v wget >/dev/null 2>&1; then
            wget -qO "${BROKER_PATH}" "${_broker_url}" || die "Failed to download cookie broker from ${_broker_url}"
        else
            die "Need curl or wget to install the cookie broker."
        fi
        success "Installed cookie broker from GitHub (main) into ${BROKER_PATH}"
    fi
    chmod +x "${BROKER_PATH}" 2>/dev/null || true
}

install_broker

# ---------------------------------------------------------------------------
# Create the wrapper script at ~/.local/bin/claudesync-mcp
# The wrapper reads the Firefox cookie fresh at each invocation and execs
# the MCP container. Claude Code/Desktop invokes this via stdio.
# ---------------------------------------------------------------------------
WRAPPER_DIR="${HOME}/.local/bin"
WRAPPER_PATH="${WRAPPER_DIR}/claudesync-mcp"

create_wrapper() {
    if [ -f "${WRAPPER_PATH}" ]; then
        if confirm_replace "Replace existing wrapper at ${WRAPPER_PATH}?"; then
            rm -f "${WRAPPER_PATH}"
            info "Removed old wrapper script."
        else
            warn "Skipping -- existing wrapper at ${WRAPPER_PATH} left unchanged."
            return 0
        fi
    fi

    mkdir -p "${WRAPPER_DIR}"

    # The wrapper delegates cookie resolution to the shared broker (installed
    # above) and execs the MCP container. The broker path is embedded at
    # install time. Guidance from the broker lands on stderr, which is safe for
    # the JSON-RPC stdio transport (stdout stays clean).
    cat > "${WRAPPER_PATH}" << WRAPPER_EOF
#!/bin/sh
# claudesync-mcp wrapper -- resolves the cookie via the shared broker, then
# runs the MCP container. Installed by: https://github.com/InfiniteRoomLabs/claudesync
set -eu

_mcp_error() {
  printf '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"claudesync-mcp: %s"}}' "\$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || _mcp_error "docker not found. Install Docker: https://docs.docker.com/get-docker/"

_cs_broker="${BROKER_PATH}"
[ -f "\${_cs_broker}" ] || _mcp_error "cookie broker missing at \${_cs_broker}; re-run install-mcp.sh"

_cs_cookie_header="\$(sh "\${_cs_broker}" 2>/dev/null)" || _mcp_error "Could not read sessionKey cookie. Log in to claude.ai in a browser, or set CLAUDE_AI_COOKIE='sessionKey=<value>'."
[ -n "\${_cs_cookie_header}" ] || _mcp_error "Could not read sessionKey cookie. Log in to claude.ai in a browser, or set CLAUDE_AI_COOKIE='sessionKey=<value>'."

exec docker run --rm -i \\
  -e "CLAUDE_AI_COOKIE=\${_cs_cookie_header}" \\
  deathnerd/claudesync-mcp:latest
WRAPPER_EOF

    chmod +x "${WRAPPER_PATH}"
    success "Wrapper script installed at ${WRAPPER_PATH}"
}

create_wrapper

# Make sure ~/.local/bin is on PATH and mention it if it isn't.
case ":${PATH}:" in
    *":${WRAPPER_DIR}:"*) ;;
    *)
        warn "${WRAPPER_DIR} is not on your PATH."
        warn "Add it to your shell config, e.g.:"
        warn "  fish: fish_add_path ${WRAPPER_DIR}"
        warn "  bash/zsh: export PATH=\"\$PATH:${WRAPPER_DIR}\""
        ;;
esac

# ---------------------------------------------------------------------------
# JSON merge helpers (jq-first, sed-fallback for simple cases)
# ---------------------------------------------------------------------------

# Merge a top-level key into a JSON file's "mcpServers" object.
# Args: $1=file, $2=server_name, $3=json_config_block
merge_mcp_server_jq() {
    _file="$1"
    _name="$2"
    _block="$3"
    _tmp="${_file}.claudesync.tmp"
    jq --arg name "${_name}" --argjson block "${_block}" \
        '.mcpServers[$name] = $block' \
        "${_file}" > "${_tmp}" && mv "${_tmp}" "${_file}"
}

# Minimal sed-based approach when jq is unavailable.
# Creates the file if it doesn't exist; merges if it does.
# Assumes the file contains a valid JSON object at the top level.
# For complex existing configs this may produce slightly off formatting,
# but it is structurally correct JSON that jq/Claude can parse.
merge_mcp_server_sed() {
    _file="$1"
    _name="$2"
    _block="$3"
    _entry="    \"${_name}\": ${_block}"

    if [ ! -f "${_file}" ] || [ ! -s "${_file}" ]; then
        printf '{\n  "mcpServers": {\n%s\n  }\n}\n' "${_entry}" > "${_file}"
        return 0
    fi

    # Check if mcpServers key exists.
    if grep -q '"mcpServers"' "${_file}" 2>/dev/null; then
        # Check if the server is already there.
        if grep -q "\"${_name}\"" "${_file}" 2>/dev/null; then
            warn "  Entry '${_name}' already present in ${_file} -- skipping."
            return 0
        fi
        # Insert after the opening brace of mcpServers.
        # This is fragile on complex JSON but works for canonical Claude configs.
        _tmp="${_file}.claudesync.tmp"
        awk -v entry="${_entry}" '
            /\"mcpServers\"[[:space:]]*:[[:space:]]*\{/ {
                print
                print entry ","
                next
            }
            { print }
        ' "${_file}" > "${_tmp}" && mv "${_tmp}" "${_file}"
    else
        # No mcpServers key -- insert before final closing brace.
        _tmp="${_file}.claudesync.tmp"
        awk -v entry="${_entry}" '
            /^[[:space:]]*\}[[:space:]]*$/ && !done {
                print "  \"mcpServers\": {"
                print entry
                print "  },"
                done=1
            }
            { print }
        ' "${_file}" > "${_tmp}" && mv "${_tmp}" "${_file}"
    fi
}

merge_mcp_server() {
    _file="$1"
    _name="$2"
    _block="$3"
    if [ "${JQ_AVAILABLE}" = "1" ]; then
        merge_mcp_server_jq "${_file}" "${_name}" "${_block}"
    else
        merge_mcp_server_sed "${_file}" "${_name}" "${_block}"
    fi
}

# MCP config block referencing the wrapper script.
mcp_config_block() {
    printf '{"command":"%s","args":[]}' "${WRAPPER_PATH}"
}

# ---------------------------------------------------------------------------
# Installation targets
# ---------------------------------------------------------------------------

install_claude_code() {
    printf "\n  Install scope:\n"
    printf "    1) Global (user-level) -- ~/.claude.json\n"
    printf "    2) Project (current directory) -- .mcp.json\n"
    printf "\n  Enter choice [1/2]: "
    read -r _scope </dev/tty
    case "${_scope}" in
        2)
            _target_file="$(pwd)/.mcp.json"
            info "Writing to project .mcp.json: ${_target_file}"
            ;;
        *)
            _target_file="${HOME}/.claude.json"
            info "Writing to global config: ${_target_file}"
            ;;
    esac

    if [ ! -f "${_target_file}" ]; then
        printf '{"mcpServers":{}}\n' > "${_target_file}"
    fi

    if grep -q '"claudesync"' "${_target_file}" 2>/dev/null; then
        if confirm_replace "Replace existing claudesync entry in ${_target_file}?"; then
            if [ "${JQ_AVAILABLE}" = "1" ]; then
                _tmp="${_target_file}.claudesync.tmp"
                jq 'del(.mcpServers.claudesync)' "${_target_file}" > "${_tmp}" && mv "${_tmp}" "${_target_file}"
            fi
            merge_mcp_server "${_target_file}" "claudesync" "$(mcp_config_block)"
            success "MCP server entry replaced in ${_target_file}"
        else
            warn "Skipping -- existing entry in ${_target_file} left unchanged."
        fi
    else
        merge_mcp_server "${_target_file}" "claudesync" "$(mcp_config_block)"
        success "MCP server entry written to ${_target_file}"
    fi

    printf "\n  To verify in Claude Code, run:\n"
    printf "    /mcp\n"
    printf "  and look for 'claudesync' in the server list.\n\n"
}

install_claude_desktop() {
    case "$(uname -s)" in
        Darwin)
            _config_file="${HOME}/Library/Application Support/Claude/claude_desktop_config.json"
            ;;
        *)
            _config_file="${HOME}/.config/Claude/claude_desktop_config.json"
            ;;
    esac
    _config_dir="$(dirname "${_config_file}")"

    info "Target config: ${_config_file}"
    mkdir -p "${_config_dir}"

    if [ ! -f "${_config_file}" ]; then
        printf '{"mcpServers":{}}\n' > "${_config_file}"
    fi

    if grep -q '"claudesync"' "${_config_file}" 2>/dev/null; then
        if confirm_replace "Replace existing claudesync entry in ${_config_file}?"; then
            if [ "${JQ_AVAILABLE}" = "1" ]; then
                _tmp="${_config_file}.claudesync.tmp"
                jq 'del(.mcpServers.claudesync)' "${_config_file}" > "${_tmp}" && mv "${_tmp}" "${_config_file}"
            fi
            merge_mcp_server "${_config_file}" "claudesync" "$(mcp_config_block)"
            success "MCP server entry replaced in ${_config_file}"
        else
            warn "Skipping -- existing entry in ${_config_file} left unchanged."
        fi
    else
        merge_mcp_server "${_config_file}" "claudesync" "$(mcp_config_block)"
        success "MCP server entry written to ${_config_file}"
    fi

    printf "\n  Restart Claude Desktop and look for the hammer icon (MCP tools).\n"
    printf "  The claudesync tools will appear when a conversation starts.\n\n"
}

install_mcp_json() {
    _mcp_file="$(pwd)/.mcp.json"
    info "Target file: ${_mcp_file}"

    if [ ! -f "${_mcp_file}" ]; then
        printf '{"mcpServers":{}}\n' > "${_mcp_file}"
    fi

    if grep -q '"claudesync"' "${_mcp_file}" 2>/dev/null; then
        if confirm_replace "Replace existing claudesync entry in ${_mcp_file}?"; then
            if [ "${JQ_AVAILABLE}" = "1" ]; then
                _tmp="${_mcp_file}.claudesync.tmp"
                jq 'del(.mcpServers.claudesync)' "${_mcp_file}" > "${_tmp}" && mv "${_tmp}" "${_mcp_file}"
            fi
            merge_mcp_server "${_mcp_file}" "claudesync" "$(mcp_config_block)"
            success "MCP server entry replaced in ${_mcp_file}"
        else
            warn "Skipping -- existing entry in ${_mcp_file} left unchanged."
        fi
    else
        merge_mcp_server "${_mcp_file}" "claudesync" "$(mcp_config_block)"
        success "MCP server entry written to ${_mcp_file}"
    fi

    printf "\n  Commit .mcp.json to share this configuration with your team.\n"
    printf "  Each team member must have claudesync-mcp installed locally.\n\n"
}

# ---------------------------------------------------------------------------
# Interactive target selection (when --target not provided)
# ---------------------------------------------------------------------------
select_target() {
    printf "\n  Where do you want to configure ClaudeSync MCP?\n\n"
    printf "    1) Claude Code  (global or project-level)\n"
    printf "    2) Claude Desktop\n"
    printf "    3) Project .mcp.json  (current directory)\n"
    printf "\n  Enter choice [1-3]: "
    read -r _choice </dev/tty
    case "${_choice}" in
        1) echo "claude-code" ;;
        2) echo "claude-desktop" ;;
        3) echo "mcp-json" ;;
        *)
            warn "Invalid choice '${_choice}'. Defaulting to project .mcp.json."
            echo "mcp-json"
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
if [ -z "${TARGET}" ]; then
    TARGET="$(select_target)"
fi

case "${TARGET}" in
    claude-code)    install_claude_code ;;
    claude-desktop) install_claude_desktop ;;
    mcp-json)       install_mcp_json ;;
esac

# ---------------------------------------------------------------------------
# Final verification hint
# ---------------------------------------------------------------------------
printf "%b" "${BOLD}"
printf "  Done! Wrapper: %s\n" "${WRAPPER_PATH}"
printf "%b" "${RESET}"
printf "  The wrapper reads your sessionKey at invocation time via the shared\n"
printf "  broker (rookie-based: Firefox/Chrome/Edge). If the cookie expires,\n"
printf "  just log in to claude.ai in your browser again.\n\n"
printf "  To smoke-test the wrapper directly:\n"
printf "    echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | %s\n\n" "${WRAPPER_PATH}"
