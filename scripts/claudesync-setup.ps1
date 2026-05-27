#Requires -Version 5.1
<#
.SYNOPSIS
    claudesync-setup -- install / update / uninstall manager for ClaudeSync (Windows).
.DESCRIPTION
    Components: synchronizer (claudesync fn + image), mcp (wrapper + image),
    broker (host cookie reader; dependency of both).

    Examples:
      claudesync-setup                         # install everything, latest
      claudesync-setup install 0.6.1
      claudesync-setup install -Mcp -McpVersion 0.5.2 -Synchronizer
      claudesync-setup update -PinDigest
      claudesync-setup uninstall -Mcp
      irm <url> | iex                          # bootstrap (no args)
      & ([scriptblock]::Create((irm <url>))) update -Mcp -DryRun
.NOTES
    Compatible with Windows PowerShell 5.1 and PowerShell 7+.
#>
param(
    [Parameter(Position = 0)] [string] $Command = "",
    [Parameter(Position = 1)] [string] $Version = "",
    [switch] $Synchronizer,
    [string] $SynchronizerVersion = "",
    [switch] $Mcp,
    [string] $McpVersion = "",
    [switch] $Broker,
    [switch] $Force,
    [switch] $DryRun,
    [switch] $PinDigest,
    [ValidateSet("", "claude-code", "claude-desktop", "mcp-json", "skip")]
    [string] $Target = "",
    [switch] $Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 6) {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
}

# --- constants ---
$ImageSync = "deathnerd/claudesync"
$ImageMcp  = "deathnerd/claudesync-mcp"
$RawBase   = "https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main"
$LocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME ".local/share" }
$DataDir   = Join-Path $LocalAppData "claudesync"
$BrokerDest = Join-Path $DataDir "Harvest-Cookie.ps1"
$SetupDest  = Join-Path $DataDir "claudesync-setup.ps1"
$McpWrapperPs1 = Join-Path $DataDir "claudesync-mcp.ps1"
$McpWrapperCmd = Join-Path $DataDir "claudesync-mcp.cmd"
$StateFile  = Join-Path $DataDir "setup-state.json"
$Marker = "# claudesync -- installed by https://github.com/InfiniteRoomLabs/claudesync"
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $null }

function Write-Info    { param([string]$m) Write-Host "[claudesync-setup] $m" -ForegroundColor Cyan }
function Write-Success { param([string]$m) Write-Host "[claudesync-setup] $m" -ForegroundColor Green }
function Write-Warn    { param([string]$m) Write-Host "[claudesync-setup] $m" -ForegroundColor Yellow }
function Write-DryRun  { param([string]$m) Write-Host "[dry-run] $m" -ForegroundColor Yellow }
function Stop-Setup    { param([string]$m) Write-Host "[claudesync-setup] $m" -ForegroundColor Red; exit 1 }

function Show-Usage {
@"
claudesync-setup -- manage the ClaudeSync install (Windows)

Usage:
  claudesync-setup [install|update|uninstall] [VERSION] [components] [options]

Components (omit all => everything):
  -Synchronizer [-SynchronizerVersion X]   claudesync CLI fn + image
  -Mcp          [-McpVersion X]            MCP wrapper + image
  -Broker                                  host cookie reader only

Options:
  -Force       no prompts
  -DryRun      print actions only
  -PinDigest   resolve image tags to @sha256 and pin wrappers
  -Help        this help
"@ | Write-Host
}

# --- resolved state ---
$Sub = ""
$GlobalVersion = ""
$DoSync = $false; $DoMcp = $false; $DoBroker = $false
$ExplicitComponents = $false

function Resolve-Args {
    if ($Help) { Show-Usage; exit 0 }

    switch ($Command) {
        ""          { $script:Sub = "install" }
        "install"   { $script:Sub = "install" }
        "update"    { $script:Sub = "update" }
        "uninstall" { $script:Sub = "uninstall" }
        default {
            # First positional was a version, not a subcommand.
            $script:Sub = "install"
            $script:GlobalVersion = $Command
        }
    }
    if (-not $script:GlobalVersion -and $Version) { $script:GlobalVersion = $Version }

    if (-not $SynchronizerVersion) { $script:SynchronizerVersion = $script:GlobalVersion }
    if (-not $McpVersion)          { $script:McpVersion = $script:GlobalVersion }

    $script:DoSync   = [bool]$Synchronizer
    $script:DoMcp    = [bool]$Mcp
    $script:DoBroker = [bool]$Broker
    $script:ExplicitComponents = ($Synchronizer -or $Mcp -or $Broker)

    if (-not $script:ExplicitComponents) {
        $script:DoSync = $true; $script:DoMcp = $true; $script:DoBroker = $true
    }
    if ($script:Sub -ne "uninstall" -and ($script:DoSync -or $script:DoMcp)) {
        $script:DoBroker = $true
    }
}

