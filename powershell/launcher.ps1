[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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

    & $install.nodePath $supervisor --root $root
    $exitCode = $LASTEXITCODE

    # The supervisor cannot log its own death when it is terminated from
    # outside, so the launcher records the exit code. A console being closed,
    # for example, shows up as 0xC000013A rather than as an unexplained gap.
    try {
        $entry = [ordered]@{
            timestamp = [DateTime]::UtcNow.ToString('o')
            level = $(if ($exitCode -eq 0) { 'info' } else { 'warn' })
            component = 'launcher'
            event = 'supervisor.exited'
            exitCode = $exitCode
            exitCodeHex = ('0x{0:X8}' -f $exitCode)
        }
        $logPath = Join-Path $root 'logs\supervisor.jsonl'
        # Explicitly BOM-free: Windows PowerShell 5.1 writes a BOM when it
        # creates a file, which would corrupt the first JSONL line after the
        # supervisor rotates the log.
        [IO.File]::AppendAllText(
            $logPath,
            ($entry | ConvertTo-Json -Compress) + "`n",
            [Text.UTF8Encoding]::new($false)
        )
    }
    catch {
        # Logging must never change how the launcher exits.
    }
    exit $exitCode
}
catch {
    $message = $_.Exception.Message
    [Console]::Error.WriteLine("Copilot Harness Gateway launcher: $message")
    exit 1
}
