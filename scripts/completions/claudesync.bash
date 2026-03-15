#!/usr/bin/env bash
# Bash completion for claudesync
# Source this file or install it to /etc/bash_completion.d/
#
# Usage:
#   source claudesync.bash
#   complete -F _claudesync claudesync

_claudesync() {
    local cur prev words cword
    _init_completion || return

    local subcommands="ls export projects search"

    # Determine which subcommand (if any) has been typed
    local subcmd=""
    local i
    for (( i=1; i < cword; i++ )); do
        case "${words[i]}" in
            ls|export|projects|search)
                subcmd="${words[i]}"
                break
                ;;
        esac
    done

    # Top-level: complete subcommands and global flags
    if [[ -z "${subcmd}" ]]; then
        case "${cur}" in
            -*)
                COMPREPLY=( $(compgen -W "--help --version" -- "${cur}") )
                return
                ;;
            *)
                COMPREPLY=( $(compgen -W "${subcommands} --help --version" -- "${cur}") )
                return
                ;;
        esac
    fi

    # Subcommand-level completions
    case "${subcmd}" in
        ls)
            case "${prev}" in
                --org)    return ;;  # user provides orgId
                --limit)  return ;;  # user provides number
            esac
            COMPREPLY=( $(compgen -W "--org --limit --starred --json --help" -- "${cur}") )
            ;;
        export)
            case "${prev}" in
                --org)          return ;;
                --output)       _filedir; return ;;
                --format)       COMPREPLY=( $(compgen -W "git json" -- "${cur}") ); return ;;
                --author-name)  return ;;
                --author-email) return ;;
            esac
            COMPREPLY=( $(compgen -W "--org --output --format --author-name --author-email --help" -- "${cur}") )
            ;;
        projects)
            case "${prev}" in
                --org) return ;;
            esac
            COMPREPLY=( $(compgen -W "--org --json --help" -- "${cur}") )
            ;;
        search)
            case "${prev}" in
                --org)   return ;;
                --limit) return ;;
            esac
            COMPREPLY=( $(compgen -W "--org --limit --json --help" -- "${cur}") )
            ;;
    esac
}

complete -F _claudesync claudesync
