#!/bin/sh
# claudesync-setup -- install / update / uninstall manager for ClaudeSync.
#
# Components:
#   synchronizer  the `claudesync` CLI wrapper (rc/$PROFILE fn) + image
#   mcp           the MCP wrapper (~/.local/bin/claudesync-mcp) + config + image
#   broker        the host-side cookie reader (harvest-cookie.sh); a dependency
#                 of both, installable on its own
#
# Usage:
#   claudesync-setup [install|update|uninstall] [VERSION] \
#                    [--synchronizer[=VER]] [--mcp[=VER]] [--broker] \
#                    [--force] [--dry-run] [--pin-digest] [-h|--help]
#
# Piped: curl -fsSL <url> | bash -s -- update --mcp --dry-run
#
# POSIX sh. Cookie reading is delegated to the broker (rookie-based).

set -u

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
IMAGE_SYNC="deathnerd/claudesync"
IMAGE_MCP="deathnerd/claudesync-mcp"
RAW_BASE="https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main"

DATA_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/claudesync"
BROKER_DEST="${DATA_DIR}/harvest-cookie.sh"
COMP_DIR="${DATA_DIR}/completions"
STATE_FILE="${DATA_DIR}/setup-state.json"
BIN_DIR="${HOME}/.local/bin"
SETUP_DEST="${BIN_DIR}/claudesync-setup"
MCP_WRAPPER="${BIN_DIR}/claudesync-mcp"

MARKER="# claudesync -- installed by https://github.com/InfiniteRoomLabs/claudesync"

# ---------------------------------------------------------------------------
# Colors / logging
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; CYAN=''; RESET=''
fi
info()    { printf "%b[claudesync-setup]%b %s\n" "${CYAN}"   "${RESET}" "$*"; }
success() { printf "%b[claudesync-setup]%b %s\n" "${GREEN}"  "${RESET}" "$*"; }
warn()    { printf "%b[claudesync-setup]%b %s\n" "${YELLOW}" "${RESET}" "$*"; }
error()   { printf "%b[claudesync-setup]%b %s\n" "${RED}"    "${RESET}" "$*" >&2; }
die()     { error "$*"; exit 1; }

# ---------------------------------------------------------------------------
# State (parsed args)
# ---------------------------------------------------------------------------
SUBCMD=""
GLOBAL_VERSION=""
VER_SYNC=""
VER_MCP=""
DO_SYNC=0
DO_MCP=0
DO_BROKER=0
EXPLICIT_COMPONENTS=0
FORCE=0
DRY_RUN=0
PIN_DIGEST=0
MCP_TARGET=""

