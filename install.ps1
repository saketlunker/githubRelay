[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$BackendVersion,
    [string]$ExpectedIntegrity,
    [switch]$SkipTask,
    [switch]$SkipAcl,
    [switch]$Offline,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$module = Join-Path $PSScriptRoot 'powershell\CopilotHarnessGateway.psm1'
Import-Module $module -Force

Install-CHGGateway `
    -InstallRoot $InstallRoot `
    -SourceRoot $PSScriptRoot `
    -BackendVersion $BackendVersion `
    -ExpectedIntegrity $ExpectedIntegrity `
    -SkipTask:$SkipTask `
    -SkipAcl:$SkipAcl `
    -Offline:$Offline `
    -DryRun:$DryRun
