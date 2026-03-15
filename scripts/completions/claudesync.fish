# Fish completion for claudesync
# Install: copy to ~/.config/fish/completions/claudesync.fish

# Disable file completions by default
complete -c claudesync -f

# Top-level flags
complete -c claudesync -n '__fish_use_subcommand' -s h -l help -d 'Show help'
complete -c claudesync -n '__fish_use_subcommand' -s V -l version -d 'Show version'

# Subcommands
complete -c claudesync -n '__fish_use_subcommand' -a ls -d 'List conversations'
complete -c claudesync -n '__fish_use_subcommand' -a export -d 'Export a conversation to a git repository'
complete -c claudesync -n '__fish_use_subcommand' -a projects -d 'List projects'
complete -c claudesync -n '__fish_use_subcommand' -a search -d 'Search conversations'

# ls options
complete -c claudesync -n '__fish_seen_subcommand_from ls' -l org -r -d 'Organization ID'
complete -c claudesync -n '__fish_seen_subcommand_from ls' -l limit -r -d 'Max conversations to show'
complete -c claudesync -n '__fish_seen_subcommand_from ls' -l starred -d 'Show only starred conversations'
complete -c claudesync -n '__fish_seen_subcommand_from ls' -l json -d 'Output as JSON'
complete -c claudesync -n '__fish_seen_subcommand_from ls' -s h -l help -d 'Show help'

# export options
complete -c claudesync -n '__fish_seen_subcommand_from export' -l org -r -d 'Organization ID'
complete -c claudesync -n '__fish_seen_subcommand_from export' -l output -r -F -d 'Output directory'
complete -c claudesync -n '__fish_seen_subcommand_from export' -l format -r -x -a 'git json' -d 'Output format'
complete -c claudesync -n '__fish_seen_subcommand_from export' -l author-name -r -d 'Git author name'
complete -c claudesync -n '__fish_seen_subcommand_from export' -l author-email -r -d 'Git author email'
complete -c claudesync -n '__fish_seen_subcommand_from export' -s h -l help -d 'Show help'

# projects options
complete -c claudesync -n '__fish_seen_subcommand_from projects' -l org -r -d 'Organization ID'
complete -c claudesync -n '__fish_seen_subcommand_from projects' -l json -d 'Output as JSON'
complete -c claudesync -n '__fish_seen_subcommand_from projects' -s h -l help -d 'Show help'

# search options
complete -c claudesync -n '__fish_seen_subcommand_from search' -l org -r -d 'Organization ID'
complete -c claudesync -n '__fish_seen_subcommand_from search' -l limit -r -d 'Max results to show'
complete -c claudesync -n '__fish_seen_subcommand_from search' -l json -d 'Output as JSON'
complete -c claudesync -n '__fish_seen_subcommand_from search' -s h -l help -d 'Show help'
