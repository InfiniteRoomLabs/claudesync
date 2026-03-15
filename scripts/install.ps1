#Requires -Version 5.1
<#
.SYNOPSIS
    ClaudeSync installer -- PowerShell/Windows version
.DESCRIPTION
    Installs a `claudesync` function into your PowerShell profile that:
      1. Reads your browser sessionKey cookie (Chrome DPAPI, Firefox, or env var)
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

function _ClaudeSync_TryFirefox {
    <#
    .SYNOPSIS
        Attempts to read the sessionKey cookie from Firefox cookies.sqlite.
        Returns "sessionKey=<value>" or empty string.
    #>
    $firefoxBase = Join-Path $env:APPDATA "Mozilla\Firefox"
    $profilesIni = Join-Path $firefoxBase "profiles.ini"

    if (-not (Test-Path $profilesIni)) { return "" }

    # Parse profiles.ini to find the default profile
    $profilePath = ""
    $currentPath = ""
    $isDefault = $false

    foreach ($line in (Get-Content $profilesIni)) {
        if ($line -match '^\[') {
            if ($isDefault -and $currentPath) {
                $profilePath = $currentPath
                break
            }
            $isDefault = $false
            $currentPath = ""
        }
        elseif ($line -match '^Default=1') {
            $isDefault = $true
        }
        elseif ($line -match '^Path=(.+)') {
            $currentPath = $Matches[1]
        }
    }

    # Handle last section
    if (-not $profilePath -and $isDefault -and $currentPath) {
        $profilePath = $currentPath
    }

    if (-not $profilePath) { return "" }

    # Resolve relative paths
    if (-not [System.IO.Path]::IsPathRooted($profilePath)) {
        $profilePath = Join-Path $firefoxBase $profilePath
    }

    $cookiesDb = Join-Path $profilePath "cookies.sqlite"
    if (-not (Test-Path $cookiesDb)) { return "" }

    # Try sqlite3 CLI first
    if (Get-Command sqlite3 -ErrorAction SilentlyContinue) {
        try {
            $val = sqlite3 -readonly "file:${cookiesDb}?immutable=1" `
                "SELECT value FROM moz_cookies WHERE host LIKE '%claude.ai%' AND name='sessionKey' LIMIT 1;" 2>$null
            if ($val) { return "sessionKey=$val" }
        } catch {}
    }

    # Try System.Data.SQLite .NET assembly
    try {
        # Common locations for System.Data.SQLite
        $sqliteDllPaths = @(
            "${env:ProgramFiles}\System.Data.SQLite\bin\System.Data.SQLite.dll",
            "${env:ProgramFiles(x86)}\System.Data.SQLite\bin\System.Data.SQLite.dll",
            (Join-Path $PSScriptRoot "System.Data.SQLite.dll")
        )
        # Try NuGet global packages cache
        $nugetCache = Join-Path $env:USERPROFILE ".nuget\packages\system.data.sqlite.core"
        if (Test-Path $nugetCache) {
            $latestVersion = Get-ChildItem $nugetCache -Directory | Sort-Object Name -Descending | Select-Object -First 1
            if ($latestVersion) {
                $sqliteDllPaths += Join-Path $latestVersion.FullName "lib\net46\System.Data.SQLite.dll"
            }
        }

        $loaded = $false
        foreach ($dllPath in $sqliteDllPaths) {
            if (Test-Path $dllPath) {
                Add-Type -Path $dllPath
                $loaded = $true
                break
            }
        }

        if ($loaded) {
            # Copy cookies.sqlite to temp to avoid locking issues
            $tempDb = Join-Path $env:TEMP "claudesync_ff_cookies_$(Get-Random).sqlite"
            Copy-Item $cookiesDb $tempDb -Force
            try {
                $connStr = "Data Source=$tempDb;Read Only=True;"
                $conn = New-Object System.Data.SQLite.SQLiteConnection($connStr)
                $conn.Open()
                $cmd = $conn.CreateCommand()
                $cmd.CommandText = "SELECT value FROM moz_cookies WHERE host LIKE '%claude.ai%' AND name='sessionKey' LIMIT 1;"
                $result = $cmd.ExecuteScalar()
                $conn.Close()
                if ($result) { return "sessionKey=$result" }
            } finally {
                Remove-Item $tempDb -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}

    return ""
}

function _ClaudeSync_TryChrome {
    <#
    .SYNOPSIS
        Attempts to read the sessionKey cookie from Chrome using DPAPI decryption.
        This is Windows-native and requires no external dependencies.
        Returns "sessionKey=<value>" or empty string.
    #>
    $localStatePath = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Local State"
    $cookiesDbPath = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Default\Network\Cookies"

    # Fallback to old path if new path doesn't exist
    if (-not (Test-Path $cookiesDbPath)) {
        $cookiesDbPath = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Default\Cookies"
    }

    if (-not (Test-Path $localStatePath)) { return "" }
    if (-not (Test-Path $cookiesDbPath)) { return "" }

    try {
        # Step 1: Read the encrypted master key from Local State
        $localStateJson = Get-Content $localStatePath -Raw | ConvertFrom-Json
        $encryptedKeyB64 = $localStateJson.os_crypt.encrypted_key

        if (-not $encryptedKeyB64) { return "" }

        # Step 2: Base64 decode and strip the "DPAPI" prefix (first 5 bytes)
        $encryptedKeyBytes = [Convert]::FromBase64String($encryptedKeyB64)
        $encryptedKeyBytes = $encryptedKeyBytes[5..($encryptedKeyBytes.Length - 1)]

        # Step 3: Decrypt the master key using DPAPI (user-scoped, no prompt needed)
        Add-Type -AssemblyName System.Security
        $masterKey = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $encryptedKeyBytes,
            $null,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )

        # Step 4: Read the encrypted cookie value from the SQLite DB
        # Copy to temp to avoid Chrome's lock on the file
        $tempDb = Join-Path $env:TEMP "claudesync_chrome_cookies_$(Get-Random).sqlite"
        Copy-Item $cookiesDbPath $tempDb -Force

        $encryptedValue = $null

        # Try sqlite3 CLI
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

        # If sqlite3 didn't work, try System.Data.SQLite
        if (-not $encryptedValue) {
            try {
                $nugetCache = Join-Path $env:USERPROFILE ".nuget\packages\system.data.sqlite.core"
                $sqliteDllPaths = @(
                    "${env:ProgramFiles}\System.Data.SQLite\bin\System.Data.SQLite.dll",
                    "${env:ProgramFiles(x86)}\System.Data.SQLite\bin\System.Data.SQLite.dll"
                )
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

        if (-not $encryptedValue -or $encryptedValue.Length -lt 16) { return "" }

        # Step 5: Decrypt the cookie value
        # Chrome v80+ uses AES-256-GCM with a "v10" or "v20" prefix (3 bytes)
        $prefix = [System.Text.Encoding]::ASCII.GetString($encryptedValue[0..2])

        if ($prefix -eq "v10" -or $prefix -eq "v20") {
            # AES-256-GCM: nonce (12 bytes) + ciphertext + tag (16 bytes)
            $nonce = $encryptedValue[3..14]          # 12 bytes
            $ciphertextAndTag = $encryptedValue[15..($encryptedValue.Length - 1)]

            if ($ciphertextAndTag.Length -lt 16) { return "" }

            $tagStart = $ciphertextAndTag.Length - 16
            $ciphertext = $ciphertextAndTag[0..($tagStart - 1)]
            $tag = $ciphertextAndTag[$tagStart..($ciphertextAndTag.Length - 1)]

            # Use AesGcm (.NET Core 3.0+ / PowerShell 7+) or fallback to BouncyCastle-style
            if ($PSVersionTable.PSVersion.Major -ge 7) {
                # PowerShell 7+ has access to System.Security.Cryptography.AesGcm
                try {
                    $aesGcm = [System.Security.Cryptography.AesGcm]::new($masterKey)
                    $plaintext = New-Object byte[] $ciphertext.Length
                    $aesGcm.Decrypt([byte[]]$nonce, [byte[]]$ciphertext, [byte[]]$tag, $plaintext)
                    $aesGcm.Dispose()
                    $cookieValue = [System.Text.Encoding]::UTF8.GetString($plaintext)
                    if ($cookieValue) { return "sessionKey=$cookieValue" }
                } catch {}
            }

            # PowerShell 5.1 fallback: use a small C# snippet compiled inline
            # that leverages the Windows BCrypt API for AES-GCM
            try {
                $aesGcmHelper = @"
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

public static class AesGcmHelper {
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
        public int cbSize;
        public int dwInfoVersion;
        public IntPtr pbNonce;
        public int cbNonce;
        public IntPtr pbAuthData;
        public int cbAuthData;
        public IntPtr pbTag;
        public int cbTag;
        public IntPtr pbMacContext;
        public int cbMacContext;
        public int cbAAD;
        public long cbData;
        public int dwFlags;
    }

    public static byte[] Decrypt(byte[] key, byte[] nonce, byte[] ciphertext, byte[] tag) {
        IntPtr hAlg = IntPtr.Zero;
        IntPtr hKey = IntPtr.Zero;

        try {
            uint status = BCryptOpenAlgorithmProvider(out hAlg, "AES", null, 0);
            if (status != 0) throw new CryptographicException("BCryptOpenAlgorithmProvider failed: " + status);

            byte[] chainMode = System.Text.Encoding.Unicode.GetBytes("ChainingModeGCM\0");
            status = BCryptSetProperty(hAlg, "ChainingMode", chainMode, chainMode.Length, 0);
            if (status != 0) throw new CryptographicException("BCryptSetProperty failed: " + status);

            status = BCryptGenerateSymmetricKey(hAlg, out hKey, IntPtr.Zero, 0, key, key.Length, 0);
            if (status != 0) throw new CryptographicException("BCryptGenerateSymmetricKey failed: " + status);

            var authInfo = new BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO();
            authInfo.cbSize = Marshal.SizeOf(authInfo);
            authInfo.dwInfoVersion = 1;

            GCHandle nonceHandle = GCHandle.Alloc(nonce, GCHandleType.Pinned);
            GCHandle tagHandle = GCHandle.Alloc(tag, GCHandleType.Pinned);

            try {
                authInfo.pbNonce = nonceHandle.AddrOfPinnedObject();
                authInfo.cbNonce = nonce.Length;
                authInfo.pbTag = tagHandle.AddrOfPinnedObject();
                authInfo.cbTag = tag.Length;

                IntPtr authInfoPtr = Marshal.AllocHGlobal(Marshal.SizeOf(authInfo));
                Marshal.StructureToPtr(authInfo, authInfoPtr, false);

                byte[] plaintext = new byte[ciphertext.Length];
                int bytesWritten;
                status = BCryptDecrypt(hKey, ciphertext, ciphertext.Length, authInfoPtr, null, 0, plaintext, plaintext.Length, out bytesWritten, 0);
                Marshal.FreeHGlobal(authInfoPtr);

                if (status != 0) throw new CryptographicException("BCryptDecrypt failed: " + status);

                Array.Resize(ref plaintext, bytesWritten);
                return plaintext;
            } finally {
                nonceHandle.Free();
                tagHandle.Free();
            }
        } finally {
            if (hKey != IntPtr.Zero) BCryptDestroyKey(hKey);
            if (hAlg != IntPtr.Zero) BCryptCloseAlgorithmProvider(hAlg, 0);
        }
    }
}
"@
                if (-not ([System.Management.Automation.PSTypeName]'AesGcmHelper').Type) {
                    Add-Type -TypeDefinition $aesGcmHelper -Language CSharp
                }

                $plaintext = [AesGcmHelper]::Decrypt($masterKey, [byte[]]$nonce, [byte[]]$ciphertext, [byte[]]$tag)
                $cookieValue = [System.Text.Encoding]::UTF8.GetString($plaintext)
                if ($cookieValue) { return "sessionKey=$cookieValue" }
            } catch {}
        }
        else {
            # Legacy DPAPI-only encryption (pre-v80, rare now)
            try {
                $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
                    $encryptedValue, $null,
                    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
                )
                $cookieValue = [System.Text.Encoding]::UTF8.GetString($decrypted)
                if ($cookieValue) { return "sessionKey=$cookieValue" }
            } catch {}
        }
    } catch {}

    return ""
}

function claudesync {
    <#
    .SYNOPSIS
        Run ClaudeSync CLI via Docker, automatically reading browser cookies.
    .DESCRIPTION
        Reads your claude.ai sessionKey cookie from Chrome (DPAPI), Firefox,
        or the CLAUDE_AI_COOKIE environment variable, then runs the ClaudeSync
        Docker container with the current directory mounted as /data.
    #>

    # -- dependency check --
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host "claudesync: Docker is not installed." -ForegroundColor Red
        Write-Host "  Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/" -ForegroundColor Red
        return
    }

    # -- resolve cookie (fallback chain) --
    $cookieHeader = ""

    # 1. If CLAUDE_AI_COOKIE env var is set, use it directly
    if ($env:CLAUDE_AI_COOKIE) {
        $cookieHeader = $env:CLAUDE_AI_COOKIE
    }
    else {
        # 2. Try Chrome (DPAPI -- native Windows, no external deps)
        $cookieHeader = _ClaudeSync_TryChrome
        if (-not $cookieHeader) {
            Write-Host "claudesync: Chrome cookie not found or unreadable, trying Firefox..." -ForegroundColor Yellow
        }

        # 3. Try Firefox
        if (-not $cookieHeader) {
            $cookieHeader = _ClaudeSync_TryFirefox
        }

        # 4. Nothing worked -- guide the user
        if (-not $cookieHeader) {
            Write-Host "claudesync: could not read sessionKey cookie from any browser." -ForegroundColor Red
            Write-Host ""
            Write-Host "  Tried:" -ForegroundColor Red
            Write-Host "    - Chrome (DPAPI decryption)" -ForegroundColor Red
            Write-Host "    - Firefox (cookies.sqlite)" -ForegroundColor Red
            Write-Host ""
            Write-Host "  To fix, either:" -ForegroundColor Yellow
            Write-Host "    1. Log in to claude.ai in Chrome or Firefox and try again" -ForegroundColor Yellow
            Write-Host "    2. Set the cookie manually:" -ForegroundColor Yellow
            Write-Host "       Open claude.ai > F12 > Application > Cookies > sessionKey" -ForegroundColor Yellow
            Write-Host '       $env:CLAUDE_AI_COOKIE = "sessionKey=<paste-value>"' -ForegroundColor Yellow
            return
        }
    }

    # -- run container --
    docker run --rm `
        -e "CLAUDE_AI_COOKIE=$cookieHeader" `
        -v "${PWD}:/data" `
        deathnerd/claudesync:latest `
        @Args
}
'@

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
Write-Host "  NOTE: On Windows, Chrome cookies are decrypted natively via DPAPI --"
Write-Host "  no external tools needed! Firefox reading requires sqlite3 on PATH"
Write-Host "  or System.Data.SQLite .NET assembly."
Write-Host ""