function Confirm-Action {
    param([string]$Message)
    if ($Force -or $DryRun) { return $true }
    $r = Read-Host "[claudesync-setup] $Message [y/N]"
    return ($r -eq 'y' -or $r -eq 'Y')
}

# Resolve image tag -> ref (image:tag, or image@sha256 when -PinDigest).
function Resolve-Ref {
    param([string]$Image, [string]$Ver)
    $tag = if ($Ver) { $Ver } else { "latest" }
    $ref = "${Image}:${tag}"
    if (-not $PinDigest) { return $ref }
    $digest = ""
    try { $digest = (docker buildx imagetools inspect $ref --format '{{.Manifest.Digest}}' 2>$null) } catch {}
    if (-not $digest) {
        try {
            $mj = docker manifest inspect -v $ref 2>$null | ConvertFrom-Json
            $mj = if ($mj -is [array]) { $mj[0] } else { $mj }
            $digest = $mj.Descriptor.digest
        } catch {}
    }
    if (-not $digest) { Stop-Setup "Could not resolve digest for $ref." }
    return "${Image}@${digest}"
}

# Pre-pull a ref. If the daemon refuses tag pulls (digest-enforcing), auto-enable
# -PinDigest for the rest of the run and return $false (caller re-resolves + retries).
function Invoke-PullOrDetect {
    param([string]$Ref)
    if ($DryRun) { Write-DryRun "docker pull $Ref"; return $true }
    $err = (docker pull $Ref 2>&1 | Out-String)
    if ($LASTEXITCODE -eq 0) { return $true }
    if ($err -match '(?i)@sha256|digest|content trust|DOCKER_CONTENT_TRUST') {
        if (-not $PinDigest) {
            Write-Warn "Docker refuses tag pulls (digest-enforcing) -- enabling -PinDigest automatically."
            $script:PinDigest = $true
            return $false
        }
    }
    Write-Warn "Could not pre-pull $Ref (will pull on first use)."
    return $true
}

function Copy-FromImage {
    param([string]$ImageTag, [string]$ImagePath, [string]$Dest)
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
    $cid = (docker create $ImageTag 2>$null | Select-Object -First 1)
    if (-not $cid) { return $false }
    try { docker cp "${cid}:$ImagePath" $Dest 2>$null | Out-Null; return (Test-Path $Dest) }
    finally { docker rm -f $cid 2>$null | Out-Null }
}

