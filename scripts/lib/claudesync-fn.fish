# claudesync -- installed by https://github.com/InfiniteRoomLabs/claudesync
function claudesync
    if not command -q docker
        echo "claudesync: docker is not installed." >&2
        return 1
    end
    set -q XDG_DATA_HOME; or set -l XDG_DATA_HOME "$HOME/.local/share"
    set -l _cs_broker "$XDG_DATA_HOME/claudesync/harvest-cookie.sh"
    if not test -f "$_cs_broker"
        echo "claudesync: cookie broker missing at $_cs_broker; run claudesync-setup" >&2
        return 1
    end
    set -l _cs_cookie (sh "$_cs_broker"); or return 1
    test -n "$_cs_cookie"; or return 1
    set -l _cs_tty
    if test (count $argv) -ge 1; and test "$argv[1]" = "tui"
        set _cs_tty -it
    end
    CLAUDE_AI_COOKIE="$_cs_cookie" docker run --rm $_cs_tty -e CLAUDE_AI_COOKIE -v (pwd)":/data" __REF__ $argv
end
