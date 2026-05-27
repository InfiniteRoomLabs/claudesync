#Requires -Version 5.1
<#
.SYNOPSIS
    ClaudeSync installer -- PowerShell/Windows version
.DESCRIPTION
    Installs a `claudesync` function into your PowerShell profile that:
      1. Reads your browser sessionKey cookie via the rookie-based broker (Chrome/Edge/Firefox), or env var
      2. Passes it as CLAUDE_AI_COOKIE to the Docker container
      3. Mounts the current directory as /data for export commands
.NOTES
    Usage: irm https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/install.ps1 | iex

    Supports: PowerShell 5.1 (Windows PowerShell) and PowerShell 7+ (pwsh)
    Dependencies: Docker Desktop for Windows
#>

param(
    [switch]$Force
)

# ---------------------------------------------------------------------------
# Strict mode
# ---------------------------------------------------------------------------
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 often defaults to TLS 1.0; GitHub requires TLS 1.2+.
if ($PSVersionTable.PSVersion.Major -lt 6) {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
}

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
function Write-Info    { param([string]$Message) Write-Host "[claudesync] $Message" -ForegroundColor Cyan }
function Write-Success { param([string]$Message) Write-Host "[claudesync] $Message" -ForegroundColor Green }
function Write-Warn    { param([string]$Message) Write-Host "[claudesync] $Message" -ForegroundColor Yellow }
function Write-Err     { param([string]$Message) Write-Host "[claudesync] $Message" -ForegroundColor Red }
function Stop-Install  { param([string]$Message) Write-Err $Message; throw $Message }

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  ClaudeSync -- your claude.ai data, your way" -ForegroundColor White
Write-Host "  https://github.com/InfiniteRoomLabs/claudesync" -ForegroundColor White
Write-Host ""

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-Install "Docker is not installed or not on PATH. Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/"
}

Write-Info "Checking Docker image deathnerd/claudesync:latest ..."
$inspectResult = docker image inspect deathnerd/claudesync:latest 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Info "Image not found locally -- pulling from Docker Hub ..."
    docker pull deathnerd/claudesync:latest
    if ($LASTEXITCODE -ne 0) {
        Stop-Install "Failed to pull deathnerd/claudesync:latest. Check your internet connection and Docker login."
    }
}
Write-Success "Docker image ready."

# ---------------------------------------------------------------------------
# The function body to install into $PROFILE
# ---------------------------------------------------------------------------
$FunctionBody = @'

# claudesync -- installed by https://github.com/InfiniteRoomLabs/claudesync

function claudesync {
    <#
    .SYNOPSIS
        Run ClaudeSync CLI via Docker, reading the claude.ai sessionKey cookie
        via the shared host-side broker (Harvest-Cookie.ps1, rookie-based).
    #>
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host "claudesync: Docker is not installed." -ForegroundColor Red
        Write-Host "  Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/" -ForegroundColor Red
        return
    }

    $broker = Join-Path $env:LOCALAPPDATA "claudesync\Harvest-Cookie.ps1"
    if (-not (Test-Path $broker)) {
        Write-Host "claudesync: cookie broker missing at $broker" -ForegroundColor Red
        Write-Host "  Re-run the installer, or set `$env:CLAUDE_AI_COOKIE manually." -ForegroundColor Red
        return
    }

    # Run the broker in a child process with -ExecutionPolicy Bypass so it works
    # even under a Restricted policy. Prefer pwsh 7+, fall back to Windows
    # PowerShell 5.1; the broker is compatible with both.
    $psExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
    if (-not $psExe) { $psExe = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
    if (-not $psExe) { $psExe = "powershell" }

    $cookie = & $psExe -NoProfile -ExecutionPolicy Bypass -File $broker
    $cookie = ($cookie | Where-Object { $_ } | Select-Object -Last 1)
    if (-not $cookie) { return }  # broker already printed guidance to the host

    $ttyArgs = @()
    if ($Args.Count -ge 1 -and $Args[0] -eq 'tui') { $ttyArgs = @('-it') }

    docker run --rm @ttyArgs `
        -e "CLAUDE_AI_COOKIE=$cookie" `
        -v "${PWD}:/data" `
        deathnerd/claudesync:latest `
        @Args
}
'@

