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
    exit $LASTEXITCODE
}
catch {
    $message = $_.Exception.Message
    [Console]::Error.WriteLine("Copilot Harness Gateway launcher: $message")
    exit 1
}