# Print usage text to stdout.
usage() {
    cat <<'EOF'
claudesync-setup -- manage the ClaudeSync install

Usage:
  claudesync-setup [SUBCOMMAND] [VERSION] [COMPONENTS] [OPTIONS]

Subcommands:
  install     (default) install components
  update      re-install at a (possibly new) version
  uninstall   remove components

Components (omit all => everything sensible for the subcommand):
  --synchronizer[=VER]   the `claudesync` CLI wrapper + image
  --mcp[=VER]            the MCP server wrapper + config + image
  --broker              the host cookie reader only

Version:
  positional VERSION applies to every component as a default;
  a per-component =VER overrides it. Each component resolves against
  its own image -- versions are NOT assumed equal across images.

Options:
  --force          do not prompt before replacing existing files
  --dry-run        print actions without changing anything
  --pin-digest     resolve image tags to @sha256 digests and pin wrappers to them
  --target=TARGET  MCP client to configure: claude-code | claude-desktop | mcp-json
                   (omit to be prompted; non-interactive skips with instructions)
  -h, --help       this help

Examples:
  claudesync-setup                         # install everything, latest
  claudesync-setup install 0.6.1           # pin all components to 0.6.1
  claudesync-setup install --mcp=0.5.2 --synchronizer=0.6.1
  claudesync-setup update --pin-digest
  claudesync-setup uninstall --mcp
  curl -fsSL <url> | bash -s -- update --dry-run
EOF
}

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
# Parse CLI arguments into global state variables (SUBCMD, VER_*, DO_*, flags).
parse_args() {
    for _a in "$@"; do
        case "${_a}" in
            install|update|uninstall)
                if [ -z "${SUBCMD}" ]; then SUBCMD="${_a}"; else die "Unexpected argument: ${_a}"; fi
                ;;
            --synchronizer)      DO_SYNC=1; EXPLICIT_COMPONENTS=1 ;;
            --synchronizer=*)    DO_SYNC=1; EXPLICIT_COMPONENTS=1; VER_SYNC="${_a#*=}" ;;
            --mcp)               DO_MCP=1;  EXPLICIT_COMPONENTS=1 ;;
            --mcp=*)             DO_MCP=1;  EXPLICIT_COMPONENTS=1; VER_MCP="${_a#*=}" ;;
            --broker)            DO_BROKER=1; EXPLICIT_COMPONENTS=1 ;;
            --force|-f)          FORCE=1 ;;
            --dry-run|-n)        DRY_RUN=1 ;;
            --pin-digest)        PIN_DIGEST=1 ;;
            --target=*)          MCP_TARGET="${_a#*=}" ;;
            -h|--help)           usage; exit 0 ;;
            --*)                 die "Unknown option: ${_a}  (see --help)" ;;
            *)
                if [ -z "${GLOBAL_VERSION}" ]; then
                    GLOBAL_VERSION="${_a}"
                else
                    die "Unexpected argument: ${_a}  (see --help)"
                fi
                ;;
        esac
    done

    [ -z "${SUBCMD}" ] && SUBCMD="install"

    # Default versions from the global positional.
    [ -z "${VER_SYNC}" ] && VER_SYNC="${GLOBAL_VERSION}"
    [ -z "${VER_MCP}" ]  && VER_MCP="${GLOBAL_VERSION}"

    # No explicit components => "everything sensible".
    if [ "${EXPLICIT_COMPONENTS}" = "0" ]; then
        DO_SYNC=1
        DO_MCP=1
        DO_BROKER=1
    fi
    # synchronizer or mcp implies the broker dependency (install/update only).
    if [ "${SUBCMD}" != "uninstall" ] && { [ "${DO_SYNC}" = "1" ] || [ "${DO_MCP}" = "1" ]; }; then
        DO_BROKER=1
    fi
}

# ---------------------------------------------------------------------------
# run(): execute, or print under --dry-run
# ---------------------------------------------------------------------------
run() {
    if [ "${DRY_RUN}" = "1" ]; then
        printf "%b[dry-run]%b %s\n" "${YELLOW}" "${RESET}" "$*"
        return 0
    fi
    "$@"
}

# ---------------------------------------------------------------------------
# Image reference resolution
# version_or_empty -> tag ("" => latest). With PIN_DIGEST, resolve to @sha256.
# Echoes the full ref (image:tag or image@sha256:...).
# ---------------------------------------------------------------------------
resolve_ref() {
    _image="$1"
    _ver="$2"
    _tag="${_ver:-latest}"
    _ref="${_image}:${_tag}"

    if [ "${PIN_DIGEST}" != "1" ]; then
        printf '%s' "${_ref}"
        return 0
    fi

    _digest=""
    if docker buildx imagetools inspect "${_ref}" --format '{{.Manifest.Digest}}' >/dev/null 2>&1; then
        _digest="$(docker buildx imagetools inspect "${_ref}" --format '{{.Manifest.Digest}}' 2>/dev/null)"
    fi
    if [ -z "${_digest}" ] && command -v python3 >/dev/null 2>&1; then
        _digest="$(docker manifest inspect -v "${_ref}" 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
d = d[0] if isinstance(d, list) else d
print((d.get("Descriptor") or {}).get("digest", ""))
' 2>/dev/null)"
    fi

    if [ -z "${_digest}" ]; then
        die "Could not resolve digest for ${_ref}. Ensure the tag exists and you can reach the registry."
    fi
    printf '%s@%s' "${_image}" "${_digest}"
}

