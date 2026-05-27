#Requires -Version 5.1
<#
.SYNOPSIS
    ClaudeSync MCP installer (Windows) -- back-compat shim.
    Delegates to claudesync-setup with `install -Mcp`.
.NOTES
    irm <url>/install-mcp.ps1 | iex
    With args: & ([scriptblock]::Create((irm <url>/install-mcp.ps1))) -DryRun
#>
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Rest)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 6) {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
}

$ImageMcp  = "deathnerd/claudesync-mcp"
$RawBase   = "https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main"
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $null }

$setup = $null
$cleanup = $null
if ($ScriptDir -and (Test-Path (Join-Path $ScriptDir "claudesync-setup.ps1"))) {
    $setup = Join-Path $ScriptDir "claudesync-setup.ps1"
}
else {
    $setup = [System.IO.Path]::GetTempFileName() + ".ps1"
    $cleanup = $setup
    $got = $false
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        $cid = (docker create "${ImageMcp}:latest" 2>$null | Select-Object -First 1)
        if ($cid) {
            try { docker cp "${cid}:/opt/claudesync/host/claudesync-setup.ps1" $setup 2>$null | Out-Null; if (Test-Path $setup) { $got = $true } }
            finally { docker rm -f $cid 2>$null | Out-Null }
        }
    }
    if (-not $got) {
        try { Invoke-WebRequest -Uri "$RawBase/scripts/claudesync-setup.ps1" -OutFile $setup -UseBasicParsing; $got = $true } catch {}
    }
    if (-not $got) { Write-Host "install-mcp.ps1: could not obtain claudesync-setup.ps1" -ForegroundColor Red; exit 1 }
}

$psExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $psExe) { $psExe = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
if (-not $psExe) { $psExe = "powershell" }

& $psExe -NoProfile -ExecutionPolicy Bypass -File $setup install -Mcp @Rest
$rc = $LASTEXITCODE
if ($cleanup) { Remove-Item $cleanup -Force -ErrorAction SilentlyContinue }
exit $rc