# ---------------------------------------------------------------------------
# Install the shared cookie broker (Harvest-Cookie.ps1)
# Source order: local repo (dev) -> pulled image (version-locked) -> GitHub raw.
# ---------------------------------------------------------------------------
function Copy-FromImage {
    param([string]$ImagePath, [string]$Dest)
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
    $cid = (docker create deathnerd/claudesync:latest 2>$null | Select-Object -First 1)
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
    $brokerUrl = "https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/lib/Harvest-Cookie.ps1"
    Invoke-WebRequest -Uri $brokerUrl -OutFile $brokerDest -UseBasicParsing
    Write-Success "Installed cookie broker from GitHub (main) into $brokerDest"
}

# ---------------------------------------------------------------------------
# Install the function into $PROFILE
# ---------------------------------------------------------------------------
Write-Info "Detected PowerShell profile: $PROFILE"

# Ensure the profile directory exists
$profileDir = Split-Path $PROFILE -Parent
if (-not (Test-Path $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    Write-Info "Created profile directory: $profileDir"
}

# Ensure the profile file exists
if (-not (Test-Path $PROFILE)) {
    New-Item -ItemType File -Path $PROFILE -Force | Out-Null
    Write-Info "Created profile file: $PROFILE"
}

# Check for existing installation
$profileContent = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
if ($profileContent -and $profileContent.Contains("function claudesync")) {
    $doReplace = $false
    if ($Force) {
        Write-Info "Existing claudesync function found -- replacing (--Force)."
        $doReplace = $true
    }
    else {
        Write-Warn "claudesync function already present in $PROFILE."
        $response = Read-Host "  Replace existing installation? [y/N]"
        if ($response -eq "y" -or $response -eq "Y") {
            $doReplace = $true
        }
        else {
            Write-Info "Skipping profile update."
        }
    }

    if ($doReplace) {
        # Remove the old claudesync block: everything from the marker comment
        # through the closing brace of `function claudesync { ... }`
        $marker = "# claudesync -- installed by https://github.com/InfiniteRoomLabs/claudesync"
        $markerIdx = $profileContent.IndexOf($marker)
        if ($markerIdx -ge 0) {
            # Find the end of the claudesync block. The block ends with a lone '}'
            # that closes `function claudesync`. We search for the pattern:
            # the last function in the block is `function claudesync`, whose closing
            # brace is followed by a newline (or EOF). We use a regex to match the
            # entire installed block.
            $blockPattern = [regex]::Escape($marker) + '[\s\S]*?function claudesync\s*\{[\s\S]*?\n\}\s*'
            $profileContent = [regex]::Replace($profileContent, $blockPattern, '')
            Set-Content -Path $PROFILE -Value $profileContent -NoNewline
            Write-Success "Removed old claudesync block from $PROFILE"
        }
        Add-Content -Path $PROFILE -Value $FunctionBody
        Write-Success "Installed claudesync function into $PROFILE"
    }
}
else {
    Add-Content -Path $PROFILE -Value $FunctionBody
    Write-Success "Installed claudesync function into $PROFILE"
}

# ---------------------------------------------------------------------------
# Install tab completion (Register-ArgumentCompleter)
# ---------------------------------------------------------------------------
$CompletionMarker = "# claudesync tab completion"
$CompletionBody = @'

# claudesync tab completion
Register-ArgumentCompleter -CommandName claudesync -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $subcommands = @(
        [System.Management.Automation.CompletionResult]::new('ls',       'ls',       'ParameterValue', 'List conversations')
        [System.Management.Automation.CompletionResult]::new('export',   'export',   'ParameterValue', 'Export a conversation to a git repository')
        [System.Management.Automation.CompletionResult]::new('projects', 'projects', 'ParameterValue', 'List projects')
        [System.Management.Automation.CompletionResult]::new('search',   'search',   'ParameterValue', 'Search conversations')
    )

    $lsFlags = @(
        [System.Management.Automation.CompletionResult]::new('--org',     '--org',     'ParameterName', 'Organization ID')
        [System.Management.Automation.CompletionResult]::new('--limit',   '--limit',   'ParameterName', 'Max conversations to show')
        [System.Management.Automation.CompletionResult]::new('--starred', '--starred', 'ParameterName', 'Show only starred conversations')
        [System.Management.Automation.CompletionResult]::new('--json',    '--json',    'ParameterName', 'Output as JSON')
        [System.Management.Automation.CompletionResult]::new('--help',    '--help',    'ParameterName', 'Show help')
    )

    $exportFlags = @(
        [System.Management.Automation.CompletionResult]::new('--org',          '--org',          'ParameterName', 'Organization ID')
        [System.Management.Automation.CompletionResult]::new('--output',       '--output',       'ParameterName', 'Output directory')
        [System.Management.Automation.CompletionResult]::new('--format',       '--format',       'ParameterName', 'Output format: git or json')
        [System.Management.Automation.CompletionResult]::new('--author-name',  '--author-name',  'ParameterName', 'Git author name')
        [System.Management.Automation.CompletionResult]::new('--author-email', '--author-email', 'ParameterName', 'Git author email')
        [System.Management.Automation.CompletionResult]::new('--help',         '--help',         'ParameterName', 'Show help')
    )

    $projectsFlags = @(
        [System.Management.Automation.CompletionResult]::new('--org',  '--org',  'ParameterName', 'Organization ID')
        [System.Management.Automation.CompletionResult]::new('--json', '--json', 'ParameterName', 'Output as JSON')
        [System.Management.Automation.CompletionResult]::new('--help', '--help', 'ParameterName', 'Show help')
    )

    $searchFlags = @(
        [System.Management.Automation.CompletionResult]::new('--org',   '--org',   'ParameterName', 'Organization ID')
        [System.Management.Automation.CompletionResult]::new('--limit', '--limit', 'ParameterName', 'Max results to show')
        [System.Management.Automation.CompletionResult]::new('--json',  '--json',  'ParameterName', 'Output as JSON')
        [System.Management.Automation.CompletionResult]::new('--help',  '--help',  'ParameterName', 'Show help')
    )

    $formatValues = @(
        [System.Management.Automation.CompletionResult]::new('git',  'git',  'ParameterValue', 'Export as git repository')
        [System.Management.Automation.CompletionResult]::new('json', 'json', 'ParameterValue', 'Export as JSON')
    )

    $elements = $commandAst.CommandElements
    $subcmd = $null
    for ($i = 1; $i -lt $elements.Count; $i++) {
        $e = $elements[$i].ToString()
        if ($e -in @('ls', 'export', 'projects', 'search')) {
            $subcmd = $e
            break
        }
    }

    # Complete --format values
    if ($elements.Count -ge 2) {
        $prevElement = $elements[$elements.Count - 2].ToString()
        if ($prevElement -eq '--format') {
            return $formatValues | Where-Object { $_.CompletionText -like "$wordToComplete*" }
        }
    }

    if (-not $subcmd) {
        $all = $subcommands + @(
            [System.Management.Automation.CompletionResult]::new('--help',    '--help',    'ParameterName', 'Show help')
            [System.Management.Automation.CompletionResult]::new('--version', '--version', 'ParameterName', 'Show version')
        )
        return $all | Where-Object { $_.CompletionText -like "$wordToComplete*" }
    }

    $flags = switch ($subcmd) {
        'ls'       { $lsFlags }
        'export'   { $exportFlags }
        'projects' { $projectsFlags }
        'search'   { $searchFlags }
    }

    return $flags | Where-Object { $_.CompletionText -like "$wordToComplete*" }
}
'@

Write-Info "Installing tab completion..."
$profileContent = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
if ($profileContent -and $profileContent.Contains($CompletionMarker)) {
    Write-Info "Tab completion already installed in $PROFILE"
}
else {
    Add-Content -Path $PROFILE -Value $CompletionBody
    Write-Success "Installed tab completion into $PROFILE"
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor White
Write-Host ""
Write-Host "  Reload your shell or run:"
Write-Host "    . `$PROFILE" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Then use claudesync as you would the CLI:"
Write-Host "    claudesync --help" -ForegroundColor Cyan
Write-Host "    claudesync export --org <id> --conversation <id>" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Tab completion is installed. Press Tab to complete subcommands and flags."
Write-Host ""
Write-Host "  Files written by export commands land in the current directory"
Write-Host "  (mounted as /data inside the container)."
Write-Host ""
Write-Host "  NOTE: Cookies are read by rookie (auto-downloaded + SHA256-verified"
Write-Host "  on first run). Firefox is the most reliable on Windows: Chrome/Edge >= 127"
Write-Host "  use App-Bound Encryption, which cannot be decrypted -- those users should"
Write-Host "  use Firefox or set \$env:CLAUDE_AI_COOKIE manually."
Write-Host ""
