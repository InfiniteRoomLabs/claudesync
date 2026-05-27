#Requires -Version 5.1
<#
.SYNOPSIS
    claudesync cookie broker (Windows) -- shared by the CLI and MCP wrappers.
.DESCRIPTION
    Resolves the claude.ai sessionKey cookie host-side and prints it.

      stdout : on success, exactly "sessionKey=<value>" (the Output stream)
      host   : all logging / guidance (does not pollute the captured value)
      exit   : 0 on success, 1 when nothing could be resolved

    Resolution order:
      1. $env:CLAUDE_AI_COOKIE (escape hatch)
      2. rookie-cli (auto-downloaded + SHA256-verified) across browsers
      3. Chrome DPAPI v10 fallback (works pre-Chrome-127; ABE/v20 cannot be decrypted)
      4. Firefox cookies.sqlite fallback
      5. guided manual instructions -> exit 1

    Harvesting runs host-side: the Docker container cannot reach Windows DPAPI.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 often defaults to TLS 1.0; GitHub requires TLS 1.2+.
# pwsh 7+ already negotiates modern TLS, so only nudge the legacy host.
if ($PSVersionTable.PSVersion.Major -lt 6) {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
}

# Pinned rookie release (assets carry no API digest -> verify a known SHA256).
$RookieTag   = 'v0.5.6'
$RookieAsset = 'rookie-cli-x86_64-pc-windows-msvc.exe'
$RookieSha   = 'ebf404578a87e4192e429ce916f6ea7de3364013614a08422d4a2c5afa630756'
$RookieUrl   = "https://github.com/thewh1teagle/rookie/releases/download/$RookieTag/$RookieAsset"

# MUST write to stderr, never the Output stream: the broker's stdout is captured
# as the cookie value, and for the MCP wrapper it must stay clean JSON-RPC.
# Write-Host renders to stdout when captured from a child process -- do not use it.
function Write-Guidance { param([string]$Message) [Console]::Error.WriteLine("[claudesync] $Message") }

# ---------------------------------------------------------------------------
# rookie-cli: ensure cached + SHA256-verified. Returns the path or $null.
# ---------------------------------------------------------------------------
function Get-RookieCli {
    # Only an x86_64 Windows asset exists; arm64 has no prebuilt CLI.
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq 'ARM64' -and -not $env:PROCESSOR_ARCHITEW6432) {
        Write-Guidance "No prebuilt rookie-cli for Windows ARM64; using fallbacks."
        return $null
    }

    $cache = Join-Path $env:LOCALAPPDATA 'claudesync'
    $bin   = Join-Path $cache 'rookie-cli.exe'
    if (Test-Path $bin) { return $bin }

    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $tmp = "$bin.download"
    Write-Guidance "Fetching rookie-cli $RookieTag (one-time, cached in $cache) ..."
    try {
        Invoke-WebRequest -Uri $RookieUrl -OutFile $tmp -UseBasicParsing
    } catch {
        Write-Guidance "rookie download failed: $($_.Exception.Message)"
        return $null
    }

    $got = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLower()
    if ($got -ne $RookieSha) {
        Write-Guidance "rookie SHA256 mismatch! expected $RookieSha got $got"
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        return $null
    }
    Move-Item $tmp $bin -Force
    return $bin
}

# Run rookie for one browser; return the sessionKey value or $null.
function Invoke-RookieBrowser {
    param([string]$Rookie, [string]$Browser)
    try {
        $json = (& $Rookie -b $Browser -d claude.ai -f json 2>$null | Out-String).Trim()
        if (-not $json) { return $null }
        $cookies = $json | ConvertFrom-Json
        foreach ($c in @($cookies)) {
            if ($c.name -eq 'sessionKey') { return $c.value }
        }
    } catch {}
    return $null
}

