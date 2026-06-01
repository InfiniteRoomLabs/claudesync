
# claudesync -- installed by https://github.com/InfiniteRoomLabs/claudesync
function claudesync {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host "claudesync: Docker is not installed." -ForegroundColor Red; return
    }
    $broker = Join-Path $env:LOCALAPPDATA "claudesync\Harvest-Cookie.ps1"
    if (-not (Test-Path $broker)) {
        Write-Host "claudesync: cookie broker missing; run claudesync-setup" -ForegroundColor Red; return
    }
    $psExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
    if (-not $psExe) { $psExe = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
    if (-not $psExe) { $psExe = "powershell" }
    $cookie = & $psExe -NoProfile -ExecutionPolicy Bypass -File $broker
    $cookie = ($cookie | Where-Object { $_ } | Select-Object -Last 1)
    if (-not $cookie) { return }
    $tty = @(); if ($Args.Count -ge 1 -and $Args[0] -eq 'tui') { $tty = @('-it') }
    docker run --rm @tty -e "CLAUDE_AI_COOKIE=$cookie" -v "${PWD}:/data" __REF__ @Args
}