# Pre-pull a ref. If the daemon refuses tag pulls (digest-enforcing posture),
# auto-enable --pin-digest for the rest of the run and signal the caller to
# re-resolve to a digest. Returns 0 if pulled (or pinning not needed),
# 1 if the caller must re-resolve + retry under PIN_DIGEST.
pull_or_detect() {
    _r="$1"
    if [ "${DRY_RUN}" = "1" ]; then info "[dry-run] docker pull ${_r}"; return 0; fi
    _err="$(docker pull "${_r}" 2>&1 1>/dev/null)" && return 0
    case "${_err}" in
        *@sha256*|*[Dd]igest*|*"content trust"*|*DOCKER_CONTENT_TRUST*)
            if [ "${PIN_DIGEST}" != "1" ]; then
                warn "Docker refuses tag pulls (digest-enforcing) -- enabling --pin-digest automatically."
                PIN_DIGEST=1
                return 1
            fi
            warn "Could not pre-pull ${_r} (will pull on first use)."; return 0 ;;
        *) warn "Could not pre-pull ${_r} (will pull on first use)."; return 0 ;;
    esac
}

# ---------------------------------------------------------------------------
# Confirm prompt (honors --force)
# ---------------------------------------------------------------------------
confirm() {
    [ "${FORCE}" = "1" ] && return 0
    [ "${DRY_RUN}" = "1" ] && return 0
    printf "%b[claudesync-setup]%b %s [y/N] " "${YELLOW}" "${RESET}" "$1"
    read -r _ans </dev/tty 2>/dev/null || return 1
    case "${_ans}" in [Yy]|[Yy][Ee][Ss]) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------------------
# Fetch a repo file: local repo -> pulled image -> GitHub (loud fallback).
# Args: $1 = path within repo (e.g. lib/harvest-cookie.sh), $2 = dest,
#       $3 = image to extract from, $4 = path inside image.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"

# Extract a single file from a Docker image layer without running the container.
# Args: $1 = image ref, $2 = path inside image, $3 = destination path.
extract_from_image() {
    _img="$1"; _img_path="$2"; _dest="$3"
    command -v docker >/dev/null 2>&1 || return 1
    _cid="$(docker create "${_img}" 2>/dev/null)" || return 1
    if docker cp "${_cid}:${_img_path}" "${_dest}" >/dev/null 2>&1; then
        docker rm -f "${_cid}" >/dev/null 2>&1 || true
        [ -f "${_dest}" ]
    else
        docker rm -f "${_cid}" >/dev/null 2>&1 || true
        return 1
    fi
}