# Fetch a repo asset: local repo -> image -> GitHub (loud). Returns $true/$false.
function Get-Asset {
    param([string]$RepoPath, [string]$Dest, [string]$ImageTag, [string]$ImagePath)
    if ($ScriptDir) {
        $local = Join-Path $ScriptDir ($RepoPath -replace '^scripts[\\/]', '' -replace '/', '\')
        if (Test-Path $local) {
            if ($DryRun) { Write-DryRun "cp $local -> $Dest" } else { Copy-Item $local $Dest -Force }
            return $true
        }
    }
    if (Copy-FromImage $ImageTag $ImagePath $Dest) { return $true }
    Write-Warn "FALLBACK: fetching $RepoPath from GitHub (main) -- may differ from your pinned image."
    try {
        if ($DryRun) { Write-DryRun "download $RawBase/$RepoPath -> $Dest" }
        else { Invoke-WebRequest -Uri "$RawBase/$RepoPath" -OutFile $Dest -UseBasicParsing }
        return $true
    } catch { Write-Warn "Download failed: $RawBase/$RepoPath"; return $false }
}

function Ensure-Dir { param([string]$d) if ($DryRun) { Write-DryRun "mkdir $d" } elseif (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }

# --- broker ---
function Install-Broker {
    Write-Info "Installing cookie broker ..."
    Ensure-Dir $DataDir
    if (-not (Get-Asset "scripts/lib/Harvest-Cookie.ps1" $BrokerDest "${ImageSync}:$(if($SynchronizerVersion){$SynchronizerVersion}else{'latest'})" "/opt/claudesync/host/lib/Harvest-Cookie.ps1")) {
        Stop-Setup "Cookie broker is required but could not be installed."
    }
    Write-Success "Broker -> $BrokerDest"
}
function Uninstall-Broker {
    Write-Info "Removing cookie broker + rookie cache ..."
    if ($DryRun) { Write-DryRun "rm $BrokerDest and rookie cache" }
    else {
        Remove-Item $BrokerDest -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $DataDir "rookie-cli.exe") -Force -ErrorAction SilentlyContinue
    }
    Write-Success "Broker removed."
}

# --- synchronizer ($PROFILE function) ---
function New-SyncFunction {
    param([string]$Ref)
    $tpl = @'

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
'@
    return ($tpl -replace '__REF__', $Ref)
}

function Remove-ProfileBlock {
    if (-not (Test-Path $PROFILE)) { return }
    if ($DryRun) { Write-DryRun "remove claudesync block from $PROFILE"; return }
    $content = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
    if (-not $content) { return }
    $pattern = [regex]::Escape($Marker) + '[\s\S]*?function claudesync\s*\{[\s\S]*?\n\}\s*'
    $content = [regex]::Replace($content, $pattern, '')
    Set-Content -Path $PROFILE -Value $content -NoNewline
}

function Install-Synchronizer {
    $ref = Resolve-Ref $ImageSync $SynchronizerVersion
    Write-Info "Installing synchronizer (image ref: $ref) ..."
    if (-not (Invoke-PullOrDetect $ref)) {
        $ref = Resolve-Ref $ImageSync $SynchronizerVersion
        Write-Info "Re-resolved to $ref"
        if (-not $DryRun) { docker pull $ref 2>$null | Out-Null }
    }

    $profileDir = Split-Path $PROFILE -Parent
    Ensure-Dir $profileDir
    if (-not (Test-Path $PROFILE) -and -not $DryRun) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }

    $content = if (Test-Path $PROFILE) { Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue } else { "" }
    if ($content -and $content.Contains("function claudesync")) {
        if (-not (Confirm-Action "Replace existing claudesync function in `$PROFILE?")) { Write-Warn "Left `$PROFILE unchanged."; return }
        Remove-ProfileBlock
    }
    if ($DryRun) { Write-DryRun "append claudesync() pinned to $ref to $PROFILE" }
    else { Add-Content -Path $PROFILE -Value (New-SyncFunction $ref) }
    Write-Success "Synchronizer -> `$PROFILE"
}

function Uninstall-Synchronizer {
    Write-Info "Removing synchronizer ..."
    Remove-ProfileBlock
    Write-Success "Synchronizer removed (open a new shell)."
}

# Strip the claudesync-setup completion block from $PROFILE.
function Remove-CompletionBlock {
    if (-not (Test-Path $PROFILE)) { return }
    if ($DryRun) { Write-DryRun "remove claudesync-setup completion from `$PROFILE"; return }
    $content = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
    if (-not $content) { return }
    $pattern = [regex]::Escape($CompletionMarker) + '[\s\S]*?Register-ArgumentCompleter[\s\S]*?\n\}\s*'
    $content = [regex]::Replace($content, $pattern, '')
    Set-Content -Path $PROFILE -Value $content -NoNewline
}

