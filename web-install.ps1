<#
.SYNOPSIS
    Installs GitHub Model Relay on Windows.

.DESCRIPTION
    Designed to be piped straight from the web:

        irm https://raw.githubusercontent.com/saketlunker/githubRelay/main/web-install.ps1 | iex

    If you already have Node.js 22.13 or newer, you do not need this script:

        npm install -g githubrelay
        githubrelay setup

    This wrapper exists for a clean Windows machine. It installs Node.js when
    it is missing or too old, then hands off to npm so there is exactly one
    installed copy for the launcher to update later.
#>

[CmdletBinding()]
param(
    [string]$PackageName = 'githubrelay',
    [string]$ManifestUrl = 'https://raw.githubusercontent.com/saketlunker/githubRelay/main/releases/prod/latest.json',
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
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $null }
    $raw = (& node --version 2>$null)
    if (-not $raw) { return $null }
    try { return [Version]($raw.TrimStart('v') -replace '-.*$', '') } catch { return $null }
}

function Update-PathFromEnvironment {
    # An installer updates the stored PATH; this already-running shell does not
    # see it until the variables are re-read.
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"
}

function Install-NodeWithWinget {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { return $false }

    Write-Warn 'Installing Node.js LTS with winget. Approve any prompt that appears.'
    & winget install --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) { return $false }

    Update-PathFromEnvironment
    return $true
}

function Assert-Node {
    $version = Get-NodeVersion
    if ($version -and $version -ge $MinimumNode) {
        Write-Ok "Node.js $version"
        return
    }

    if ($version) { Write-Warn "Node.js $version is older than the required $MinimumNode." }
    else { Write-Warn 'Node.js was not found.' }

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

function Assert-Npm {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm was not found on PATH. It ships with Node.js; reinstall Node.js and open a new PowerShell window.'
    }
}

function Install-Launcher {
    param([string]$Package)

    # Routed through cmd.exe because npm on Windows is a shim that PowerShell
    # does not always invoke cleanly with forwarded arguments.
    # Output is captured rather than streamed: on a registry-blocked network
    # this attempt fails noisily with red 404s, and showing those before a
    # successful fallback makes a working install look broken.
    $attempt = & cmd.exe /d /s /c "npm install -g $Package@latest" 2>&1
    if ($LASTEXITCODE -eq 0) {
        $attempt | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        Update-PathFromEnvironment
        return
    }

    Write-Warn 'npm registry unavailable on this network. Using the GitHub release instead.'
    try {
        Install-FromRelease
    }
    catch {
        Write-Host ''
        Write-Host '    The npm registry attempt reported:' -ForegroundColor DarkGray
        $attempt | Select-Object -Last 6 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        throw
    }
    Update-PathFromEnvironment
}

function Install-FromRelease {
    $manifest = Invoke-RestMethod -Uri $ManifestUrl -TimeoutSec 30
    $tarballUrl = $manifest.fallback.tarball
    if (-not $tarballUrl) {
        throw 'npm could not reach the registry and the release manifest publishes no fallback tarball.'
    }

    $workspace = Join-Path ([IO.Path]::GetTempPath()) ('githubrelay-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    try {
        $archive = Join-Path $workspace (Split-Path -Leaf $tarballUrl)
        Write-Ok "Downloading $tarballUrl"
        Invoke-WebRequest -Uri $tarballUrl -OutFile $archive -TimeoutSec 300 -UseBasicParsing

        if ($manifest.fallback.PSObject.Properties['sha256Url']) {
            $published = Invoke-RestMethod -Uri $manifest.fallback.sha256Url -TimeoutSec 30
            $expected = [regex]::Match([string]$published, '[A-Fa-f0-9]{64}')
            if ($expected.Success) {
                $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($actual -ne $expected.Value.ToLowerInvariant()) {
                    throw "Download failed verification. Expected $($expected.Value) but got $actual."
                }
                Write-Ok 'Checksum verified'
            }
        }

        # npm blocks remote tarball specs by default (allow-remote=none) but
        # still installs from a local file, which is why this is downloaded
        # first rather than handed to npm as a URL.
        & cmd.exe /d /s /c "npm install -g `"$archive`"" 2>&1 |
            ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        if ($LASTEXITCODE -ne 0) {
            throw "Installing the downloaded package failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Resolve-Launcher {
    $command = Get-Command githubrelay -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    # npm's global bin directory may not be on PATH in this shell yet.
    $prefix = (& cmd.exe /d /s /c 'npm prefix -g' 2>$null | Select-Object -First 1)
    if ($prefix) {
        $candidate = Join-Path $prefix.Trim() 'githubrelay.cmd'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

try {
    Write-Host ''
    Write-Host 'GitHub Model Relay installer' -ForegroundColor White
    Write-Host 'Unofficial community tool. Not affiliated with GitHub.' -ForegroundColor DarkGray
    Write-Host ''

    Write-Step 'Checking prerequisites'
    Assert-Windows
    Assert-Node
    Assert-Npm

    Write-Step "Installing $PackageName"
    Install-Launcher -Package $PackageName

    $launcher = Resolve-Launcher
    if (-not $launcher) {
        throw "Installed $PackageName, but the githubrelay command is not on PATH. Open a new PowerShell window and run: githubrelay setup"
    }
    Write-Ok "Installed $launcher"

    if ($SkipSetup) {
        Write-Host ''
        Write-Host 'Next step: githubrelay setup' -ForegroundColor White
        return
    }

    Write-Step 'Running setup'
    Write-Host ''
    & $launcher setup

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
}
