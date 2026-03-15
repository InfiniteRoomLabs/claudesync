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
# claudesync-mcp wrapper -- reads browser cookies and runs the MCP Docker container
# Installed by: https://github.com/InfiniteRoomLabs/claudesync
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function _Mcp_Error {
    param([string]$Message)
    $errJson = '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"claudesync-mcp: ' + ($Message -replace '"', '\"') + '"}}'
    [Console]::Error.WriteLine($errJson)
    exit 1
}

# -- dependency check --
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    _Mcp_Error "docker not found. Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/"
}

# -- resolve cookie (fallback chain) --
$cookieHeader = ""

# 1. If CLAUDE_AI_COOKIE env var is set, use it
if ($env:CLAUDE_AI_COOKIE) {
    $cookieHeader = $env:CLAUDE_AI_COOKIE
}
else {
    # 2. Try Chrome (DPAPI -- native on Windows, the easy path)
    try {
        $localStatePath = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Local State"
        $cookiesDbPath = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Default\Network\Cookies"
        if (-not (Test-Path $cookiesDbPath)) {
            $cookiesDbPath = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Default\Cookies"
        }

        if ((Test-Path $localStatePath) -and (Test-Path $cookiesDbPath)) {
            $localStateJson = Get-Content $localStatePath -Raw | ConvertFrom-Json
            $encryptedKeyB64 = $localStateJson.os_crypt.encrypted_key

            if ($encryptedKeyB64) {
                $encryptedKeyBytes = [Convert]::FromBase64String($encryptedKeyB64)
                $encryptedKeyBytes = $encryptedKeyBytes[5..($encryptedKeyBytes.Length - 1)]

                Add-Type -AssemblyName System.Security
                $masterKey = [System.Security.Cryptography.ProtectedData]::Unprotect(
                    $encryptedKeyBytes, $null,
                    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
                )

                $tempDb = Join-Path $env:TEMP "claudesync_mcp_chrome_$(Get-Random).sqlite"
                Copy-Item $cookiesDbPath $tempDb -Force

                $encryptedValue = $null

                if (Get-Command sqlite3 -ErrorAction SilentlyContinue) {
                    try {
                        $hexResult = sqlite3 $tempDb `
                            "SELECT hex(encrypted_value) FROM cookies WHERE host_key LIKE '%claude.ai%' AND name='sessionKey' LIMIT 1;" 2>$null
                        if ($hexResult) {
                            $encryptedValue = [byte[]](@(0..($hexResult.Length / 2 - 1)) | ForEach-Object {
                                [Convert]::ToByte($hexResult.Substring($_ * 2, 2), 16)
                            })
                        }
                    } catch {}
                }

                if (-not $encryptedValue) {
                    try {
                        $sqliteDllPaths = @(
                            "${env:ProgramFiles}\System.Data.SQLite\bin\System.Data.SQLite.dll",
                            "${env:ProgramFiles(x86)}\System.Data.SQLite\bin\System.Data.SQLite.dll"
                        )
                        $nugetCache = Join-Path $env:USERPROFILE ".nuget\packages\system.data.sqlite.core"
                        if (Test-Path $nugetCache) {
                            $latestVersion = Get-ChildItem $nugetCache -Directory | Sort-Object Name -Descending | Select-Object -First 1
                            if ($latestVersion) {
                                $sqliteDllPaths += Join-Path $latestVersion.FullName "lib\net46\System.Data.SQLite.dll"
                            }
                        }
                        foreach ($dllPath in $sqliteDllPaths) {
                            if (Test-Path $dllPath) {
                                if (-not ([System.AppDomain]::CurrentDomain.GetAssemblies() |
                                    Where-Object { $_.GetName().Name -eq 'System.Data.SQLite' })) {
                                    Add-Type -Path $dllPath
                                }
                                $connStr = "Data Source=$tempDb;Read Only=True;"
                                $conn = New-Object System.Data.SQLite.SQLiteConnection($connStr)
                                $conn.Open()
                                $cmd = $conn.CreateCommand()
                                $cmd.CommandText = "SELECT encrypted_value FROM cookies WHERE host_key LIKE '%claude.ai%' AND name='sessionKey' LIMIT 1;"
                                $reader = $cmd.ExecuteReader()
                                if ($reader.Read()) {
                                    $len = $reader.GetBytes(0, 0, $null, 0, 0)
                                    $encryptedValue = New-Object byte[] $len
                                    $reader.GetBytes(0, 0, $encryptedValue, 0, $len) | Out-Null
                                }
                                $reader.Close()
                                $conn.Close()
                                break
                            }
                        }
                    } catch {}
                }

                Remove-Item $tempDb -Force -ErrorAction SilentlyContinue

                if ($encryptedValue -and $encryptedValue.Length -ge 16) {
                    $prefix = [System.Text.Encoding]::ASCII.GetString($encryptedValue[0..2])
                    if ($prefix -eq "v10" -or $prefix -eq "v20") {
                        $nonce = $encryptedValue[3..14]
                        $ciphertextAndTag = $encryptedValue[15..($encryptedValue.Length - 1)]
                        $tagStart = $ciphertextAndTag.Length - 16
                        $ciphertext = $ciphertextAndTag[0..($tagStart - 1)]
                        $tag = $ciphertextAndTag[$tagStart..($ciphertextAndTag.Length - 1)]

                        if ($PSVersionTable.PSVersion.Major -ge 7) {
                            try {
                                $aesGcm = [System.Security.Cryptography.AesGcm]::new($masterKey)
                                $plaintext = New-Object byte[] $ciphertext.Length
                                $aesGcm.Decrypt([byte[]]$nonce, [byte[]]$ciphertext, [byte[]]$tag, $plaintext)
                                $aesGcm.Dispose()
                                $cookieValue = [System.Text.Encoding]::UTF8.GetString($plaintext)
                                if ($cookieValue) { $cookieHeader = "sessionKey=$cookieValue" }
                            } catch {}
                        }

                        if (-not $cookieHeader) {
                            try {
                                $aesGcmHelper = @"
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class AesGcmMcpHelper {
    [DllImport("bcrypt.dll")]
    private static extern uint BCryptOpenAlgorithmProvider(out IntPtr hAlgorithm, string pszAlgId, string pszImpl, uint dwFlags);
    [DllImport("bcrypt.dll")]
    private static extern uint BCryptSetProperty(IntPtr hObject, string pszProperty, byte[] pbInput, int cbInput, uint dwFlags);
    [DllImport("bcrypt.dll")]
    private static extern uint BCryptGenerateSymmetricKey(IntPtr hAlgorithm, out IntPtr hKey, IntPtr pbKeyObject, int cbKeyObject, byte[] pbSecret, int cbSecret, uint dwFlags);
    [DllImport("bcrypt.dll")]
    private static extern uint BCryptDecrypt(IntPtr hKey, byte[] pbInput, int cbInput, IntPtr pPaddingInfo, byte[] pbIV, int cbIV, byte[] pbOutput, int cbOutput, out int pcbResult, uint dwFlags);
    [DllImport("bcrypt.dll")]
    private static extern uint BCryptDestroyKey(IntPtr hKey);
    [DllImport("bcrypt.dll")]
    private static extern uint BCryptCloseAlgorithmProvider(IntPtr hAlgorithm, uint dwFlags);
    [StructLayout(LayoutKind.Sequential)]
    private struct BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO {
        public int cbSize; public int dwInfoVersion;
        public IntPtr pbNonce; public int cbNonce;
        public IntPtr pbAuthData; public int cbAuthData;
        public IntPtr pbTag; public int cbTag;
        public IntPtr pbMacContext; public int cbMacContext;
        public int cbAAD; public long cbData; public int dwFlags;
    }
    public static byte[] Decrypt(byte[] key, byte[] nonce, byte[] ciphertext, byte[] tag) {
        IntPtr hAlg = IntPtr.Zero, hKey = IntPtr.Zero;
        try {
            uint s = BCryptOpenAlgorithmProvider(out hAlg, "AES", null, 0);
            if (s != 0) throw new CryptographicException("BCryptOpenAlgorithmProvider: " + s);
            byte[] cm = System.Text.Encoding.Unicode.GetBytes("ChainingModeGCM\0");
            s = BCryptSetProperty(hAlg, "ChainingMode", cm, cm.Length, 0);
            if (s != 0) throw new CryptographicException("BCryptSetProperty: " + s);
            s = BCryptGenerateSymmetricKey(hAlg, out hKey, IntPtr.Zero, 0, key, key.Length, 0);
            if (s != 0) throw new CryptographicException("BCryptGenerateSymmetricKey: " + s);
            var ai = new BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO();
            ai.cbSize = Marshal.SizeOf(ai); ai.dwInfoVersion = 1;
            GCHandle nh = GCHandle.Alloc(nonce, GCHandleType.Pinned);
            GCHandle th = GCHandle.Alloc(tag, GCHandleType.Pinned);
            try {
                ai.pbNonce = nh.AddrOfPinnedObject(); ai.cbNonce = nonce.Length;
                ai.pbTag = th.AddrOfPinnedObject(); ai.cbTag = tag.Length;
                IntPtr aip = Marshal.AllocHGlobal(Marshal.SizeOf(ai));
                Marshal.StructureToPtr(ai, aip, false);
                byte[] pt = new byte[ciphertext.Length]; int bw;
                s = BCryptDecrypt(hKey, ciphertext, ciphertext.Length, aip, null, 0, pt, pt.Length, out bw, 0);
                Marshal.FreeHGlobal(aip);
                if (s != 0) throw new CryptographicException("BCryptDecrypt: " + s);
                Array.Resize(ref pt, bw); return pt;
            } finally { nh.Free(); th.Free(); }
        } finally {
            if (hKey != IntPtr.Zero) BCryptDestroyKey(hKey);
            if (hAlg != IntPtr.Zero) BCryptCloseAlgorithmProvider(hAlg, 0);
        }
    }
}
"@
                                if (-not ([System.Management.Automation.PSTypeName]'AesGcmMcpHelper').Type) {
                                    Add-Type -TypeDefinition $aesGcmHelper -Language CSharp
                                }
                                $pt = [AesGcmMcpHelper]::Decrypt($masterKey, [byte[]]$nonce, [byte[]]$ciphertext, [byte[]]$tag)
                                $cookieValue = [System.Text.Encoding]::UTF8.GetString($pt)
                                if ($cookieValue) { $cookieHeader = "sessionKey=$cookieValue" }
                            } catch {}
                        }
                    }
                    else {
                        try {
                            $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
                                $encryptedValue, $null,
                                [System.Security.Cryptography.DataProtectionScope]::CurrentUser
                            )
                            $cookieValue = [System.Text.Encoding]::UTF8.GetString($decrypted)
                            if ($cookieValue) { $cookieHeader = "sessionKey=$cookieValue" }
                        } catch {}
                    }
                }
            }
        }
    } catch {}

    # 3. Try Firefox
    if (-not $cookieHeader) {
        $firefoxBase = Join-Path $env:APPDATA "Mozilla\Firefox"
        $profilesIni = Join-Path $firefoxBase "profiles.ini"
        if (Test-Path $profilesIni) {
            $profilePath = ""; $currentPath = ""; $isDefault = $false
            foreach ($line in (Get-Content $profilesIni)) {
                if ($line -match '^\[') {
                    if ($isDefault -and $currentPath) { $profilePath = $currentPath; break }
                    $isDefault = $false; $currentPath = ""
                }
                elseif ($line -match '^Default=1') { $isDefault = $true }
                elseif ($line -match '^Path=(.+)') { $currentPath = $Matches[1] }
            }
            if (-not $profilePath -and $isDefault -and $currentPath) { $profilePath = $currentPath }
            if ($profilePath) {
                if (-not [System.IO.Path]::IsPathRooted($profilePath)) {
                    $profilePath = Join-Path $firefoxBase $profilePath
                }
                $cookiesDb = Join-Path $profilePath "cookies.sqlite"
                if (Test-Path $cookiesDb) {
                    if (Get-Command sqlite3 -ErrorAction SilentlyContinue) {
                        try {
                            $tempDb = Join-Path $env:TEMP "claudesync_mcp_ff_$(Get-Random).sqlite"
                            Copy-Item $cookiesDb $tempDb -Force
                            $val = sqlite3 $tempDb "SELECT value FROM moz_cookies WHERE host LIKE '%claude.ai%' AND name='sessionKey' LIMIT 1;" 2>$null
                            Remove-Item $tempDb -Force -ErrorAction SilentlyContinue
                            if ($val) { $cookieHeader = "sessionKey=$val" }
                        } catch {}
                    }
                }
            }
        }
    }

    if (-not $cookieHeader) {
        _Mcp_Error "Could not read sessionKey from Chrome or Firefox. Log in to claude.ai, or set CLAUDE_AI_COOKIE='sessionKey=<value>' (F12 > Application > Cookies)."
    }
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