fetch_asset() {
    _repo_path="$1"; _dest="$2"; _img="$3"; _img_path="$4"
    _local="${SCRIPT_DIR}/${_repo_path#scripts/}"
    if [ -f "${_local}" ]; then
        run cp "${_local}" "${_dest}"
        return 0
    fi
    if extract_from_image "${_img}" "${_img_path}" "${_dest}"; then
        return 0
    fi
    warn "FALLBACK: fetching ${_repo_path} from GitHub (main) -- may differ from your pinned image."
    if command -v curl >/dev/null 2>&1; then
        run curl -fsSL "${RAW_BASE}/${_repo_path}" -o "${_dest}" || { warn "Download failed: ${RAW_BASE}/${_repo_path}"; return 1; }
    elif command -v wget >/dev/null 2>&1; then
        run wget -qO "${_dest}" "${RAW_BASE}/${_repo_path}" || { warn "Download failed: ${RAW_BASE}/${_repo_path}"; return 1; }
    else
        warn "Need curl or wget to fetch ${_repo_path}."
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Completions
# ---------------------------------------------------------------------------
COMPLETION_MARKER="# claudesync completions"

# Append LINE to RC if TAG not already present, preventing duplicate sourcing.
# Args: $1 = rc file, $2 = line to append, $3 = idempotency tag.
_ensure_rc_line() {
    _rc="$1"; _line="$2"; _tag="$3"
    if [ "${DRY_RUN}" = "1" ]; then info "[dry-run] ensure '${_line}' in ${_rc}"; return 0; fi
    grep -qF "${_tag}" "${_rc}" 2>/dev/null && return 0
    printf '\n%s  %s\n' "${_line}" "${_tag}" >> "${_rc}"
}

# Install the completion for one command for the user's current shell.
# Arg: $1 = command base name (claudesync | claudesync-setup)
install_completion() {
    _cmd="$1"
    _rc="$(detect_rc)"
    _img="${IMAGE_SYNC}:${VER_SYNC:-latest}"
    case "${_rc}" in
        fish)
            _d="${HOME}/.config/fish/completions"
            run mkdir -p "${_d}"
            fetch_asset "scripts/completions/${_cmd}.fish" "${_d}/${_cmd}.fish" \
                "${_img}" "/opt/claudesync/host/completions/${_cmd}.fish" \
                || warn "completion for ${_cmd} (fish) unavailable; skipping."
            ;;
        *zshrc)
            run mkdir -p "${COMP_DIR}"
            if fetch_asset "scripts/completions/${_cmd}.zsh" "${COMP_DIR}/_${_cmd}" \
                "${_img}" "/opt/claudesync/host/completions/${_cmd}.zsh"; then
                _ensure_rc_line "${_rc}" "fpath=(${COMP_DIR} \$fpath)" "${COMPLETION_MARKER}"
                _ensure_rc_line "${_rc}" "autoload -Uz compinit && compinit" "${COMPLETION_MARKER} init"
            else
                warn "completion for ${_cmd} (zsh) unavailable; skipping."
            fi
            ;;
        *)
            run mkdir -p "${COMP_DIR}"
            if fetch_asset "scripts/completions/${_cmd}.bash" "${COMP_DIR}/${_cmd}.bash" \
                "${_img}" "/opt/claudesync/host/completions/${_cmd}.bash"; then
                _ensure_rc_line "${_rc}" "source ${COMP_DIR}/${_cmd}.bash" "${COMPLETION_MARKER} ${_cmd}"
            else
                warn "completion for ${_cmd} (bash) unavailable; skipping."
            fi
            ;;
    esac
}

# Remove all completion files for CMD across bash, zsh, and fish.
# Arg: $1 = command base name.
remove_completion() {
    _cmd="$1"
    run rm -f "${COMP_DIR}/${_cmd}.bash" "${COMP_DIR}/_${_cmd}" \
              "${HOME}/.config/fish/completions/${_cmd}.fish"
}

# Strip the completion source/fpath lines (marked with COMPLETION_MARKER) from an rc.
strip_rc_completion_lines() {
    _rc="$1"
    [ -f "${_rc}" ] || return 0
    if [ "${DRY_RUN}" = "1" ]; then info "[dry-run] strip completion lines from ${_rc}"; return 0; fi
    _tmp="${_rc}.claudesync.tmp"
    grep -vF "${COMPLETION_MARKER}" "${_rc}" > "${_tmp}" && mv "${_tmp}" "${_rc}"
}

# ---------------------------------------------------------------------------
# Component: broker
# ---------------------------------------------------------------------------

# Install harvest-cookie.sh to DATA_DIR and make it executable.
install_broker() {
    info "Installing cookie broker ..."
    run mkdir -p "${DATA_DIR}"
    # Extract from the synchronizer image by default (broker is image-agnostic).
    fetch_asset "scripts/lib/harvest-cookie.sh" "${BROKER_DEST}" \
                "${IMAGE_SYNC}:${VER_SYNC:-latest}" "/opt/claudesync/host/lib/harvest-cookie.sh" \
        || die "Cookie broker is required but could not be installed."
    run chmod +x "${BROKER_DEST}"
    success "Broker -> ${BROKER_DEST}"
}

# Remove the cookie broker and its cached rookie binary.
uninstall_broker() {
    info "Removing cookie broker + rookie cache ..."
    run rm -f "${BROKER_DEST}"
    run rm -f "${XDG_CACHE_HOME:-${HOME}/.cache}/claudesync/rookie-cli"
    success "Broker removed."
}

