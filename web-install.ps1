<#
.SYNOPSIS
    Installs the GitHub Model Relay launcher on Windows.

.DESCRIPTION
    Designed to be piped straight from the web:

        irm https://raw.githubusercontent.com/saketlunker/githubRelay/main/web-install.ps1 | iex

    npm 12 blocks installing packages from remote tarballs and from git by
    default (allow-remote=none, allow-git=none), so a GitHub Release URL cannot
    be handed to `npm install -g`. This script fetches the same signed-by-hash
    tarball itself, verifies it, and puts `githubrelay` on PATH.
#>

[CmdletBinding()]
param(
    [string]$ManifestUrl = 'https://raw.githubusercontent.com/saketlunker/githubRelay/main/releases/prod/latest.json',
    [string]$InstallRoot,
    [switch]$SkipSetup
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$MinimumNode = [Version]'22.13.0'

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "    $Message" -ForegroundColor Yellow }

function Assert-Windows {
    if ($env:OS -ne 'Windows_NT') {
        throw 'GitHub Model Relay currently supports Windows only.'
    }
}

function Get-NodeVersion {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if (-not $command) { return $null }
    $raw = (& node --version 2>$null)
    if (-not $raw) { return $null }
    try { return [Version]($raw.TrimStart('v') -replace '-.*$', '') } catch { return $null }
}

function Install-NodeWithWinget {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) { return $false }

    Write-Warn 'Installing Node.js LTS with winget. Approve any prompt that appears.'
    & winget install --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) { return $false }

    # winget updates the machine PATH, which this already-running shell does not see.
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"
    return $true
}

function Assert-Node {
    $version = Get-NodeVersion
    if ($version -and $version -ge $MinimumNode) {
        Write-Ok "Node.js $version"
        return
    }

    if ($version) {
        Write-Warn "Node.js $version is older than the required $MinimumNode."
    }
    else {
        Write-Warn 'Node.js was not found.'
    }

    if (Install-NodeWithWinget) {
        $version = Get-NodeVersion
        if ($version -and $version -ge $MinimumNode) {
            Write-Ok "Node.js $version"
            return
        }
    }

    throw @"
Node.js $MinimumNode or newer is required.

Install it from https://nodejs.org/en/download, close this window, open a new
PowerShell window, and run the install command again.
"@
}

function Get-Manifest {
    param([string]$Url)
    $manifest = Invoke-RestMethod -Uri $Url -TimeoutSec 30
    if ($manifest.product -ne 'githubrelay' -or $manifest.channel -ne 'prod') {
        throw "Unexpected release manifest: product=$($manifest.product) channel=$($manifest.channel)"
    }
    if (-not $manifest.dist.tarball) {
        throw 'Release manifest does not publish a tarball.'
    }
    return $manifest
}

function Get-ExpectedChecksum {
    param($Manifest)

    # npm pack is not byte-reproducible, so a hash written by hand into the
    # manifest drifts as soon as CI rebuilds the tarball. The authoritative
    # checksum is published next to the artifact by the same workflow run.
    if ($Manifest.dist.PSObject.Properties['sha256'] -and -not [string]::IsNullOrWhiteSpace($Manifest.dist.sha256)) {
        return [string]$Manifest.dist.sha256
    }

    $checksumUrl = "$($Manifest.dist.tarball).sha256"
    try {
        $body = Invoke-RestMethod -Uri $checksumUrl -TimeoutSec 30
    }
    catch {
        return ''
    }
    # Accepts either a bare hash or `<hash>  <filename>` as produced by sha256sum.
    $match = [regex]::Match([string]$body, '[A-Fa-f0-9]{64}')
    if ($match.Success) { return $match.Value }
    return ''
}

function Save-Tarball {
    param([string]$Url, [string]$Destination, [string]$ExpectedSha256)

    Invoke-WebRequest -Uri $Url -OutFile $Destination -TimeoutSec 300 -UseBasicParsing

    if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) {
        Write-Warn 'No published checksum found; skipping verification.'
        return
    }
    $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
        Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
        throw "Download failed verification. Expected $ExpectedSha256 but got $actual."
    }
    Write-Ok 'Checksum verified'
}

