#Requires -Version 5.1
<#
.SYNOPSIS
    ClaudeSync uninstaller (Windows) -- back-compat shim.
    Delegates to claudesync-setup uninstall.
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
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $null }
$LocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME ".local/share" }

# Strict-safe: Get-Command returns $null when absent, and $null.Source is fatal
# under Set-StrictMode -- resolve the command first, read .Source only if found.
$psCmd = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $psCmd) { $psCmd = Get-Command powershell -ErrorAction SilentlyContinue }
$psExe = if ($psCmd) { $psCmd.Source } else { "powershell" }

# Prefer an already-installed manager.
$installed = Join-Path $LocalAppData "claudesync\claudesync-setup.ps1"
$setup = $null
$cleanup = $null
if ($ScriptDir -and (Test-Path (Join-Path $ScriptDir "claudesync-setup.ps1"))) {
    $setup = Join-Path $ScriptDir "claudesync-setup.ps1"
}
elseif (Test-Path $installed) {
    $setup = $installed
}
else {
    $setup = [System.IO.Path]::GetTempPath() + [guid]::NewGuid().ToString() + ".ps1"
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
    if (-not $got) { Write-Host "uninstall.ps1: could not obtain claudesync-setup.ps1" -ForegroundColor Red; exit 1 }
}

& $psExe -NoProfile -ExecutionPolicy Bypass -File $setup uninstall @Rest
$rc = $LASTEXITCODE
if ($cleanup) { Remove-Item $cleanup -Force -ErrorAction SilentlyContinue }
exit $rc