# ---------------------------------------------------------------------------
# Component: synchronizer (rc/$PROFILE function)
# Emits the bash/zsh function body pinned to a specific image ref.
# ---------------------------------------------------------------------------
sync_function_body() {
    _ref="$1"
    _tpl_tmp="$(mktemp)"
    fetch_asset "scripts/lib/claudesync-fn.bash" "${_tpl_tmp}" \
                "${IMAGE_SYNC}:${VER_SYNC:-latest}" "/opt/claudesync/host/lib/claudesync-fn.bash" \
        || { rm -f "${_tpl_tmp}"; die "Could not fetch bash function template."; }
    awk -v r="${_ref}" '{ gsub(/__REF__/, r); print }' "${_tpl_tmp}"
    rm -f "${_tpl_tmp}"
}

# Echo the rc file path for the running shell, or "fish" for fish shell.
detect_rc() {
    case "${SHELL:-}" in
        */zsh)  echo "${HOME}/.zshrc"; return ;;
        */bash) echo "${HOME}/.bashrc"; return ;;
        */fish) echo "fish"; return ;;
    esac
    echo "${HOME}/.bashrc"
}

# Strip the claudesync() function block (bounded by MARKER) from an rc file.
# Arg: $1 = rc file path.
remove_sync_block() {
    _rc="$1"
    [ -f "${_rc}" ] || return 0
    _tmp="${_rc}.claudesync.tmp"
    run sh -c "awk -v marker='${MARKER}' '
        \$0 == marker { skip=1; next }
        skip && /^[[:space:]]*\$/ && saw { skip=0; next }
        skip && /^}/ { saw=1; next }
        skip { next }
        { print }
    ' '${_rc}' > '${_tmp}' && mv '${_tmp}' '${_rc}'"
}

# Install the claudesync shell function to the user's rc file or fish functions dir.
install_synchronizer() {
    _ref="$(resolve_ref "${IMAGE_SYNC}" "${VER_SYNC}")"
    # die() inside $() only exits the subshell -- guard against an empty ref
    # reaching the template writer (would install a broken wrapper silently).
    [ -n "${_ref}" ] || die "Could not resolve an image ref for ${IMAGE_SYNC} (transient registry error?). Re-run the installer."
    info "Installing synchronizer (image ref: ${_ref}) ..."
    if ! pull_or_detect "${_ref}"; then
        _ref="$(resolve_ref "${IMAGE_SYNC}" "${VER_SYNC}")"   # PIN_DIGEST now on -> digest
        [ -n "${_ref}" ] || die "Could not re-resolve an image ref for ${IMAGE_SYNC}. Re-run the installer."
        info "Re-resolved to ${_ref}"
        run docker pull "${_ref}" >/dev/null 2>&1 || warn "Could not pre-pull ${_ref} (will pull on first use)."
    fi

    _rc="$(detect_rc)"

    if [ "${_rc}" = "fish" ]; then
        install_synchronizer_fish "${_ref}"
        return
    fi
    if grep -qF "claudesync()" "${_rc}" 2>/dev/null; then
        confirm "Replace existing claudesync function in ${_rc}?" || { warn "Left ${_rc} unchanged."; return 0; }
        remove_sync_block "${_rc}"
    fi
    if [ "${DRY_RUN}" = "1" ]; then
        info "[dry-run] append claudesync() (pinned to ${_ref}) to ${_rc}"
    else
        sync_function_body "${_ref}" >> "${_rc}"
    fi
    success "Synchronizer -> ${_rc}"
}

