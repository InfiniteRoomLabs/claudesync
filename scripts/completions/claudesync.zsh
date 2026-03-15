#compdef claudesync
# Zsh completion for claudesync
# Install: copy to a directory in your $fpath, or source directly.

_claudesync() {
    local -a subcommands
    subcommands=(
        'ls:List conversations'
        'export:Export a conversation to a git repository'
        'projects:List projects'
        'search:Search conversations'
    )

    _arguments -C \
        '(-h --help)'{-h,--help}'[Show help]' \
        '(-V --version)'{-V,--version}'[Show version]' \
        '1:subcommand:->subcmd' \
        '*::arg:->args' && return

    case "$state" in
        subcmd)
            _describe 'subcommand' subcommands
            ;;
        args)
            case "${words[1]}" in
                ls)
                    _arguments \
                        '--org[Organization ID (auto-detected if omitted)]:orgId:' \
                        '--limit[Max conversations to show]:number:' \
                        '--starred[Show only starred conversations]' \
                        '--json[Output as JSON instead of table]' \
                        '(-h --help)'{-h,--help}'[Show help]'
                    ;;
                export)
                    _arguments \
                        '1:conversation-id:' \
                        '--org[Organization ID (auto-detected if omitted)]:orgId:' \
                        '--output[Output directory]:path:_files -/' \
                        '--format[Output format]:format:(git json)' \
                        '--author-name[Git author name]:name:' \
                        '--author-email[Git author email]:email:' \
                        '(-h --help)'{-h,--help}'[Show help]'
                    ;;
                projects)
                    _arguments \
                        '--org[Organization ID (auto-detected if omitted)]:orgId:' \
                        '--json[Output as JSON instead of table]' \
                        '(-h --help)'{-h,--help}'[Show help]'
                    ;;
                search)
                    _arguments \
                        '1:query:' \
                        '--org[Organization ID (auto-detected if omitted)]:orgId:' \
                        '--limit[Max results to show]:number:' \
                        '--json[Output as JSON instead of table]' \
                        '(-h --help)'{-h,--help}'[Show help]'
                    ;;
            esac
            ;;
    esac
}

_claudesync "$@"
