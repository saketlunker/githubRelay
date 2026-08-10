[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$modulePath = Join-Path $repositoryRoot 'powershell\CopilotHarnessGateway.psm1'
Import-Module $modulePath -Force
$gatewayModule = Get-Module CopilotHarnessGateway

$script:Passed = 0
$script:Failed = 0

function Invoke-Test {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Body
    )

    try {
        & $Body
        $script:Passed++
        Write-Host "PASS $Name"
    }
    catch {
        $script:Failed++
        Write-Host "FAIL $Name"
        Write-Host "  $($_.Exception.Message)"
    }
}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Equal {
    param(
        $Expected,
        $Actual,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if ($Expected -ne $Actual) {
        throw "$Message Expected '$Expected', got '$Actual'."
    }
}

$testOutput = Join-Path $repositoryRoot '.test-output'
if (-not (Test-Path -LiteralPath $testOutput)) {
    $null = New-Item -ItemType Directory -Path $testOutput
}
$testRoot = Join-Path $testOutput ("chg-powershell-tests-$([Guid]::NewGuid().ToString('N'))")
try {
    Invoke-Test 'path layout is deterministic and scoped' {
        $paths = Get-CHGPaths $testRoot
        Assert-Equal ([IO.Path]::GetFullPath($testRoot)) $paths.Root 'Install root mismatch.'
        Assert-Equal (Join-Path $paths.Root 'secrets\secrets.json') $paths.Secrets 'Secrets path mismatch.'
        Assert-Equal (Join-Path $paths.Root 'state\install.json') $paths.InstallState 'Install state path mismatch.'
    }

    Invoke-Test 'generated secrets are random base64url values' {
        $first = New-CHGSecret
        $second = New-CHGSecret
        Assert-True ($first.Length -ge 43) 'Secret is too short.'
        Assert-True ($first -match '^[A-Za-z0-9_-]+$') 'Secret is not base64url.'
        Assert-True ($first -ne $second) 'Two generated secrets matched.'
    }

    Invoke-Test 'atomic JSON writes replace complete documents' {
        $file = Join-Path $testRoot 'atomic\state.json'
        Write-CHGAtomicJson $file ([ordered]@{ schemaVersion = 1; value = 'first' })
        Write-CHGAtomicJson $file ([ordered]@{ schemaVersion = 1; value = 'second' })
        $value = Read-CHGJson $file 'test state'
        Assert-Equal 'second' $value.value 'Atomic replacement failed.'
        $temporaryFiles = @(Get-ChildItem (Split-Path -Parent $file) -Filter '*.tmp')
        Assert-Equal 0 $temporaryFiles.Count 'Atomic write left temporary files.'
    }

    Invoke-Test 'default configuration is loopback-only and bounded' {
        $configuration = Get-CHGDefaultConfiguration
        Test-CHGConfiguration $configuration
        Assert-Equal '127.0.0.1' $configuration.listen.address 'Public bind is not loopback.'
        Assert-Equal 2 $configuration.limits.maxConcurrentRequests 'Unexpected concurrency limit.'
        Assert-Equal 20 $configuration.limits.requestsPerMinute 'Unexpected request rate.'

        $configuration.listen.address = '0.0.0.0'
        $threw = $false
        try { Test-CHGConfiguration $configuration } catch { $threw = $true }
        Assert-True $threw 'A non-loopback configuration was accepted.'
    }

    Invoke-Test 'scheduled task name is stable and user-scoped' {
        $first = Get-CHGTaskName
        $second = Get-CHGTaskName
        Assert-Equal $first $second 'Task name is not stable.'
        Assert-True ($first -match '^CopilotHarnessGateway-[0-9a-f]{10}$') 'Task name has an unexpected format.'
    }

    Invoke-Test 'scheduled task definition is hidden, least-privilege, and restart-bounded' {
        $paths = Get-CHGPaths (Join-Path $testRoot 'task-definition')
        $definition = & $gatewayModule {
            param($ResolvedPaths)
            New-CHGScheduledTaskDefinition -Paths $ResolvedPaths
        } $paths
        Assert-True ($definition.Action.Arguments -like '*-WindowStyle Hidden*') 'Task action is not hidden.'
        Assert-True ($definition.Action.Arguments -like "*$($paths.StableLauncher)*") 'Task action does not use the stable launcher.'
        Assert-Equal 'Limited' ([string]$definition.Principal.RunLevel) 'Task does not use limited privilege.'
        Assert-Equal 'Interactive' ([string]$definition.Principal.LogonType) 'Task does not use the current interactive token.'
        Assert-Equal 'IgnoreNew' ([string]$definition.Settings.MultipleInstances) 'Task can create duplicate instances.'
        Assert-Equal 3 $definition.Settings.RestartCount 'Task restart count is not bounded.'
        Assert-Equal 'PT1M' ([string]$definition.Settings.RestartInterval) 'Task restart interval is unexpected.'
        Assert-Equal $true $definition.Settings.Hidden 'Task definition is not hidden.'
        Assert-Equal 'PT0S' ([string]$definition.Settings.ExecutionTimeLimit) 'Task has an execution time limit.'
    }

    Invoke-Test 'install-root ACL is restricted to the current user and SYSTEM' {
        $paths = Get-CHGPaths (Join-Path $testRoot 'acl-root')
        & $gatewayModule {
            param($ResolvedPaths)
            Initialize-CHGDirectories -Paths $ResolvedPaths
        } $paths
        $acl = Get-Acl -LiteralPath $paths.Root
        Assert-Equal $true $acl.AreAccessRulesProtected 'Install-root ACL still inherits parent access.'
        $allowedSids = @(
            [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
            'S-1-5-18'
        )
        $actualSids = @(
            $acl.Access |
                Where-Object { $_.AccessControlType -eq 'Allow' } |
                ForEach-Object {
                    $_.IdentityReference.Translate(
                        [Security.Principal.SecurityIdentifier]
                    ).Value
                } |
                Sort-Object -Unique
        )
        Assert-Equal `
            (($allowedSids | Sort-Object) -join ',') `
            ($actualSids -join ',') `
            'Install-root ACL has unexpected allowed identities.'
        foreach ($rule in $acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' }) {
            Assert-True (
                ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq
                [Security.AccessControl.FileSystemRights]::FullControl
            ) 'Install-root ACL did not grant full control to an allowed identity.'
        }
    }

    Invoke-Test 'installer dry-run performs no writes' {
        $installRoot = Join-Path $testRoot 'dry-run-install'
        $result = Install-CHGGateway `
            -InstallRoot $installRoot `
            -SourceRoot $repositoryRoot `
            -DryRun `
            -SkipTask `
            -SkipAcl
        Assert-Equal $false $result.WritesPerformed 'Dry-run reported writes.'
        Assert-Equal '2.0.1' $result.BackendVersion 'Dry-run did not use the exact pin.'
        Assert-True (-not (Test-Path -LiteralPath $installRoot)) 'Dry-run created the install root.'
    }

    Invoke-Test 'installer rejects latest and version ranges' {
        foreach ($invalid in @('latest', '^2.0.1', '2.x')) {
            $threw = $false
            try {
                $null = Install-CHGGateway `
                    -InstallRoot (Join-Path $testRoot "invalid-$($invalid.Replace('.', '-'))") `
                    -SourceRoot $repositoryRoot `
                    -BackendVersion $invalid `
                    -DryRun `
                    -SkipTask `
                    -SkipAcl
            }
            catch {
                $threw = $true
            }
            Assert-True $threw "Invalid backend version '$invalid' was accepted."
        }
    }

    Invoke-Test 'new backend pins require a reviewed source lock' {
        $threw = $false
        try {
            $null = Install-CHGGateway `
                -InstallRoot (Join-Path $testRoot 'unpinned-install') `
                -SourceRoot $repositoryRoot `
                -BackendVersion '2.0.2' `
                -DryRun `
                -SkipTask `
                -SkipAcl
        }
        catch {
            $threw = $_.Exception.Message -like '*source bundle pins*'
        }
        Assert-True $threw 'Installer accepted a backend pin absent from the source lock.'

        $threw = $false
        try {
            $null = Update-CHGGateway `
                -InstallRoot (Join-Path $testRoot 'not-installed') `
                -SourceRoot $repositoryRoot `
                -Version '2.0.2' `
                -SkipTask `
                -SkipAcl
        }
        catch {
            $threw = $_.Exception.Message -like '*source bundle pins*'
        }
        Assert-True $threw 'Updater accepted a backend pin absent from the source lock.'
    }

    Invoke-Test 'root installer dry-run emits machine-readable output' {
        $installRoot = Join-Path $testRoot 'script-dry-run'
        $json = & (Join-Path $repositoryRoot 'gateway.ps1') `
            install `
            -InstallRoot $installRoot `
            -DryRun `
            -SkipTask `
            -SkipAcl `
            -Json
        $result = $json | ConvertFrom-Json
        Assert-Equal 'install' $result.Action 'Dispatcher returned the wrong action.'
        Assert-True (-not (Test-Path -LiteralPath $installRoot)) 'Dispatcher dry-run wrote files.'
    }
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

Write-Host ""
Write-Host "$($script:Passed) passed, $($script:Failed) failed"
if ($script:Failed -ne 0) {
    exit 1
}
