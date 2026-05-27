# bash completion for claudesync-setup
# Installed by claudesync-setup into ~/.local/share/claudesync/completions/

_claudesync_setup() {
    local cur subcmds opts
    cur="${COMP_WORDS[COMP_CWORD]}"
    subcmds="install update uninstall"
    opts="--synchronizer --mcp --broker --force --dry-run --pin-digest --target= --help"

    # Has a subcommand already been given?
    local has_sub="" i
    for ((i = 1; i < COMP_CWORD; i++)); do
        case "${COMP_WORDS[i]}" in
            install|update|uninstall) has_sub="${COMP_WORDS[i]}"; break ;;
        esac
    done

    # shellcheck disable=SC2207  # COMPREPLY=( $(compgen ...) ) is the standard idiom
    if [ -z "${has_sub}" ]; then
        COMPREPLY=( $(compgen -W "${subcmds} ${opts}" -- "${cur}") )
    else
        COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
    fi
    return 0
}
complete -F _claudesync_setup claudesync-setup
