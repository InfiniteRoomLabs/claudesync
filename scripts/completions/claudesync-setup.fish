# fish completion for claudesync-setup
# Installed by claudesync-setup into ~/.config/fish/completions/

complete -c claudesync-setup -f
complete -c claudesync-setup -n __fish_use_subcommand -a install   -d 'Install components'
complete -c claudesync-setup -n __fish_use_subcommand -a update    -d 'Re-install at a (new) version'
complete -c claudesync-setup -n __fish_use_subcommand -a uninstall -d 'Remove components'
complete -c claudesync-setup -l synchronizer -d 'The claudesync CLI wrapper + image'
complete -c claudesync-setup -l mcp          -d 'The MCP server wrapper + image'
complete -c claudesync-setup -l broker       -d 'Host cookie reader only'
complete -c claudesync-setup -l force        -d 'Do not prompt before replacing'
complete -c claudesync-setup -l dry-run      -d 'Print actions without changing anything'
complete -c claudesync-setup -l pin-digest   -d 'Resolve image tags to @sha256 and pin'
complete -c claudesync-setup -l target -x -a 'claude-code claude-desktop mcp-json' -d 'MCP client to configure'
complete -c claudesync-setup -s h -l help    -d 'Show help'
