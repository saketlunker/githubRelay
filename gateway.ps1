[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet(
        'install',
        'authenticate',
        'configure-clients',
        'start',
        'stop',
        'restart',
        'status',
        'health',
        'logs',
        'models',
        'update',
        'rollback',
        'uninstall'
    )]
    [string]$Command = 'status',

    [string]$InstallRoot,
    [string]$BackendVersion,
    [string]$ExpectedIntegrity,
    [string]$Version,
    [string[]]$Clients = @('all'),
    [string]$Model,
    [string]$ClaudeModel,
    [string]$CodexModel,
    [string]$FastModel,
    [string]$Alias,
    [string]$ModelsFile,
    [Alias('Home')]
    [string]$ClientHome,
    [ValidateSet('list', 'refresh', 'set-alias')]
    [string]$ModelsAction = 'list',
    [ValidateRange(0, 3600)]
    [int]$TimeoutSeconds = 0,
    [ValidateRange(100, 120000)]
    [int]$TimeoutMilliseconds = 10000,
    [ValidateRange(1, 10000)]
    [int]$Tail = 100,
    [switch]$SetDefault,
    [switch]$Deep,
    [switch]$Follow,
    [switch]$Force,
    [switch]$DryRun,
    [switch]$SkipTask,
    [switch]$SkipAcl,
    [switch]$Offline,
    [switch]$PreserveState,
    [switch]$KeepClientConfiguration,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-InstalledModule {
    param([string]$Root)

    $installStatePath = Join-Path $Root 'state\install.json'
    if (-not (Test-Path -LiteralPath $installStatePath -PathType Leaf)) {
        throw "Gateway is not installed at '$Root'."
    }
    $installState = Get-Content -LiteralPath $installStatePath -Raw | ConvertFrom-Json
    $releaseRoot = Join-Path $Root "versions\$($installState.activeVersionId)"
    return [ordered]@{
        Module = Join-Path $releaseRoot 'powershell\CopilotHarnessGateway.psm1'
        SourceRoot = $releaseRoot
    }
}

$localModule = Join-Path $PSScriptRoot 'powershell\CopilotHarnessGateway.psm1'
if (Test-Path -LiteralPath $localModule -PathType Leaf) {
    $moduleContext = [ordered]@{
        Module = $localModule
        SourceRoot = $PSScriptRoot
    }
}
else {
    if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            throw 'LOCALAPPDATA is unavailable. Specify -InstallRoot.'
        }
        $InstallRoot = Join-Path $env:LOCALAPPDATA 'CopilotHarnessGateway'
    }
    $moduleContext = Resolve-InstalledModule ([IO.Path]::GetFullPath($InstallRoot))
}

Import-Module $moduleContext.Module -Force

$startTimeoutSeconds = if ($TimeoutSeconds -eq 0) { 60 } else { $TimeoutSeconds }
$stopTimeoutSeconds = if ($TimeoutSeconds -eq 0) { 15 } else { $TimeoutSeconds }
$authenticationTimeoutSeconds = if ($TimeoutSeconds -eq 0) { 900 } else { $TimeoutSeconds }

switch ($Command) {
    'install' {
        $result = Install-CHGGateway `
            -InstallRoot $InstallRoot `
            -SourceRoot $moduleContext.SourceRoot `
            -BackendVersion $BackendVersion `
            -ExpectedIntegrity $ExpectedIntegrity `
            -SkipTask:$SkipTask `
            -SkipAcl:$SkipAcl `
            -Offline:$Offline `
            -DryRun:$DryRun
    }
    'authenticate' {
        $result = Invoke-CHGAuthenticate `
            -InstallRoot $InstallRoot `
            -TimeoutSeconds $authenticationTimeoutSeconds
    }
    'configure-clients' {
        $result = Invoke-CHGConfigureClients `
            -InstallRoot $InstallRoot `
            -Clients $Clients `
            -Model $Model `
            -ClaudeModel $ClaudeModel `
            -CodexModel $CodexModel `
            -FastModel $FastModel `
            -ClientHome $ClientHome `
            -ModelsFile $ModelsFile `
            -SetDefault:$SetDefault `
            -DryRun:$DryRun `
            -Force:$Force
    }
    'start' {
        $result = Start-CHGGateway `
            -InstallRoot $InstallRoot `
            -TimeoutSeconds $startTimeoutSeconds `
            -SkipTask:$SkipTask
    }
    'stop' {
        $result = Stop-CHGGateway `
            -InstallRoot $InstallRoot `
            -TimeoutSeconds $stopTimeoutSeconds
    }
    'restart' {
        $result = Restart-CHGGateway `
            -InstallRoot $InstallRoot `
            -TimeoutSeconds $startTimeoutSeconds
    }
    'status' {
        $result = Get-CHGGatewayStatus -InstallRoot $InstallRoot
    }
    'health' {
        $result = Get-CHGGatewayHealth -InstallRoot $InstallRoot -Deep:$Deep
    }
    'logs' {
        $result = Get-CHGGatewayLogs `
            -InstallRoot $InstallRoot `
            -Tail $Tail `
            -Follow:$Follow
    }
    'models' {
        $result = Invoke-CHGModels `
            -InstallRoot $InstallRoot `
            -Action $ModelsAction `
            -Alias $Alias `
            -Model $Model `
            -ModelsFile $ModelsFile `
            -TimeoutMilliseconds $TimeoutMilliseconds
    }
    'update' {
        $result = Update-CHGGateway `
            -InstallRoot $InstallRoot `
            -SourceRoot $moduleContext.SourceRoot `
            -Version $Version `
            -ExpectedIntegrity $ExpectedIntegrity `
            -SkipAcl:$SkipAcl `
            -SkipTask:$SkipTask `
            -Offline:$Offline
    }
    'rollback' {
        $result = Update-CHGGateway `
            -InstallRoot $InstallRoot `
            -SourceRoot $moduleContext.SourceRoot `
            -Rollback `
            -SkipAcl:$SkipAcl `
            -SkipTask:$SkipTask `
            -Offline:$Offline
    }
    'uninstall' {
        $result = Uninstall-CHGGateway `
            -InstallRoot $InstallRoot `
            -PreserveState:$PreserveState `
            -KeepClientConfiguration:$KeepClientConfiguration
    }
}

if ($Json -and $null -ne $result) {
    $result | ConvertTo-Json -Depth 100
}
elseif ($null -ne $result) {
    $result
}
