#Requires -Version 5.1
<#
.SYNOPSIS
    ClaudeSync MCP Server installer -- PowerShell/Windows version
.DESCRIPTION
    Configures the ClaudeSync MCP server for Claude Code, Claude Desktop, or a project .mcp.json.
    Creates a wrapper script that reads browser cookies and runs the Docker container.
.NOTES
    Usage:
      .\scripts\install-mcp.ps1
      .\scripts\install-mcp.ps1 --target claude-code
      .\scripts\install-mcp.ps1 --target claude-desktop
      .\scripts\install-mcp.ps1 --target mcp-json

    Supports: PowerShell 5.1 (Windows PowerShell) and PowerShell 7+ (pwsh)
    Dependencies: Docker Desktop for Windows
#>

# ---------------------------------------------------------------------------
# Strict mode
# ---------------------------------------------------------------------------
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
param(
    [ValidateSet("", "claude-code", "claude-desktop", "mcp-json")]
    [string]$Target = "",

    [switch]$Force
)

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
function Write-Info    { param([string]$Message) Write-Host "[claudesync-mcp] $Message" -ForegroundColor Cyan }
function Write-Success { param([string]$Message) Write-Host "[claudesync-mcp] $Message" -ForegroundColor Green }
function Write-Warn    { param([string]$Message) Write-Host "[claudesync-mcp] $Message" -ForegroundColor Yellow }
function Write-Err     { param([string]$Message) Write-Host "[claudesync-mcp] $Message" -ForegroundColor Red }
function Stop-Install  { param([string]$Message) Write-Err $Message; throw $Message }

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  ClaudeSync MCP Server installer" -ForegroundColor White
Write-Host "  https://github.com/InfiniteRoomLabs/claudesync" -ForegroundColor White
Write-Host ""

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-Install "Docker is not installed or not on PATH. Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/"
}

Write-Info "Checking Docker image deathnerd/claudesync-mcp:latest ..."
$inspectResult = docker image inspect deathnerd/claudesync-mcp:latest 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Info "Image not found locally -- pulling from Docker Hub ..."
    docker pull deathnerd/claudesync-mcp:latest
    if ($LASTEXITCODE -ne 0) {
        Stop-Install "Failed to pull deathnerd/claudesync-mcp:latest. Check your internet connection and Docker login."
    }
}
Write-Success "Docker image ready."

# ---------------------------------------------------------------------------
# Install the shared cookie broker (Harvest-Cookie.ps1)
# Source order: local repo (dev) -> pulled MCP image (version-locked) -> GitHub.
# The generated wrapper calls this; same broker the CLI uses.
# ---------------------------------------------------------------------------
function Copy-FromImage {
    param([string]$ImagePath, [string]$Dest)
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
    $cid = (docker create deathnerd/claudesync-mcp:latest 2>$null | Select-Object -First 1)
    if (-not $cid) { return $false }
    try {
        docker cp "${cid}:$ImagePath" $Dest 2>$null | Out-Null
        return (Test-Path $Dest)
    } finally {
        docker rm -f $cid 2>$null | Out-Null
    }
}

$brokerDir  = Join-Path $env:LOCALAPPDATA 'claudesync'
$brokerDest = Join-Path $brokerDir 'Harvest-Cookie.ps1'
New-Item -ItemType Directory -Path $brokerDir -Force | Out-Null

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $null }
$localBroker = if ($scriptDir) { Join-Path $scriptDir 'lib\Harvest-Cookie.ps1' } else { $null }