function Expand-Launcher {
    param([string]$Tarball, [string]$Target)

    $staging = Join-Path ([IO.Path]::GetTempPath()) ("githubrelay-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
        # Windows 10+ ships bsdtar, which reads the npm .tgz directly.
        & tar -xf $Tarball -C $staging
        if ($LASTEXITCODE -ne 0) { throw "Extracting $Tarball failed." }

        $payload = Join-Path $staging 'package'
        if (-not (Test-Path -LiteralPath $payload)) { throw 'Archive did not contain the expected package directory.' }

        # Replace only after a good download, so a failure leaves the previous install intact.
        if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
        New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
        Move-Item -LiteralPath $payload -Destination $Target
    }
    finally {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function New-Shim {
    param([string]$BinDirectory, [string]$LauncherRoot)

    New-Item -ItemType Directory -Path $BinDirectory -Force | Out-Null
    $entry = Join-Path $LauncherRoot 'bin\githubrelay.js'
    $shim = Join-Path $BinDirectory 'githubrelay.cmd'
    @"
@echo off
node "$entry" %*
"@ | Set-Content -LiteralPath $shim -Encoding ASCII
    return $shim
}

function Add-UserPath {
    param([string]$Directory)

    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @()
    if ($current) { $entries = $current -split ';' | Where-Object { $_ -ne '' } }

    if ($entries -notcontains $Directory) {
        $updated = (@($entries) + $Directory) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
        Write-Ok "Added $Directory to your PATH"
    }
    # Make it usable in this window too, not just new ones.
    if (($env:Path -split ';') -notcontains $Directory) {
        $env:Path = "$env:Path;$Directory"
    }
}

try {
    Write-Host ''
    Write-Host 'GitHub Model Relay installer' -ForegroundColor White
    Write-Host 'Unofficial community tool. Not affiliated with GitHub.' -ForegroundColor DarkGray
    Write-Host ''

    Write-Step 'Checking prerequisites'
    Assert-Windows
    Assert-Node

    Write-Step 'Reading the release manifest'
    $manifest = Get-Manifest -Url $ManifestUrl
    Write-Ok "Version $($manifest.version)"

    if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
        $InstallRoot = Join-Path $env:LOCALAPPDATA 'githubrelay'
    }
    $launcherRoot = Join-Path $InstallRoot 'launcher'
    $binDirectory = Join-Path $InstallRoot 'bin'

    Write-Step 'Downloading the launcher'
    $download = Join-Path ([IO.Path]::GetTempPath()) ("githubrelay-" + [Guid]::NewGuid().ToString('N') + '.tgz')
    try {
        $sha = Get-ExpectedChecksum -Manifest $manifest
        Save-Tarball -Url $manifest.dist.tarball -Destination $download -ExpectedSha256 $sha

        Write-Step 'Installing'
        Expand-Launcher -Tarball $download -Target $launcherRoot
    }
    finally {
        Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
    }

    $shim = New-Shim -BinDirectory $binDirectory -LauncherRoot $launcherRoot
    Add-UserPath -Directory $binDirectory
    Write-Ok "Installed to $launcherRoot"

    if ($SkipSetup) {
        Write-Host ''
        Write-Host 'Next step: githubrelay setup' -ForegroundColor White
        return
    }

    Write-Step 'Running setup'
    Write-Host ''
    & $shim setup

    # Deliberately no `exit`: this script is normally run as `irm ... | iex`,
    # where `exit` would terminate the user's interactive PowerShell session.
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Warn "Setup exited with code $LASTEXITCODE. Run 'githubrelay doctor' for details."
    }
}
catch {
    Write-Host ''
    Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ''
    Write-Host 'If this keeps happening, copy everything above and send it over.' -ForegroundColor DarkGray
    # No `exit` here either: piped through `iex`, it would close the user's window.
}
