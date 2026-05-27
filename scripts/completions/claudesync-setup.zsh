#compdef claudesync-setup
# zsh completion for claudesync-setup
# Installed by claudesync-setup as _claudesync-setup on the fpath.

_claudesync_setup() {
    _arguments -s \
        '1:subcommand:(install update uninstall)' \
        '--synchronizer[the claudesync CLI wrapper + image]' \
        '--mcp[the MCP server wrapper + image]' \
        '--broker[host cookie reader only]' \
        '--force[do not prompt before replacing]' \
        '--dry-run[print actions without changing anything]' \
        '--pin-digest[resolve image tags to @sha256 and pin]' \
        '--target=[MCP client to configure]:target:(claude-code claude-desktop mcp-json)' \
        '(-h --help)'{-h,--help}'[show help]'
}

_claudesync_setup "$@"