# --- mcp wrapper (.ps1 + .cmd) ---
function Install-Mcp {
    $ref = Resolve-Ref $ImageMcp $McpVersion
    Write-Info "Installing MCP wrapper (image ref: $ref) ..."
    if (-not (Invoke-PullOrDetect $ref)) {
        $ref = Resolve-Ref $ImageMcp $McpVersion
        Write-Info "Re-resolved to $ref"
        if (-not $DryRun) { docker pull $ref 2>$null | Out-Null }
    }
    Ensure-Dir $DataDir

    $ps1 = @'
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
'@
    $ps1 = $ps1 -replace '__REF__', $ref
    $cmd = @"
@echo off
REM claudesync-mcp wrapper. Prefers pwsh 7+, falls back to Windows PowerShell.
where pwsh >nul 2>&1 && (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0claudesync-mcp.ps1" %*
    exit /b %ERRORLEVEL%
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0claudesync-mcp.ps1" %*
exit /b %ERRORLEVEL%
"@
    if ($DryRun) { Write-DryRun "write MCP wrapper (.ps1 + .cmd) pinned to $ref to $DataDir" }
    else {
        Set-Content -Path $McpWrapperPs1 -Value $ps1 -Encoding UTF8
        Set-Content -Path $McpWrapperCmd -Value $cmd -Encoding ASCII
    }
    Write-Success "MCP wrapper -> $McpWrapperCmd"
    Configure-Mcp
}

function Uninstall-Mcp {
    Write-Info "Removing MCP wrapper ..."
    if ($DryRun) { Write-DryRun "rm $McpWrapperPs1, $McpWrapperCmd" }
    else {
        Remove-Item $McpWrapperPs1 -Force -ErrorAction SilentlyContinue
        Remove-Item $McpWrapperCmd -Force -ErrorAction SilentlyContinue
    }
    Write-Warn "MCP config entries are left untouched -- remove 'claudesync' manually if desired."
    Write-Success "MCP wrapper removed."
}

# Merge the claudesync MCP server entry into a client config file.
function Merge-McpServer {
    param([string]$FilePath)
    if ($DryRun) { Write-DryRun "add 'claudesync' MCP entry to $FilePath"; return }
    $json = $null
    if (Test-Path $FilePath) {
        $c = Get-Content $FilePath -Raw -ErrorAction SilentlyContinue
        if ($c) { $json = $c | ConvertFrom-Json }
    }
    if (-not $json) { $json = [PSCustomObject]@{} }
    # Use the property indexer (strict-mode safe even when empty).
    if (-not $json.PSObject.Properties['mcpServers']) {
        $json | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([PSCustomObject]@{}) -Force
    }
    if ($json.mcpServers.PSObject.Properties['claudesync']) {
        $json.mcpServers.PSObject.Properties.Remove('claudesync')
    }
    $cfg = [PSCustomObject]@{ command = $McpWrapperCmd; args = @() }
    $json.mcpServers | Add-Member -NotePropertyName claudesync -NotePropertyValue $cfg -Force
    $json | ConvertTo-Json -Depth 10 | Set-Content $FilePath -Encoding UTF8
    Write-Success "MCP server entry written to $FilePath"
}

function Configure-Mcp {
    $t = $Target
    if (-not $t) {
        if ([Environment]::UserInteractive -and -not $DryRun) {
            Write-Host "`n  Configure ClaudeSync MCP for:" -ForegroundColor White
            Write-Host "    1) Claude Code  2) Claude Desktop  3) Project .mcp.json  4) Skip"
            switch (Read-Host "  Choice [1-4]") {
                "1" { $t = "claude-code" } "2" { $t = "claude-desktop" } "3" { $t = "mcp-json" } default { $t = "skip" }
            }
        }
        else {
            Write-Info "No -Target given; skipping MCP client config. Register manually with command: $McpWrapperCmd"
            return
        }
    }
    switch ($t) {
        "skip"           { Write-Info "Register manually with command: $McpWrapperCmd" }
        "claude-code"    { Merge-McpServer (Join-Path $HOME ".claude.json") }
        "claude-desktop" {
            $f = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
            Ensure-Dir (Split-Path $f -Parent); Merge-McpServer $f
        }
        "mcp-json"       { Merge-McpServer (Join-Path (Get-Location) ".mcp.json") }
        default          { Write-Warn "Unknown -Target '$t'; skipping." }
    }
}

# --- self-install + completion (PowerShell uses Register-ArgumentCompleter in $PROFILE) ---
$CompletionMarker = "# claudesync-setup completion"
$IsWin = (-not (Test-Path variable:IsWindows)) -or $IsWindows

# Ensure $DataDir is on the user PATH so the .cmd shims (claudesync-setup,
# claudesync-mcp) resolve as commands. Windows only.
function Ensure-OnPath {
    param([string]$Dir)
    if (-not $IsWin) { return }
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -and (($userPath -split ';') -contains $Dir)) { return }
    if ($DryRun) { Write-DryRun "add $Dir to user PATH"; return }
    $new = if ($userPath) { "$userPath;$Dir" } else { $Dir }
    [Environment]::SetEnvironmentVariable("PATH", $new, "User")
    $env:PATH = "$env:PATH;$Dir"
    Write-Info "Added $Dir to user PATH (new shells will see it)."
}