if ($localBroker -and (Test-Path $localBroker)) {
    Copy-Item $localBroker $brokerDest -Force
    Write-Success "Installed cookie broker from local repo into $brokerDest"
}
elseif (Copy-FromImage '/opt/claudesync/host/lib/Harvest-Cookie.ps1' $brokerDest) {
    Write-Success "Installed cookie broker from image into $brokerDest"
}
else {
    Write-Warn "FALLBACK: could not source the broker from the local repo or the Docker image."
    Write-Warn "  Fetching the LATEST broker from GitHub (main branch) instead --"
    Write-Warn "  this may not match your pinned image version."
    if ($PSVersionTable.PSVersion.Major -lt 6) {
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
    }
    $brokerUrl = "https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/lib/Harvest-Cookie.ps1"
    Invoke-WebRequest -Uri $brokerUrl -OutFile $brokerDest -UseBasicParsing
    Write-Success "Installed cookie broker from GitHub (main) into $brokerDest"
}

# ---------------------------------------------------------------------------
# Wrapper directory and paths
# ---------------------------------------------------------------------------
$WrapperDir = Join-Path $env:LOCALAPPDATA "claudesync"
$WrapperPs1 = Join-Path $WrapperDir "claudesync-mcp.ps1"
$WrapperCmd = Join-Path $WrapperDir "claudesync-mcp.cmd"