# Write the claudesync fish function file with the image ref substituted.
# Arg: $1 = resolved image ref.
install_synchronizer_fish() {
    _ref="$1"
    _dir="${HOME}/.config/fish/functions"
    _file="${_dir}/claudesync.fish"
    run mkdir -p "${_dir}"
    if [ "${DRY_RUN}" = "1" ]; then
        info "[dry-run] write fish function (pinned to ${_ref}) to ${_file}"
        return
    fi
    _tpl_tmp="$(mktemp)"
    fetch_asset "scripts/lib/claudesync-fn.fish" "${_tpl_tmp}" \
                "${IMAGE_SYNC}:${VER_SYNC:-latest}" "/opt/claudesync/host/lib/claudesync-fn.fish" \
        || { rm -f "${_tpl_tmp}"; die "Could not fetch fish function template."; }
    awk -v r="${_ref}" '{ gsub(/__REF__/, r); print }' "${_tpl_tmp}" > "${_file}"
    rm -f "${_tpl_tmp}"
    success "Synchronizer (fish) -> ${_file}"
}

# Remove the claudesync function from the shell config and clean up completions.
uninstall_synchronizer() {
    info "Removing synchronizer ..."
    _rc="$(detect_rc)"
    if [ "${_rc}" = "fish" ]; then
        run rm -f "${HOME}/.config/fish/functions/claudesync.fish"
    else
        remove_sync_block "${_rc}"
        strip_rc_completion_lines "${_rc}"
    fi
    remove_completion claudesync
    success "Synchronizer removed (you may need to open a new shell)."
}

# ---------------------------------------------------------------------------
# Component: mcp (wrapper + config)  -- delegates cookie reading to the broker
# ---------------------------------------------------------------------------

# Install the MCP wrapper script to BIN_DIR and configure the MCP client.
install_mcp() {
    _ref="$(resolve_ref "${IMAGE_MCP}" "${VER_MCP}")"
    # See install_synchronizer: die() in $() cannot abort the parent shell.
    [ -n "${_ref}" ] || die "Could not resolve an image ref for ${IMAGE_MCP} (transient registry error?). Re-run the installer."
    info "Installing MCP wrapper (image ref: ${_ref}) ..."
    if ! pull_or_detect "${_ref}"; then
        _ref="$(resolve_ref "${IMAGE_MCP}" "${VER_MCP}")"
        [ -n "${_ref}" ] || die "Could not re-resolve an image ref for ${IMAGE_MCP}. Re-run the installer."
        info "Re-resolved to ${_ref}"
        run docker pull "${_ref}" >/dev/null 2>&1 || warn "Could not pre-pull ${_ref} (will pull on first use)."
    fi
    run mkdir -p "${BIN_DIR}"

    if [ "${DRY_RUN}" = "1" ]; then
        info "[dry-run] write MCP wrapper (pinned to ${_ref}) to ${MCP_WRAPPER}"
    else
        _tpl_tmp="$(mktemp)"
        fetch_asset "scripts/lib/claudesync-mcp-wrapper.sh" "${_tpl_tmp}" \
                    "${IMAGE_MCP}:${VER_MCP:-latest}" "/opt/claudesync/host/lib/claudesync-mcp-wrapper.sh" \
            || { rm -f "${_tpl_tmp}"; die "Could not fetch MCP wrapper template."; }
        awk -v r="${_ref}" '{ gsub(/__REF__/, r); print }' "${_tpl_tmp}" > "${MCP_WRAPPER}"
        rm -f "${_tpl_tmp}"
        chmod +x "${MCP_WRAPPER}"
    fi
    success "MCP wrapper -> ${MCP_WRAPPER}"
    configure_mcp
}

# Remove the MCP wrapper script. Leaves MCP client config entries in place.
uninstall_mcp() {
    info "Removing MCP wrapper ..."
    run rm -f "${MCP_WRAPPER}"
    warn "MCP config entries (e.g. ~/.claude.json) are left untouched -- remove 'claudesync' manually if desired."
    success "MCP wrapper removed."
}

# --- MCP client config merge (claude-code / claude-desktop / mcp-json) ---
# Echo the JSON config object for the claudesync MCP server entry.
mcp_config_block() { printf '{"command":"%s","args":[]}' "${MCP_WRAPPER}"; }

# Upsert the claudesync MCP entry into a config file using jq.
# Args: $1 = file, $2 = server name, $3 = JSON config block.
_merge_mcp_jq() {
    _file="$1"; _name="$2"; _block="$3"; _tmp="${_file}.claudesync.tmp"
    jq --arg n "${_name}" --argjson b "${_block}" '.mcpServers[$n]=$b' "${_file}" > "${_tmp}" && mv "${_tmp}" "${_file}"
}

