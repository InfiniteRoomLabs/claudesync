#Requires -Version 5.1
# claudesync-mcp wrapper -- resolves the cookie via the broker, runs the MCP container.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function _Mcp_Error { param([string]$m)
    $j = '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"claudesync-mcp: ' + ($m -replace '"','\"') + '"}}'
    [Console]::Error.WriteLine($j); exit 1
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { _Mcp_Error "docker not found" }
$broker = Join-Path $env:LOCALAPPDATA "claudesync\Harvest-Cookie.ps1"
if (-not (Test-Path $broker)) { _Mcp_Error "cookie broker missing; run claudesync-setup" }
$psExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $psExe) { $psExe = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
if (-not $psExe) { $psExe = "powershell" }
$cookie = & $psExe -NoProfile -ExecutionPolicy Bypass -File $broker
$cookie = ($cookie | Where-Object { $_ } | Select-Object -Last 1)
if (-not $cookie) { _Mcp_Error "Could not read sessionKey cookie" }
docker run --rm -i -e "CLAUDE_AI_COOKIE=$cookie" __REF__
