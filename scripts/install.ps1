#Requires -Version 5.1
<#
.SYNOPSIS
    ClaudeSync bootstrap installer (Windows) -- obtains claudesync-setup and runs it.
.NOTES
    irm https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/install.ps1 | iex
    With args (irm|iex can't take args):
      & ([scriptblock]::Create((irm <url>/install.ps1))) install -Mcp -DryRun
    Compatible with Windows PowerShell 5.1 and PowerShell 7+.
#>
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Rest)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 6) {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
}

$ImageSync = "deathnerd/claudesync"
$RawBase   = "https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main"
# Probe for .Path before reading it: under 'irm | iex' MyCommand is a ScriptBlock
# with no Path property, and strict mode makes the bare read a fatal error.
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.PSObject.Properties['Path'] -and $MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $null }

Write-Host ""
Write-Host "  ClaudeSync -- your claude.ai data, your way" -ForegroundColor White
Write-Host "  https://github.com/InfiniteRoomLabs/claudesync" -ForegroundColor White
Write-Host ""

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
        # PS 5.1 turns redirected native stderr into terminating errors under
        # EAP=Stop, and docker chats on stderr even on success ("Unable to find
        # image ... locally" before an auto-pull). Relax EAP around docker.
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try {
            $cid = (docker create "${ImageSync}:latest" 2>$null | Select-Object -First 1)
            if ($cid) {
                try { docker cp "${cid}:/opt/claudesync/host/claudesync-setup.ps1" $setup 2>$null | Out-Null; if (Test-Path $setup) { $got = $true } }
                finally { docker rm -f $cid 2>$null | Out-Null }
            }
        }
        finally { $ErrorActionPreference = $eap }
    }
    if (-not $got) {
        try { Invoke-WebRequest -Uri "$RawBase/scripts/claudesync-setup.ps1" -OutFile $setup -UseBasicParsing; $got = $true } catch {}
    }
    if (-not $got) { Write-Host "install.ps1: could not obtain claudesync-setup.ps1" -ForegroundColor Red; exit 1 }
}

# Strict-safe: Get-Command returns $null when absent, and $null.Source is fatal
# under Set-StrictMode -- resolve the command first, read .Source only if found.
$psCmd = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $psCmd) { $psCmd = Get-Command powershell -ErrorAction SilentlyContinue }
$psExe = if ($psCmd) { $psCmd.Source } else { "powershell" }

& $psExe -NoProfile -ExecutionPolicy Bypass -File $setup @Rest
$rc = $LASTEXITCODE
if ($cleanup) { Remove-Item $cleanup -Force -ErrorAction SilentlyContinue }
exit $rc