# Upsert the claudesync MCP entry using awk/grep; fallback when jq is absent.
# Args: $1 = file, $2 = server name, $3 = JSON config block.
_merge_mcp_sed() {
    _file="$1"; _name="$2"; _block="$3"
    _entry="    \"${_name}\": ${_block}"
    if [ ! -s "${_file}" ]; then
        printf '{\n  "mcpServers": {\n%s\n  }\n}\n' "${_entry}" > "${_file}"
        return 0
    fi
    if grep -q "\"${_name}\"" "${_file}" 2>/dev/null; then
        warn "  '${_name}' already present in ${_file} -- leaving as-is."
        return 0
    fi
    _tmp="${_file}.claudesync.tmp"
    if grep -q '"mcpServers"' "${_file}" 2>/dev/null; then
        awk -v e="${_entry}" '/"mcpServers"[[:space:]]*:[[:space:]]*\{/ { print; print e ","; next } { print }' \
            "${_file}" > "${_tmp}" && mv "${_tmp}" "${_file}"
    else
        awk -v e="${_entry}" '/^[[:space:]]*\}[[:space:]]*$/ && !d { print "  \"mcpServers\": {"; print e; print "  },"; d=1 } { print }' \
            "${_file}" > "${_tmp}" && mv "${_tmp}" "${_file}"
    fi
}

# Add or replace the claudesync entry in an MCP client config JSON file.
# Arg: $1 = path to the config file.
merge_mcp_server() {
    _file="$1"
    if [ "${DRY_RUN}" = "1" ]; then info "[dry-run] add 'claudesync' MCP entry to ${_file}"; return 0; fi
    [ -f "${_file}" ] || printf '{"mcpServers":{}}\n' > "${_file}"
    if command -v jq >/dev/null 2>&1; then
        if grep -q '"claudesync"' "${_file}" 2>/dev/null; then
            _tmp="${_file}.claudesync.tmp"; jq 'del(.mcpServers.claudesync)' "${_file}" > "${_tmp}" && mv "${_tmp}" "${_file}"
        fi
        _merge_mcp_jq "${_file}" "claudesync" "$(mcp_config_block)"
    else
        _merge_mcp_sed "${_file}" "claudesync" "$(mcp_config_block)"
    fi
    success "MCP server entry written to ${_file}"
}

# Interactively prompt the user to choose an MCP client target; echo the choice.
select_mcp_target() {
    printf "\n  Configure ClaudeSync MCP for:\n" >&2
    printf "    1) Claude Code     (~/.claude.json)\n" >&2
    printf "    2) Claude Desktop\n" >&2
    printf "    3) Project .mcp.json (current dir)\n" >&2
    printf "    4) Skip -- register manually\n" >&2
    printf "  Choice [1-4]: " >&2
    read -r _c </dev/tty 2>/dev/null || { echo "skip"; return; }
    case "${_c}" in 1) echo "claude-code" ;; 2) echo "claude-desktop" ;; 3) echo "mcp-json" ;; *) echo "skip" ;; esac
}

# Write the MCP server entry to the target client config (--target or prompted).
configure_mcp() {
    _t="${MCP_TARGET}"
    if [ -z "${_t}" ]; then
        if [ -t 0 ] && [ "${DRY_RUN}" != "1" ]; then
            _t="$(select_mcp_target)"
        else
            info "No --target given; skipping MCP client config."
            info "Register manually: claude mcp add claudesync ${MCP_WRAPPER}"
            return 0
        fi
    fi
    case "${_t}" in
        skip) info "Register manually: claude mcp add claudesync ${MCP_WRAPPER}" ;;
        claude-code) merge_mcp_server "${HOME}/.claude.json" ;;
        claude-desktop)
            case "$(uname -s)" in
                Darwin) _f="${HOME}/Library/Application Support/Claude/claude_desktop_config.json" ;;
                *)      _f="${HOME}/.config/Claude/claude_desktop_config.json" ;;
            esac
            run mkdir -p "$(dirname "${_f}")"; merge_mcp_server "${_f}" ;;
        mcp-json) merge_mcp_server "$(pwd)/.mcp.json" ;;
        *) warn "Unknown --target '${_t}'; skipping. Valid: claude-code, claude-desktop, mcp-json." ;;
    esac
}

