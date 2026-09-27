<#
.SYNOPSIS
    Installs GitHub Model Relay on Windows.

.DESCRIPTION
    Designed to be pasted into a fresh PowerShell window:

        irm https://raw.githubusercontent.com/saketlunker/githubRelay/main/web-install.ps1 | iex

    It works in Windows PowerShell 5.1, which is the only PowerShell a freshly
    installed Windows has, as well as in PowerShell 7. It installs Node.js with
    winget when it is missing or too old, installs the relay through npm, and
    falls back to the GitHub release when the npm registry is unreachable, as
    it is on some corporate networks.

    Set GITHUBRELAY_SKIP_SETUP=1 to install without running setup.
#>

[CmdletBinding()]
param(
    [string]$PackageName = 'githubrelay',
    [string]$ManifestUrl = 'https://raw.githubusercontent.com/saketlunker/githubRelay/main/releases/prod/latest.json',
    [switch]$SkipSetup
)

# Everything runs in a child scope. `irm ... | iex` executes in the caller's
# own scope, so preference variables and strict mode set here would otherwise
# stay in force in the user's window after the installer finishes.
& {
    param([string]$PackageName, [string]$ManifestUrl, [bool]$SkipSetup)

    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    # The progress bar makes Invoke-WebRequest many times slower in 5.1.
    $ProgressPreference = 'SilentlyContinue'
    # Windows PowerShell 5.1 may not offer TLS 1.2 by default.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $MinimumNode = [Version]'22.13.0'

    function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
    function Write-Ok { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }
    function Write-Warn { param([string]$Message) Write-Host "    $Message" -ForegroundColor Yellow }
    function Write-Detail { param([string]$Message) Write-Host "    $Message" -ForegroundColor DarkGray }

    # Native commands are run through cmd.exe with stderr merged inside cmd.
    # In Windows PowerShell 5.1, redirecting a native command's stderr in
    # PowerShell while ErrorActionPreference is Stop turns its first stderr
    # line into a terminating error, so npm's first warning aborted the
    # install before the fallback could run.
    function Invoke-Native {
        param([Parameter(Mandatory = $true)][string]$CommandLine)
        $output = @(& cmd.exe /d /s /c "$CommandLine 2>&1")
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
    }

    function Assert-Windows {
        if ($env:OS -ne 'Windows_NT') {
            throw 'GitHub Model Relay currently supports Windows only.'
        }
    }

    function Update-PathFromEnvironment {
        # An installer updates the stored PATH; a running shell does not see it
        # until the variables are re-read.
        $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        $env:Path = "$machinePath;$userPath"
    }

    function Get-NodeVersion {
        if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { return $null }
        $result = Invoke-Native 'node --version'
        if ($result.ExitCode -ne 0 -or $result.Output.Count -eq 0) { return $null }
        try { return [Version](([string]$result.Output[0]).Trim().TrimStart('v') -replace '-.*$', '') } catch { return $null }
    }

    function Install-NodeWithWinget {
        if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { return $false }

        Write-Warn 'Installing Node.js LTS with winget. Approve any prompt that appears.'
        & winget.exe install --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements --silent
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
        if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
            throw 'npm was not found on PATH. It ships with Node.js; reinstall Node.js and open a new PowerShell window.'
        }
    }

    function Enable-LocalScripts {
        # npm puts PowerShell shims on PATH (githubrelay.ps1, npm.ps1), and
        # Windows client editions default to the Restricted policy, which
        # refuses every script. Without this, typing `githubrelay` or `npm` in
        # a new Windows PowerShell window fails. RemoteSigned for the current
        # user is the policy PowerShell 7 already uses: local scripts run,
        # downloaded ones must be signed.
        $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        if (-not (Test-Path -LiteralPath $windowsPowerShell)) { return }

        # Persistent scopes only. The effective policy of this process can be
        # a temporary Process-scope Bypass that a new window would not have.
        $query = "foreach (`$s in 'MachinePolicy','UserPolicy','CurrentUser','LocalMachine') { `$s + '=' + (Get-ExecutionPolicy -Scope `$s) }"
        $scopes = @{}
        foreach ($line in @(& $windowsPowerShell -NoProfile -NonInteractive -Command $query)) {
            $parts = ([string]$line).Trim() -split '=', 2
            if ($parts.Count -eq 2) { $scopes[$parts[0]] = $parts[1] }
        }

        foreach ($pinned in @('MachinePolicy', 'UserPolicy')) {
            if ($scopes[$pinned] -and $scopes[$pinned] -ne 'Undefined') {
                if ($scopes[$pinned] -in @('Restricted', 'AllSigned')) {
                    Write-Warn "PowerShell scripts are restricted by group policy. Use 'githubrelay.cmd' in place of 'githubrelay'."
                }
                return
            }
        }

        $effective = 'Restricted'
        foreach ($scope in @('CurrentUser', 'LocalMachine')) {
            if ($scopes[$scope] -and $scopes[$scope] -ne 'Undefined') { $effective = $scopes[$scope]; break }
        }
        if ($effective -ne 'Restricted') { return }

        & $windowsPowerShell -NoProfile -NonInteractive -Command 'try { Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force -ErrorAction Stop } catch { }' | Out-Null
        $after = ([string](& $windowsPowerShell -NoProfile -NonInteractive -Command 'Get-ExecutionPolicy -Scope CurrentUser' | Select-Object -Last 1)).Trim()
        if ($after -eq 'RemoteSigned') {
            Write-Ok 'Allowed local PowerShell scripts for your account (RemoteSigned) so githubrelay and npm run in new windows'
        }
        else {
            Write-Warn "Could not allow local PowerShell scripts. Use 'githubrelay.cmd' in place of 'githubrelay'."
        }
    }

    function Invoke-WithRetries {
        param(
            [Parameter(Mandatory = $true)][scriptblock]$Action,
            [int]$Attempts = 4,
            [string]$What = 'request'
        )

        # Corporate proxies in front of GitHub return intermittent 504s, so
        # one transient failure must not fail the whole install.
        for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
            try {
                return & $Action
            }
            catch {
                if ($attempt -eq $Attempts) { throw }
                Write-Warn "$What failed (attempt $attempt): $($_.Exception.Message.Split([Environment]::NewLine)[0])"
                Start-Sleep -Milliseconds (1500 * $attempt)
            }
        }
    }

    function Install-FromRelease {
        $manifest = Invoke-WithRetries -What 'Reading the release manifest' -Action {
            Invoke-RestMethod -Uri $ManifestUrl -TimeoutSec 30 -UseBasicParsing
        }
        if (-not $manifest.PSObject.Properties['fallback'] -or -not $manifest.fallback.tarball) {
            throw 'npm could not reach the registry and the release manifest publishes no fallback tarball.'
        }
        $tarballUrl = [string]$manifest.fallback.tarball

        $workspace = Join-Path ([IO.Path]::GetTempPath()) ('githubrelay-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $workspace -Force | Out-Null
        try {
            $archive = Join-Path $workspace (Split-Path -Leaf $tarballUrl)
            Write-Detail "Downloading $tarballUrl"
            Invoke-WithRetries -What 'Download' -Action {
                Invoke-WebRequest -Uri $tarballUrl -OutFile $archive -TimeoutSec 300 -UseBasicParsing
            } | Out-Null

            if ($manifest.fallback.PSObject.Properties['sha256Url']) {
                $published = Invoke-WithRetries -What 'Checksum fetch' -Action {
                    Invoke-RestMethod -Uri $manifest.fallback.sha256Url -TimeoutSec 30 -UseBasicParsing
                }
                $expected = [regex]::Match([string]$published, '[A-Fa-f0-9]{64}')
                if (-not $expected.Success) {
                    throw 'The published checksum could not be read, so the download cannot be verified.'
                }
                $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($actual -ne $expected.Value.ToLowerInvariant()) {
                    throw "Download failed verification. Expected $($expected.Value) but got $actual."
                }
                Write-Ok 'Checksum verified'
            }

            # npm refuses remote tarball specs by default (allow-remote=none)
            # but installs a local file, so the tarball is downloaded first.
            $result = Invoke-Native "npm install -g `"$archive`""
            $result.Output | ForEach-Object { Write-Detail "$_" }
            if ($result.ExitCode -ne 0) {
                throw "Installing the downloaded package failed with exit code $($result.ExitCode)."
            }
        }
        finally {
            Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    function Install-Launcher {
        param([string]$Package)

        # Output is held back: on a registry-blocked network this attempt
        # fails noisily, and printing that before a successful fallback makes
        # a working install look broken.
        $attempt = Invoke-Native "npm install -g $Package@latest"
        if ($attempt.ExitCode -eq 0) {
            $attempt.Output | ForEach-Object { Write-Detail "$_" }
            Update-PathFromEnvironment
            return
        }

        Write-Warn 'npm registry unavailable on this network. Using the GitHub release instead.'
        try {
            Install-FromRelease
        }
        catch {
            Write-Host ''
            Write-Detail 'The npm registry attempt reported:'
            $attempt.Output | Select-Object -Last 6 | ForEach-Object { Write-Detail "$_" }
            throw
        }
        Update-PathFromEnvironment
    }

    function Resolve-Launcher {
        # The .cmd shim runs under any execution policy; the .ps1 shim that
        # PowerShell would pick by default is refused under Restricted.
        $prefix = Invoke-Native 'npm prefix -g'
        if ($prefix.ExitCode -eq 0 -and $prefix.Output.Count -gt 0) {
            $candidate = Join-Path ([string]$prefix.Output[0]).Trim() 'githubrelay.cmd'
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
        $command = Get-Command githubrelay.cmd -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
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
        Enable-LocalScripts

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

        # Deliberately no `exit`: under `irm ... | iex` it would close the
        # user's PowerShell window rather than end the script.
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
} $PackageName $ManifestUrl ($SkipSetup.IsPresent -or $env:GITHUBRELAY_SKIP_SETUP -eq '1')
