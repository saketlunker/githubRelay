[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-LauncherLog {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Fields
    )

    # The supervisor cannot log its own death when it is terminated from
    # outside, so the launcher records what it saw.
    try {
        $entry = [ordered]@{
            timestamp = [DateTime]::UtcNow.ToString('o')
            component = 'launcher'
        }
        foreach ($key in $Fields.Keys) { $entry[$key] = $Fields[$key] }
        # Explicitly BOM-free: Windows PowerShell 5.1 writes a BOM when it
        # creates a file, which would corrupt the first JSONL line after the
        # supervisor rotates the log.
        [IO.File]::AppendAllText(
            (Join-Path $Root 'logs\supervisor.jsonl'),
            ($entry | ConvertTo-Json -Compress) + "`n",
            [Text.UTF8Encoding]::new($false)
        )
    }
    catch {
        # Logging must never change how the launcher behaves.
    }
}

function Get-RunningSupervisor {
    param([Parameter(Mandatory = $true)][string]$Root)

    $lockPath = Join-Path $Root 'state\runtime.lock'
    if (-not (Test-Path -LiteralPath $lockPath)) { return $null }
    try {
        $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$lock.pid)" -ErrorAction Stop
        if ($null -eq $candidate -or [string]::IsNullOrWhiteSpace([string]$candidate.CommandLine)) { return $null }
        # Identity by command line, so a reused PID is never mistaken for the
        # supervisor of this install.
        $commandLine = ([string]$candidate.CommandLine).ToLowerInvariant()
        if ($commandLine.Contains('supervisor.mjs') -and $commandLine.Contains($Root.ToLowerInvariant())) {
            return Get-Process -Id $candidate.ProcessId -ErrorAction Stop
        }
    }
    catch {
        # An unreadable lock or a vanished process means there is nothing to adopt.
    }
    return $null
}

try {
    $root = [IO.Path]::GetFullPath($InstallRoot)
    $desiredPath = Join-Path $root 'state\desired-state.json'
    if (-not (Test-Path -LiteralPath $desiredPath)) {
        exit 0
    }

    $desired = Get-Content -LiteralPath $desiredPath -Raw | ConvertFrom-Json
    if ($desired.state -ne 'running') {
        exit 0
    }

    # A supervisor that outlived its launcher is adopted, not duplicated.
    # Waiting on it keeps this task instance running, so the one-minute
    # watchdog stays quiet instead of starting a new launcher every minute.
    $running = Get-RunningSupervisor -Root $root
    if ($null -ne $running) {
        Write-LauncherLog -Root $root -Fields ([ordered]@{ level = 'info'; event = 'supervisor.adopted'; pid = $running.Id })
        $running.WaitForExit()
        Write-LauncherLog -Root $root -Fields ([ordered]@{ level = 'warn'; event = 'supervisor.exited'; adopted = $true })
        exit 0
    }

    $installPath = Join-Path $root 'state\install.json'
    $install = Get-Content -LiteralPath $installPath -Raw | ConvertFrom-Json
    $release = $install.releases.PSObject.Properties[$install.activeVersionId].Value
    if ($null -eq $release) {
        throw "Active release '$($install.activeVersionId)' is not installed."
    }

    $supervisor = Join-Path $root (
        'versions\{0}\runtime\supervisor.mjs' -f $install.activeVersionId
    )
    if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) {
        throw "Supervisor is missing: $supervisor"
    }
    if (-not (Test-Path -LiteralPath $install.nodePath -PathType Leaf)) {
        throw "Pinned Node executable is missing: $($install.nodePath)"
    }

    # The supervisor gets its own console with no window instead of sharing
    # this launcher's. Closing a console window sends CTRL_CLOSE to every
    # process attached to it, which Node surfaces as SIGHUP: that stopped the
    # relay whenever the launcher's console was closed, including through
    # Windows Terminal when it is the default console host.
    $startInfo = [Diagnostics.ProcessStartInfo]::new([string]$install.nodePath)
    $startInfo.Arguments = '"{0}" --root "{1}"' -f $supervisor, $root
    $startInfo.WorkingDirectory = $root
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($startInfo)
    $process.WaitForExit()
    $exitCode = $process.ExitCode

    Write-LauncherLog -Root $root -Fields ([ordered]@{
        level = $(if ($exitCode -eq 0) { 'info' } else { 'warn' })
        event = 'supervisor.exited'
        exitCode = $exitCode
        exitCodeHex = ('0x{0:X8}' -f $exitCode)
    })
    exit $exitCode
}
catch {
    $message = $_.Exception.Message
    [Console]::Error.WriteLine("Copilot Harness Gateway launcher: $message")
    exit 1
}