# ---------------------------------------------------------------------------
# Self-install: put this script on PATH + completions, so update/uninstall and
# tab-completion work without curl.
# ---------------------------------------------------------------------------
install_self() {
    run mkdir -p "${BIN_DIR}" "${COMP_DIR}"
    if [ -f "${SCRIPT_DIR}/claudesync-setup.sh" ] && [ "${SCRIPT_DIR}/claudesync-setup.sh" != "${SETUP_DEST}" ]; then
        run cp "${SCRIPT_DIR}/claudesync-setup.sh" "${SETUP_DEST}"
        run chmod +x "${SETUP_DEST}"
    elif [ ! -f "${SETUP_DEST}" ]; then
        fetch_asset "scripts/claudesync-setup.sh" "${SETUP_DEST}" \
                    "${IMAGE_SYNC}:${VER_SYNC:-latest}" "/opt/claudesync/host/claudesync-setup.sh" \
            && run chmod +x "${SETUP_DEST}" \
            || warn "Could not self-install claudesync-setup to PATH; use the installer script."
    fi
    # Completion for claudesync-setup itself (optional -- never fatal).
    install_completion claudesync-setup
    # Warn if the manager won't be found as a bare command.
    case ":${PATH}:" in
        *":${BIN_DIR}:"*) ;;
        *) warn "${BIN_DIR} is not on your PATH -- add it so 'claudesync-setup' resolves:"
           warn "  bash/zsh: export PATH=\"\$PATH:${BIN_DIR}\"   fish: fish_add_path ${BIN_DIR}" ;;
    esac
}

# ---------------------------------------------------------------------------
# State file (best-effort; informational for `update`)
# ---------------------------------------------------------------------------
write_state() {
    [ "${DRY_RUN}" = "1" ] && return 0
    mkdir -p "${DATA_DIR}"
    cat > "${STATE_FILE}" <<EOF
{
  "synchronizer": {"version": "${VER_SYNC:-latest}", "pin_digest": ${PIN_DIGEST}},
  "mcp": {"version": "${VER_MCP:-latest}", "pin_digest": ${PIN_DIGEST}}
}
EOF
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
# Run the install/update flow: broker, synchronizer, MCP, self-install, state.
do_install() {
    command -v docker >/dev/null 2>&1 || die "Docker is required. https://docs.docker.com/get-docker/"
    [ "${DO_BROKER}" = "1" ] && install_broker
    if [ "${DO_SYNC}" = "1" ]; then
        install_synchronizer
        install_completion claudesync
    fi
    [ "${DO_MCP}" = "1" ]    && install_mcp
    install_self   # always: keep the manager + its completion available
    write_state
    success "Done (${SUBCMD})."
}

# Run the uninstall flow: MCP, synchronizer, broker, self (when full uninstall).
do_uninstall() {
    [ "${DO_MCP}" = "1" ]    && uninstall_mcp
    [ "${DO_SYNC}" = "1" ]   && uninstall_synchronizer
    [ "${DO_BROKER}" = "1" ] && uninstall_broker
    # If removing everything, drop the manager + state too.
    if [ "${EXPLICIT_COMPONENTS}" = "0" ]; then
        remove_completion claudesync-setup
        run rm -f "${SETUP_DEST}" "${STATE_FILE}"
    fi
    success "Done (uninstall)."
}

# Entry point: parse args and dispatch to do_install or do_uninstall.
main() {
    parse_args "$@"
    case "${SUBCMD}" in
        install|update) do_install ;;
        uninstall)      do_uninstall ;;
        *)              die "Unknown subcommand: ${SUBCMD}" ;;
    esac
}

main "$@"