# A .cmd shim that resolves a PowerShell script as a bare command name.
function Write-CmdShim {
    param([string]$CmdPath, [string]$Ps1Name)
    $c = @"
@echo off
where pwsh >nul 2>&1 && (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0$Ps1Name" %*
    exit /b %ERRORLEVEL%
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0$Ps1Name" %*
exit /b %ERRORLEVEL%
"@
    if ($DryRun) { Write-DryRun "write $CmdPath" } else { Set-Content -Path $CmdPath -Value $c -Encoding ASCII }
}

function Install-Self {
    Ensure-Dir $DataDir
    if ($ScriptDir -and (Test-Path (Join-Path $ScriptDir "claudesync-setup.ps1")) -and ((Join-Path $ScriptDir "claudesync-setup.ps1") -ne $SetupDest)) {
        if ($DryRun) { Write-DryRun "cp claudesync-setup.ps1 -> $SetupDest" }
        else { Copy-Item (Join-Path $ScriptDir "claudesync-setup.ps1") $SetupDest -Force }
    } elseif (-not (Test-Path $SetupDest)) {
        Get-Asset "scripts/claudesync-setup.ps1" $SetupDest "${ImageSync}:latest" "/opt/claudesync/host/claudesync-setup.ps1" | Out-Null
    }
    # .cmd shim + PATH so `claudesync-setup` resolves as a command.
    Write-CmdShim (Join-Path $DataDir "claudesync-setup.cmd") "claudesync-setup.ps1"
    Ensure-OnPath $DataDir
    # Completion block in $PROFILE
    $block = @"

$CompletionMarker
Register-ArgumentCompleter -CommandName claudesync-setup -ScriptBlock {
    param(`$wordToComplete, `$commandAst, `$cursorPosition)
    @('install','update','uninstall','-Synchronizer','-Mcp','-Broker','-Force','-DryRun','-PinDigest','-Target','-Help') |
        Where-Object { `$_ -like "`$wordToComplete*" } |
        ForEach-Object { [System.Management.Automation.CompletionResult]::new(`$_, `$_, 'ParameterValue', `$_) }
}
"@
    if (Test-Path $PROFILE) {
        $pc = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
        if ($pc -and $pc.Contains($CompletionMarker)) { return }
    }
    if ($DryRun) { Write-DryRun "add claudesync-setup completion to $PROFILE" }
    else { Add-Content -Path $PROFILE -Value $block }
}

function Write-State {
    if ($DryRun) { return }
    Ensure-Dir $DataDir
    $sv = if ($SynchronizerVersion) { $SynchronizerVersion } else { "latest" }
    $mv = if ($McpVersion) { $McpVersion } else { "latest" }
    $pd = if ($PinDigest) { "true" } else { "false" }
    @"
{
  "synchronizer": {"version": "$sv", "pin_digest": $pd},
  "mcp": {"version": "$mv", "pin_digest": $pd}
}
"@ | Set-Content -Path $StateFile -Encoding UTF8
}

# --- dispatch ---
Resolve-Args

if ($Sub -eq "install" -or $Sub -eq "update") {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Stop-Setup "Docker is required. https://docs.docker.com/desktop/install/windows-install/" }
    if ($DoBroker) { Install-Broker }
    if ($DoSync)   { Install-Synchronizer }
    if ($DoMcp)    { Install-Mcp }
    Install-Self   # always: keep the manager + its completion available on PATH
    Write-State
    Write-Success "Done ($Sub)."
}
elseif ($Sub -eq "uninstall") {
    if ($DoMcp)    { Uninstall-Mcp }
    if ($DoSync)   { Uninstall-Synchronizer }
    if ($DoBroker) { Uninstall-Broker }
    if (-not $ExplicitComponents) {
        Remove-CompletionBlock
        if ($DryRun) { Write-DryRun "rm $SetupDest, setup .cmd shim, $StateFile" }
        else {
            Remove-Item $SetupDest -Force -ErrorAction SilentlyContinue
            Remove-Item (Join-Path $DataDir "claudesync-setup.cmd") -Force -ErrorAction SilentlyContinue
            Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Success "Done (uninstall)."
}
else { Stop-Setup "Unknown subcommand: $Sub" }