# ---------------------------------------------------------------------------
# Create the PowerShell wrapper script
# ---------------------------------------------------------------------------
function New-WrapperScript {
    if (-not (Test-Path $WrapperDir)) {
        New-Item -ItemType Directory -Path $WrapperDir -Force | Out-Null
    }

    # Check for existing wrapper files
    $existingPs1 = Test-Path $WrapperPs1
    $existingCmd = Test-Path $WrapperCmd
    if ($existingPs1 -or $existingCmd) {
        $doReplace = $false
        if ($Force) {
            Write-Info "Existing wrapper scripts found -- replacing (--Force)."
            $doReplace = $true
        }
        else {
            Write-Warn "Wrapper scripts already exist:"
            if ($existingPs1) { Write-Warn "  $WrapperPs1" }
            if ($existingCmd)  { Write-Warn "  $WrapperCmd" }
            $response = Read-Host "  Replace existing wrapper scripts? [y/N]"
            if ($response -eq "y" -or $response -eq "Y") {
                $doReplace = $true
            }
            else {
                Write-Info "Skipping wrapper script installation."
                return
            }
        }

        if ($doReplace) {
            if ($existingPs1) { Remove-Item $WrapperPs1 -Force }
            if ($existingCmd)  { Remove-Item $WrapperCmd -Force }
            Write-Success "Removed old wrapper scripts."
        }
    }

    # -- The .ps1 wrapper --
    $ps1Content = @'
#Requires -Version 5.1
# claudesync-mcp wrapper -- resolves the cookie via the shared broker
# (Harvest-Cookie.ps1) and runs the MCP Docker container over stdio.
# Installed by: https://github.com/InfiniteRoomLabs/claudesync
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function _Mcp_Error {
    param([string]$Message)
    $errJson = '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"claudesync-mcp: ' + ($Message -replace '"', '\"') + '"}}'
    [Console]::Error.WriteLine($errJson)
    exit 1
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    _Mcp_Error "docker not found. Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/"
}

$broker = Join-Path $env:LOCALAPPDATA "claudesync\Harvest-Cookie.ps1"
if (-not (Test-Path $broker)) {
    _Mcp_Error "cookie broker missing at $broker; re-run install-mcp.ps1"
}

# Run the broker in a child process with -ExecutionPolicy Bypass (prefer pwsh 7+,
# fall back to Windows PowerShell 5.1; the broker supports both).
$psExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $psExe) { $psExe = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
if (-not $psExe) { $psExe = "powershell" }

$cookieHeader = & $psExe -NoProfile -ExecutionPolicy Bypass -File $broker
$cookieHeader = ($cookieHeader | Where-Object { $_ } | Select-Object -Last 1)
if (-not $cookieHeader) {
    _Mcp_Error "Could not read sessionKey cookie. Log in to claude.ai in a browser, or set CLAUDE_AI_COOKIE='sessionKey=<value>'."
}

# -- run the MCP container (stdio) --
docker run --rm -i `
    -e "CLAUDE_AI_COOKIE=$cookieHeader" `
    deathnerd/claudesync-mcp:latest
'@

    Set-Content -Path $WrapperPs1 -Value $ps1Content -Encoding UTF8
    Write-Success "PowerShell wrapper installed at $WrapperPs1"

    # -- The .cmd wrapper (needed by Claude Code/Desktop which expect a simple command) --
    $cmdContent = @"
@echo off
REM claudesync-mcp wrapper -- invokes the PowerShell script for cookie reading + Docker
REM Installed by: https://github.com/InfiniteRoomLabs/claudesync
REM
REM This .cmd file exists because Claude Code and Claude Desktop need a simple
REM command path (not a .ps1). It delegates to PowerShell for the heavy lifting.

REM Try pwsh (PowerShell 7+) first, fall back to powershell.exe (5.1)
where pwsh >nul 2>&1 && (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0claudesync-mcp.ps1" %*
    exit /b %ERRORLEVEL%
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0claudesync-mcp.ps1" %*
exit /b %ERRORLEVEL%
"@

    Set-Content -Path $WrapperCmd -Value $cmdContent -Encoding ASCII
    Write-Success "CMD wrapper installed at $WrapperCmd"
}

New-WrapperScript

# ---------------------------------------------------------------------------
# Check if wrapper dir is on PATH
# ---------------------------------------------------------------------------
$pathDirs = $env:PATH -split ";"
if ($pathDirs -notcontains $WrapperDir) {
    Write-Warn "$WrapperDir is not on your PATH."
    Write-Warn "Adding it to your user PATH..."
    try {
        $currentUserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
        if ($currentUserPath -and -not ($currentUserPath -split ";" | Where-Object { $_ -eq $WrapperDir })) {
            [Environment]::SetEnvironmentVariable("PATH", "$currentUserPath;$WrapperDir", "User")
            $env:PATH = "$env:PATH;$WrapperDir"
            Write-Success "Added $WrapperDir to user PATH. New terminals will pick it up automatically."
        }
        elseif (-not $currentUserPath) {
            [Environment]::SetEnvironmentVariable("PATH", $WrapperDir, "User")
            $env:PATH = "$env:PATH;$WrapperDir"
            Write-Success "Added $WrapperDir to user PATH."
        }
        else {
            Write-Info "$WrapperDir is already in user PATH."
        }
    }
    catch {
        Write-Warn "Could not modify user PATH automatically."
        Write-Warn "Please add $WrapperDir to your PATH manually."
    }
}

# ---------------------------------------------------------------------------
# JSON merge helpers
# ---------------------------------------------------------------------------
function Merge-McpServer {
    param(
        [string]$FilePath,
        [string]$ServerName,
        [hashtable]$Config
    )

    $json = @{}
    if (Test-Path $FilePath) {
        $content = Get-Content $FilePath -Raw -ErrorAction SilentlyContinue
        if ($content) {
            $json = $content | ConvertFrom-Json
        }
    }

    # Ensure mcpServers exists
    if (-not $json.mcpServers) {
        $json | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue (New-Object PSObject) -Force
    }

    # Check for existing entry
    if ($json.mcpServers.PSObject.Properties.Name -contains $ServerName) {
        if ($Force) {
            Write-Info "  Entry '$ServerName' already present in $FilePath -- replacing (--Force)."
            $json.mcpServers.PSObject.Properties.Remove($ServerName)
        }
        else {
            Write-Warn "  Entry '$ServerName' already present in $FilePath."
            $response = Read-Host "  Replace existing MCP server entry? [y/N]"
            if ($response -eq "y" -or $response -eq "Y") {
                $json.mcpServers.PSObject.Properties.Remove($ServerName)
            }
            else {
                Write-Info "  Skipping MCP config update for $FilePath."
                return
            }
        }
    }

    # Add the server config
    $json.mcpServers | Add-Member -NotePropertyName $ServerName -NotePropertyValue ([PSCustomObject]$Config) -Force

    # Write back as formatted JSON
    $json | ConvertTo-Json -Depth 10 | Set-Content $FilePath -Encoding UTF8
    Write-Success "MCP server entry written to $FilePath"
}

# MCP config block referencing the .cmd wrapper
$McpConfig = @{
    command = $WrapperCmd
    args    = @()
}

# ---------------------------------------------------------------------------
# Installation targets
# ---------------------------------------------------------------------------
function Install-ClaudeCode {
    Write-Host ""
    Write-Host "  Install scope:"
    Write-Host "    1) Global (user-level) -- ~/.claude.json"
    Write-Host "    2) Project (current directory) -- .mcp.json"
    Write-Host ""
    $scope = Read-Host "  Enter choice [1/2]"

    switch ($scope) {
        "2" {
            $targetFile = Join-Path $PWD ".mcp.json"
            Write-Info "Writing to project .mcp.json: $targetFile"
        }
        default {
            $targetFile = Join-Path $HOME ".claude.json"
            Write-Info "Writing to global config: $targetFile"
        }
    }

    Merge-McpServer -FilePath $targetFile -ServerName "claudesync" -Config $McpConfig

    Write-Host ""
    Write-Host "  To verify in Claude Code, run:"
    Write-Host "    /mcp" -ForegroundColor Cyan
    Write-Host "  and look for 'claudesync' in the server list."
    Write-Host ""
}

function Install-ClaudeDesktop {
    $configFile = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
    $configDir = Split-Path $configFile -Parent

    Write-Info "Target config: $configFile"

    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    Merge-McpServer -FilePath $configFile -ServerName "claudesync" -Config $McpConfig

    Write-Host ""
    Write-Host "  Restart Claude Desktop and look for the hammer icon (MCP tools)."
    Write-Host "  The claudesync tools will appear when a conversation starts."
    Write-Host ""
}

function Install-McpJson {
    $mcpFile = Join-Path $PWD ".mcp.json"
    Write-Info "Target file: $mcpFile"

    Merge-McpServer -FilePath $mcpFile -ServerName "claudesync" -Config $McpConfig

    Write-Host ""
    Write-Host "  Commit .mcp.json to share this configuration with your team."
    Write-Host "  Each team member must have claudesync-mcp installed locally."
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Interactive target selection (when --target not provided)
# ---------------------------------------------------------------------------
function Select-Target {
    Write-Host ""
    Write-Host "  Where do you want to configure ClaudeSync MCP?"
    Write-Host ""
    Write-Host "    1) Claude Code  (global or project-level)"
    Write-Host "    2) Claude Desktop"
    Write-Host "    3) Project .mcp.json  (current directory)"
    Write-Host ""
    $choice = Read-Host "  Enter choice [1-3]"

    switch ($choice) {
        "1" { return "claude-code" }
        "2" { return "claude-desktop" }
        "3" { return "mcp-json" }
        default {
            Write-Warn "Invalid choice '$choice'. Defaulting to project .mcp.json."
            return "mcp-json"
        }
    }
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
if (-not $Target) {
    $Target = Select-Target
}

switch ($Target) {
    "claude-code"    { Install-ClaudeCode }
    "claude-desktop" { Install-ClaudeDesktop }
    "mcp-json"       { Install-McpJson }
}

# ---------------------------------------------------------------------------
# Final verification hint
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  Done! Wrapper: $WrapperCmd" -ForegroundColor White
Write-Host ""
Write-Host "  The wrapper reads your Chrome (DPAPI) or Firefox sessionKey at invocation time."
Write-Host "  If the cookie expires, just log in to claude.ai again."
Write-Host ""
Write-Host "  To smoke-test the wrapper directly:" -ForegroundColor White
Write-Host "    echo '{""jsonrpc"":""2.0"",""id"":1,""method"":""tools/list""}' | $WrapperCmd" -ForegroundColor Cyan
Write-Host ""