# ---------------------------------------------------------------------------
# Fallback: Chrome DPAPI (v10). Works pre-Chrome-127. Chrome >= 127 uses
# App-Bound Encryption (v20) whose key is NOT in Local State -> cannot decrypt;
# this returns $null in that case and the user is steered to Firefox/manual.
# Returns the raw sessionKey value or $null.
# ---------------------------------------------------------------------------
function Get-ChromeDpapiValue {
    if (-not $env:LOCALAPPDATA) { return $null }
    $localStatePath = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Local State"
    $cookiesDbPath  = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Default\Network\Cookies"
    if (-not (Test-Path $cookiesDbPath)) {
        $cookiesDbPath = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data\Default\Cookies"
    }
    if (-not (Test-Path $localStatePath)) { return $null }
    if (-not (Test-Path $cookiesDbPath))  { return $null }

    try {
        $localStateJson = Get-Content $localStatePath -Raw | ConvertFrom-Json
        $encryptedKeyB64 = $localStateJson.os_crypt.encrypted_key
        if (-not $encryptedKeyB64) { return $null }

        $encryptedKeyBytes = [Convert]::FromBase64String($encryptedKeyB64)
        $encryptedKeyBytes = $encryptedKeyBytes[5..($encryptedKeyBytes.Length - 1)]  # strip "DPAPI"

        Add-Type -AssemblyName System.Security
        $masterKey = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $encryptedKeyBytes, $null,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser)

        $tempDb = Join-Path $env:TEMP "claudesync_chrome_cookies_$(Get-Random).sqlite"
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
        Remove-Item $tempDb -Force -ErrorAction SilentlyContinue

        if (-not $encryptedValue -or $encryptedValue.Length -lt 16) { return $null }

        $prefix = [System.Text.Encoding]::ASCII.GetString($encryptedValue[0..2])
        if ($prefix -eq "v20") {
            # App-Bound Encryption: key is held by the elevation service, not here.
            Write-Guidance "Chrome cookie is App-Bound Encrypted (Chrome >= 127); cannot decrypt. Use Firefox or set CLAUDE_AI_COOKIE manually."
            return $null
        }
        if ($prefix -eq "v10") {
            $nonce = $encryptedValue[3..14]
            $ciphertextAndTag = $encryptedValue[15..($encryptedValue.Length - 1)]
            if ($ciphertextAndTag.Length -lt 16) { return $null }
            $tagStart = $ciphertextAndTag.Length - 16
            $ciphertext = $ciphertextAndTag[0..($tagStart - 1)]
            $tag = $ciphertextAndTag[$tagStart..($ciphertextAndTag.Length - 1)]

            if ($PSVersionTable.PSVersion.Major -ge 7) {
                try {
                    $aesGcm = [System.Security.Cryptography.AesGcm]::new($masterKey)
                    $plaintext = New-Object byte[] $ciphertext.Length
                    $aesGcm.Decrypt([byte[]]$nonce, [byte[]]$ciphertext, [byte[]]$tag, $plaintext)
                    $aesGcm.Dispose()
                    $v = [System.Text.Encoding]::UTF8.GetString($plaintext)
                    if ($v) { return $v }
                } catch {}
            }
            # PowerShell 5.1: BCrypt AES-GCM via inline C#.
            try {
                $aesGcmHelper = @"
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class AesGcmHelper {
    [DllImport("bcrypt.dll")] private static extern uint BCryptOpenAlgorithmProvider(out IntPtr h, string id, string impl, uint f);
    [DllImport("bcrypt.dll")] private static extern uint BCryptSetProperty(IntPtr h, string p, byte[] i, int ci, uint f);
    [DllImport("bcrypt.dll")] private static extern uint BCryptGenerateSymmetricKey(IntPtr h, out IntPtr hk, IntPtr pk, int ck, byte[] s, int cs, uint f);
    [DllImport("bcrypt.dll")] private static extern uint BCryptDecrypt(IntPtr hk, byte[] i, int ci, IntPtr pad, byte[] iv, int civ, byte[] o, int co, out int r, uint f);
    [DllImport("bcrypt.dll")] private static extern uint BCryptDestroyKey(IntPtr hk);
    [DllImport("bcrypt.dll")] private static extern uint BCryptCloseAlgorithmProvider(IntPtr h, uint f);
    [StructLayout(LayoutKind.Sequential)] private struct INFO {
        public int cbSize; public int dwInfoVersion; public IntPtr pbNonce; public int cbNonce;
        public IntPtr pbAuthData; public int cbAuthData; public IntPtr pbTag; public int cbTag;
        public IntPtr pbMacContext; public int cbMacContext; public int cbAAD; public long cbData; public int dwFlags;
    }
    public static byte[] Decrypt(byte[] key, byte[] nonce, byte[] ct, byte[] tag) {
        IntPtr hAlg = IntPtr.Zero, hKey = IntPtr.Zero;
        try {
            if (BCryptOpenAlgorithmProvider(out hAlg, "AES", null, 0) != 0) throw new CryptographicException("open");
            byte[] gcm = System.Text.Encoding.Unicode.GetBytes("ChainingModeGCM\0");
            if (BCryptSetProperty(hAlg, "ChainingMode", gcm, gcm.Length, 0) != 0) throw new CryptographicException("mode");
            if (BCryptGenerateSymmetricKey(hAlg, out hKey, IntPtr.Zero, 0, key, key.Length, 0) != 0) throw new CryptographicException("key");
            var info = new INFO(); info.cbSize = Marshal.SizeOf(info); info.dwInfoVersion = 1;
            GCHandle nh = GCHandle.Alloc(nonce, GCHandleType.Pinned), th = GCHandle.Alloc(tag, GCHandleType.Pinned);
            try {
                info.pbNonce = nh.AddrOfPinnedObject(); info.cbNonce = nonce.Length;
                info.pbTag = th.AddrOfPinnedObject(); info.cbTag = tag.Length;
                IntPtr ip = Marshal.AllocHGlobal(Marshal.SizeOf(info)); Marshal.StructureToPtr(info, ip, false);
                byte[] pt = new byte[ct.Length]; int w;
                uint st = BCryptDecrypt(hKey, ct, ct.Length, ip, null, 0, pt, pt.Length, out w, 0);
                Marshal.FreeHGlobal(ip);
                if (st != 0) throw new CryptographicException("decrypt " + st);
                Array.Resize(ref pt, w); return pt;
            } finally { nh.Free(); th.Free(); }
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
                $v = [System.Text.Encoding]::UTF8.GetString($plaintext)
                if ($v) { return $v }
            } catch {}
        }
    } catch {}
    return $null
}

# ---------------------------------------------------------------------------
# Fallback: Firefox cookies.sqlite (plaintext). Returns the value or $null.
# ---------------------------------------------------------------------------
function Get-FirefoxValue {
    if (-not $env:APPDATA) { return $null }
    $firefoxBase = Join-Path $env:APPDATA "Mozilla\Firefox"
    $profilesIni = Join-Path $firefoxBase "profiles.ini"
    if (-not (Test-Path $profilesIni)) { return $null }

    $profilePath = ""; $currentPath = ""; $isDefault = $false
    foreach ($line in (Get-Content $profilesIni)) {
        if ($line -match '^\[') {
            if ($isDefault -and $currentPath) { $profilePath = $currentPath; break }
            $isDefault = $false; $currentPath = ""
        } elseif ($line -match '^Default=1') { $isDefault = $true }
        elseif ($line -match '^Path=(.+)') { $currentPath = $Matches[1] }
    }
    if (-not $profilePath -and $isDefault -and $currentPath) { $profilePath = $currentPath }
    if (-not $profilePath) { return $null }
    if (-not [System.IO.Path]::IsPathRooted($profilePath)) { $profilePath = Join-Path $firefoxBase $profilePath }

    $cookiesDb = Join-Path $profilePath "cookies.sqlite"
    if (-not (Test-Path $cookiesDb)) { return $null }

    if (Get-Command sqlite3 -ErrorAction SilentlyContinue) {
        try {
            $val = sqlite3 -readonly "file:${cookiesDb}?immutable=1" `
                "SELECT value FROM moz_cookies WHERE host LIKE '%claude.ai%' AND name='sessionKey' LIMIT 1;" 2>$null
            if ($val) { return $val }
        } catch {}
    }
    return $null
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if ($env:CLAUDE_AI_COOKIE) {
    Write-Output $env:CLAUDE_AI_COOKIE
    exit 0
}

$val = $null
$rookie = Get-RookieCli
if ($rookie) {
    foreach ($b in @('firefox', 'chrome', 'edge', 'brave', 'chromium')) {
        $val = Invoke-RookieBrowser -Rookie $rookie -Browser $b
        if ($val) { break }
    }
}
if (-not $val) { $val = Get-ChromeDpapiValue }
if (-not $val) { $val = Get-FirefoxValue }

if ($val) {
    Write-Output "sessionKey=$val"
    exit 0
}

Write-Guidance ""
Write-Guidance "Could not read the claude.ai sessionKey cookie automatically."
Write-Guidance ""
Write-Guidance "Fix it one of these ways:"
Write-Guidance "  1. Log in to claude.ai in Firefox (recommended on Windows), then re-run."
Write-Guidance "  2. Chrome >= 127 uses App-Bound Encryption and cannot be read -- use Firefox."
Write-Guidance "  3. Set it manually -- claude.ai > F12 > Application > Cookies > sessionKey:"
Write-Guidance '       $env:CLAUDE_AI_COOKIE = "sessionKey=<paste-value>"'
exit 1
