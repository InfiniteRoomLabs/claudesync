#Requires -Version 5.1
<#
.SYNOPSIS
    ClaudeSync uninstaller -- PowerShell/Windows version
.DESCRIPTION
    Removes ClaudeSync components installed by install.ps1 and install-mcp.ps1:
      1. Removes the claudesync function block from $PROFILE
      2. Removes the MCP wrapper scripts (.ps1 and .cmd)
      3. Removes the claudesync directory from user PATH
      4. Optionally removes Docker images
      5. Prints instructions for manually removing MCP config entries
.NOTES
    Usage: irm https://raw.githubusercontent.com/InfiniteRoomLabs/claudesync/main/scripts/uninstall.ps1 | iex

    Supports: PowerShell 5.1 (Windows PowerShell) and PowerShell 7+ (pwsh)
#>

param(
    [switch]$Force
)

# ---------------------------------------------------------------------------
# Strict mode
# ---------------------------------------------------------------------------
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Color helpers (same style as install scripts)
# ---------------------------------------------------------------------------
function Write-Info    { param([string]$Message) Write-Host "[claudesync] $Message" -ForegroundColor Cyan }
function Write-Success { param([string]$Message) Write-Host "[claudesync] $Message" -ForegroundColor Green }
function Write-Warn    { param([string]$Message) Write-Host "[claudesync] $Message" -ForegroundColor Yellow }
function Write-Err     { param([string]$Message) Write-Host "[claudesync] $Message" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  ClaudeSync Uninstaller" -ForegroundColor White
Write-Host "  https://github.com/InfiniteRoomLabs/claudesync" -ForegroundColor White
Write-Host ""

# Track what we removed for the summary
$removed = @()
$skipped = @()

# ---------------------------------------------------------------------------
# 1. Remove claudesync function block from $PROFILE
# ---------------------------------------------------------------------------
Write-Info "Checking PowerShell profile: $PROFILE"

if (Test-Path $PROFILE) {
    $profileContent = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
    $marker = "# claudesync -- installed by https://github.com/InfiniteRoomLabs/claudesync"

    if ($profileContent -and $profileContent.Contains($marker)) {
        # Match the entire installed block: from the marker comment through the
        # closing brace of `function claudesync { ... }` (the last top-level function).
        # The block contains helper functions (_ClaudeSync_TryFirefox, _ClaudeSync_TryChrome)
        # followed by `function claudesync`. We match from the marker to the final
        # closing brace of `function claudesync`.
        $blockPattern = [regex]::Escape($marker) + '[\s\S]*?function claudesync\s*\{[\s\S]*?\n\}\s*'
        $newContent = [regex]::Replace($profileContent, $blockPattern, '')

        # Clean up any resulting double blank lines
        while ($newContent.Contains("`n`n`n")) {
            $newContent = $newContent.Replace("`n`n`n", "`n`n")
        }

        Set-Content -Path $PROFILE -Value $newContent -NoNewline
        Write-Success "Removed claudesync function block from $PROFILE"
        $removed += "Profile function ($PROFILE)"
    }
    else {
        Write-Info "No claudesync function found in $PROFILE."
        $skipped += "Profile function (not found)"
    }
}
else {
    Write-Info "No PowerShell profile file found at $PROFILE."
    $skipped += "Profile function (no profile file)"
}

# ---------------------------------------------------------------------------
# 2. Remove MCP wrapper files
# ---------------------------------------------------------------------------
$wrapperDir = Join-Path $env:LOCALAPPDATA "claudesync"
$wrapperPs1 = Join-Path $wrapperDir "claudesync-mcp.ps1"
$wrapperCmd = Join-Path $wrapperDir "claudesync-mcp.cmd"

Write-Info "Checking MCP wrapper files in $wrapperDir ..."

$wrapperRemoved = $false

if (Test-Path $wrapperPs1) {
    Remove-Item $wrapperPs1 -Force
    Write-Success "Removed $wrapperPs1"
    $wrapperRemoved = $true
}

if (Test-Path $wrapperCmd) {
    Remove-Item $wrapperCmd -Force
    Write-Success "Removed $wrapperCmd"
    $wrapperRemoved = $true
}

if ($wrapperRemoved) {
    $removed += "MCP wrapper scripts ($wrapperDir)"
}
else {
    Write-Info "No MCP wrapper scripts found."
    $skipped += "MCP wrapper scripts (not found)"
}

# Remove the directory if it is now empty
if (Test-Path $wrapperDir) {
    $remaining = Get-ChildItem $wrapperDir -Force -ErrorAction SilentlyContinue
    if (-not $remaining -or $remaining.Count -eq 0) {
        Remove-Item $wrapperDir -Force
        Write-Success "Removed empty directory $wrapperDir"
    }
    else {
        Write-Warn "$wrapperDir still contains files -- leaving it in place."
    }
}

# ---------------------------------------------------------------------------
# 3. Remove claudesync directory from user PATH
# ---------------------------------------------------------------------------
Write-Info "Checking user PATH for $wrapperDir ..."

try {
    $currentUserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($currentUserPath) {
        $pathEntries = $currentUserPath -split ";"
        $filteredEntries = $pathEntries | Where-Object { $_ -ne $wrapperDir -and $_ -ne "" }

        if ($filteredEntries.Count -lt $pathEntries.Count) {
            $newPath = ($filteredEntries -join ";")
            [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
            Write-Success "Removed $wrapperDir from user PATH."
            Write-Info "New terminals will pick up the change. Current session still has the old PATH."
            $removed += "User PATH entry"
        }
        else {
            Write-Info "$wrapperDir was not in user PATH."
            $skipped += "User PATH entry (not found)"
        }
    }
    else {
        Write-Info "User PATH is empty -- nothing to remove."
        $skipped += "User PATH entry (empty PATH)"
    }
}
catch {
    Write-Warn "Could not read/modify user PATH: $_"
    $skipped += "User PATH entry (error)"
}

# ---------------------------------------------------------------------------
# 4. Optionally remove Docker images
# ---------------------------------------------------------------------------
$dockerImages = @("deathnerd/claudesync:latest", "deathnerd/claudesync-mcp:latest")
$hasDocker = Get-Command docker -ErrorAction SilentlyContinue

if ($hasDocker) {
    # Check which images actually exist
    $existingImages = @()
    foreach ($img in $dockerImages) {
        $inspectResult = docker image inspect $img 2>&1
        if ($LASTEXITCODE -eq 0) {
            $existingImages += $img
        }
    }

    if ($existingImages.Count -gt 0) {
        $doRemoveImages = $false
        if ($Force) {
            $doRemoveImages = $true
        }
        else {
            Write-Host ""
            Write-Warn "Found ClaudeSync Docker images:"
            foreach ($img in $existingImages) {
                Write-Warn "  $img"
            }
            $response = Read-Host "  Remove Docker images? [y/N]"
            if ($response -eq "y" -or $response -eq "Y") {
                $doRemoveImages = $true
            }
        }

        if ($doRemoveImages) {
            foreach ($img in $existingImages) {
                docker rmi $img 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    Write-Success "Removed Docker image: $img"
                }
                else {
                    Write-Warn "Could not remove Docker image: $img (may be in use)"
                }
            }
            $removed += "Docker images"
        }
        else {
            Write-Info "Keeping Docker images."
            $skipped += "Docker images (user declined)"
        }
    }
    else {
        Write-Info "No ClaudeSync Docker images found."
        $skipped += "Docker images (not found)"
    }
}
else {
    Write-Info "Docker not installed -- skipping image cleanup."
    $skipped += "Docker images (Docker not installed)"
}

# ---------------------------------------------------------------------------
# 5. MCP config -- print manual instructions (do NOT auto-edit)
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  MCP Configuration" -ForegroundColor White
Write-Host "  -----------------" -ForegroundColor White
Write-Host ""
Write-Host "  The uninstaller does NOT automatically edit MCP config files." -ForegroundColor Yellow
Write-Host "  If you added ClaudeSync to any of these, remove the ""claudesync"" entry manually:" -ForegroundColor Yellow
Write-Host ""

$claudeCodeGlobal = Join-Path $HOME ".claude.json"
$claudeDesktop = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
$projectMcp = ".mcp.json (in your project directories)"

Write-Host "    Claude Code (global):  $claudeCodeGlobal" -ForegroundColor Cyan
Write-Host "    Claude Desktop:        $claudeDesktop" -ForegroundColor Cyan
Write-Host "    Project-level:         $projectMcp" -ForegroundColor Cyan
Write-Host ""
Write-Host "  In each file, find and remove the ""claudesync"" key under ""mcpServers"":" -ForegroundColor Yellow
Write-Host ""
Write-Host '    "mcpServers": {' -ForegroundColor DarkGray
Write-Host '      "claudesync": { ... }   <-- remove this entire entry' -ForegroundColor DarkGray
Write-Host '    }' -ForegroundColor DarkGray
Write-Host ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  Uninstall Summary" -ForegroundColor White
Write-Host "  -----------------" -ForegroundColor White

if ($removed.Count -gt 0) {
    Write-Host ""
    Write-Host "  Removed:" -ForegroundColor Green
    foreach ($item in $removed) {
        Write-Host "    [x] $item" -ForegroundColor Green
    }
}

if ($skipped.Count -gt 0) {
    Write-Host ""
    Write-Host "  Skipped:" -ForegroundColor DarkGray
    foreach ($item in $skipped) {
        Write-Host "    [ ] $item" -ForegroundColor DarkGray
    }
}

Write-Host ""
if ($removed.Count -gt 0) {
    Write-Host "  Reload your shell or run:" -ForegroundColor White
    Write-Host "    . `$PROFILE" -ForegroundColor Cyan
    Write-Host ""
}
Write-Host "  ClaudeSync uninstall complete." -ForegroundColor White
Write-Host ""
