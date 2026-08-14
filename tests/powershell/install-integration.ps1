[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$testOutput = Join-Path $repositoryRoot '.test-output'
if (-not (Test-Path -LiteralPath $testOutput)) {
    $null = New-Item -ItemType Directory -Path $testOutput
}
$unicodeMarker = [char]0x00FC
$installRoot = Join-Path $testOutput ("full install $unicodeMarker $([Guid]::NewGuid().ToString('N'))")
$updateSource = Join-Path $testOutput ("update source $unicodeMarker $([Guid]::NewGuid().ToString('N'))")
$modulePath = Join-Path $repositoryRoot 'powershell\CopilotHarnessGateway.psm1'
Import-Module $modulePath -Force

function Get-FreeTcpPort {
    $listener = [Net.Sockets.TcpListener]::new(
        [Net.IPAddress]::Loopback,
        0
    )
    try {
        $listener.Start()
        return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

try {
    $first = Install-CHGGateway `
        -InstallRoot $installRoot `
        -SourceRoot $repositoryRoot `
        -SkipTask `
        -SkipAcl `
        -Offline

    if ($first.BackendVersion -ne '2.0.1') {
        throw "Unexpected backend version '$($first.BackendVersion)'."
    }
    $paths = Get-CHGPaths $installRoot
    $firstSecrets = Read-CHGJson $paths.Secrets 'gateway secrets'
    $configuration = Read-CHGJson $paths.GatewayConfig 'gateway configuration'
    if ($configuration.listen.address -ne '127.0.0.1' -or $configuration.backend.address -ne '127.0.0.1') {
        throw 'Installer produced a non-loopback configuration.'
    }
    if ($firstSecrets.clientApiKey -eq $firstSecrets.internalApiKey -or $firstSecrets.clientApiKey -eq $firstSecrets.adminApiKey) {
        throw 'Installer reused a local key across trust boundaries.'
    }

    $releaseRoot = Join-Path $paths.Versions $first.ReleaseId
    $backendPackage = Read-CHGJson `
        (Join-Path $releaseRoot 'node_modules\@jeffreycao\copilot-api\package.json') `
        'installed backend package'
    if ($backendPackage.version -ne '2.0.1') {
        throw 'Immutable release does not contain the pinned backend.'
    }

    $second = Install-CHGGateway `
        -InstallRoot $installRoot `
        -SourceRoot $repositoryRoot `
        -SkipTask `
        -SkipAcl `
        -Offline
    $secondSecrets = Read-CHGJson $paths.Secrets 'gateway secrets'
    if ($second.ReleaseId -ne $first.ReleaseId) {
        throw 'Idempotent installation activated a duplicate release.'
    }
    if ($secondSecrets.clientApiKey -ne $firstSecrets.clientApiKey) {
        throw 'Idempotent installation rotated the client key.'
    }
    if (@(Get-ChildItem -LiteralPath $paths.Versions -Directory).Count -ne 1) {
        throw 'Idempotent installation created an extra immutable release.'
    }
    $backendEntrypoint = Join-Path $releaseRoot 'node_modules\@jeffreycao\copilot-api\dist\main.js'
    $originalEntrypointHash = (Get-FileHash -LiteralPath $backendEntrypoint -Algorithm SHA256).Hash
    [IO.File]::AppendAllText($backendEntrypoint, "`n// test corruption`n")
    $repaired = Install-CHGGateway `
        -InstallRoot $installRoot `
        -SourceRoot $repositoryRoot `
        -SkipTask `
        -SkipAcl `
        -Offline
    if ($repaired.ReleaseId -ne $first.ReleaseId) {
        throw 'Repair changed the deterministic release ID.'
    }
    if ((Get-FileHash -LiteralPath $backendEntrypoint -Algorithm SHA256).Hash -ne $originalEntrypointHash) {
        throw 'Reinstallation did not repair a modified immutable backend.'
    }
    if (@(Get-ChildItem (Join-Path $paths.Backups 'corrupt-releases') -Directory -ErrorAction SilentlyContinue).Count -ne 1) {
        throw 'Modified immutable release was not quarantined exactly once.'
    }

    $null = New-Item -ItemType Directory -Path $updateSource
    foreach ($fileName in @(
        'package.json',
        'package-lock.json',
        'gateway.ps1',
        'THIRD_PARTY_NOTICES.md'
    )) {
        Copy-Item -LiteralPath (Join-Path $repositoryRoot $fileName) -Destination $updateSource
    }
    foreach ($directoryName in @('runtime', 'powershell', 'licenses')) {
        Copy-Item `
            -LiteralPath (Join-Path $repositoryRoot $directoryName) `
            -Destination (Join-Path $updateSource $directoryName) `
            -Recurse
    }
    [IO.File]::AppendAllText(
        (Join-Path $updateSource 'runtime\supervisor.mjs'),
        "`n// Test-only immutable release discriminator.`n"
    )
    [IO.File]::AppendAllText(
        (Join-Path $updateSource 'gateway.ps1'),
        "`n# Test-only stable launcher discriminator.`n"
    )
    $backendStateMarker = Join-Path $paths.BackendHome 'state-marker.txt'
    [IO.File]::WriteAllText($backendStateMarker, 'before-update')
    $updated = Update-CHGGateway `
        -InstallRoot $installRoot `
        -SourceRoot $updateSource `
        -Version '2.0.1' `
        -SkipTask `
        -SkipAcl `
        -Offline
    $updatedState = Read-CHGJson $paths.InstallState 'updated install state'
    if ($updatedState.activeVersionId -eq $first.ReleaseId) {
        throw 'Update did not activate the new immutable release.'
    }
    if ($updatedState.previousVersionId -ne $first.ReleaseId) {
        throw 'Update did not retain the rollback pointer.'
    }
    $updatedReleaseId = [string]$updatedState.activeVersionId
    if ([IO.File]::ReadAllText($paths.StableGateway) -notlike '*Test-only stable launcher discriminator*') {
        throw 'Update did not activate the new stable management entrypoint.'
    }
    [IO.File]::WriteAllText($backendStateMarker, 'after-update')
    $null = Update-CHGGateway `
        -InstallRoot $installRoot `
        -SourceRoot $updateSource `
        -Rollback `
        -SkipTask `
        -SkipAcl `
        -Offline
    $rolledBackState = Read-CHGJson $paths.InstallState 'rolled-back install state'
    if ($rolledBackState.activeVersionId -ne $first.ReleaseId) {
        throw 'Rollback did not reactivate the previous immutable release.'
    }
    if ([IO.File]::ReadAllText($paths.StableGateway) -like '*Test-only stable launcher discriminator*') {
        throw 'Rollback did not restore the previous stable management entrypoint.'
    }
    if ([IO.File]::ReadAllText($backendStateMarker) -ne 'before-update') {
        throw 'Rollback did not restore the pre-update backend state snapshot.'
    }
    $null = Update-CHGGateway `
        -InstallRoot $installRoot `
        -SourceRoot $updateSource `
        -Rollback `
        -SkipTask `
        -SkipAcl `
        -Offline
    $forwardState = Read-CHGJson $paths.InstallState 'forward rollback state'
    if ($forwardState.activeVersionId -ne $updatedReleaseId) {
        throw 'Reverse rollback did not reactivate the updated release.'
    }
    if ([IO.File]::ReadAllText($backendStateMarker) -ne 'after-update') {
        throw 'Reverse rollback did not restore the updated backend state.'
    }
    $null = Update-CHGGateway `
        -InstallRoot $installRoot `
        -SourceRoot $updateSource `
        -Rollback `
        -SkipTask `
        -SkipAcl `
        -Offline
    $rolledBackState = Read-CHGJson $paths.InstallState 'final rollback state'
    if ($rolledBackState.activeVersionId -ne $first.ReleaseId) {
        throw 'Final rollback did not return to the original release.'
    }
    if ([IO.File]::ReadAllText($backendStateMarker) -ne 'before-update') {
        throw 'Final rollback did not return to the original backend state.'
    }
    if (@(Get-ChildItem -LiteralPath $paths.Versions -Directory).Count -ne 2) {
        throw 'Update or rollback deleted an immutable release.'
    }

    $originalInstallText = [IO.File]::ReadAllText($paths.InstallState)
    $originalConfigText = [IO.File]::ReadAllText($paths.GatewayConfig)
    $fakeReleaseId = 'test-fake-backend-release'
    $fakeRelease = Join-Path $paths.Versions $fakeReleaseId
    $null = New-Item -ItemType Directory -Path $fakeRelease
    Copy-Item `
        -LiteralPath (Join-Path $repositoryRoot 'runtime') `
        -Destination (Join-Path $fakeRelease 'runtime') `
        -Recurse
    Copy-Item `
        -LiteralPath (Join-Path $repositoryRoot 'tests\fixtures\fake-backend.mjs') `
        -Destination (Join-Path $fakeRelease 'fake-backend.mjs')
    $lifecycleState = Read-CHGJson $paths.InstallState 'lifecycle install state'
    $lifecycleState.releases | Add-Member `
        -NotePropertyName $fakeReleaseId `
        -NotePropertyValue ([PSCustomObject]@{
            backendVersion = 'test'
            backendIntegrity = 'test'
            entrypoint = 'fake-backend.mjs'
            sourceFingerprint = 'test'
            installedAt = [DateTime]::UtcNow.ToString('o')
        })
    $lifecycleState.activeVersionId = $fakeReleaseId
    Write-CHGAtomicJson $paths.InstallState $lifecycleState
    $lifecycleConfig = Read-CHGJson $paths.GatewayConfig 'lifecycle gateway config'
    $lifecycleConfig.listen.port = Get-FreeTcpPort
    do {
        $lifecycleConfig.backend.port = Get-FreeTcpPort
    } while ($lifecycleConfig.backend.port -eq $lifecycleConfig.listen.port)
    Write-CHGAtomicJson $paths.GatewayConfig $lifecycleConfig
    [IO.File]::WriteAllText(
        (Join-Path $paths.BackendHome 'github_token'),
        "test-token`n"
    )
    try {
        $started = Start-CHGGateway `
            -InstallRoot $installRoot `
            -TimeoutSeconds 20 `
            -SkipTask
        if ($started.Status -ne 'ready') {
            throw 'PowerShell start command did not reach ready.'
        }
        $deep = Get-CHGGatewayHealth -InstallRoot $installRoot -Deep
        if ($deep.Status -ne 'healthy' -or $deep.ModelCount -ne 2) {
            throw 'PowerShell deep health did not validate the fake backend models.'
        }
        $status = Get-CHGGatewayStatus -InstallRoot $installRoot
        if ($status.Health -ne 'ready' -or $status.BackendVersion -ne 'test') {
            throw 'PowerShell status did not report the running fake backend.'
        }
        $authenticationFailed = $false
        try {
            $null = Invoke-CHGAuthenticate `
                -InstallRoot $installRoot `
                -TimeoutSeconds 60
        }
        catch {
            $authenticationFailed = $true
        }
        if (-not $authenticationFailed) {
            throw 'Fake authentication unexpectedly succeeded.'
        }
        $restored = Get-CHGGatewayHealth -InstallRoot $installRoot
        if ($restored.status -ne 'ready') {
            throw 'Authentication failure did not restore the prior running state.'
        }
    }
    finally {
        try {
            $null = Stop-CHGGateway -InstallRoot $installRoot -TimeoutSeconds 15
        }
        catch {
            Write-Warning "Test gateway stop failed: $($_.Exception.Message)"
        }
        Write-CHGAtomicText $paths.InstallState $originalInstallText
        Write-CHGAtomicText $paths.GatewayConfig $originalConfigText
        if (Test-Path -LiteralPath $fakeRelease) {
            Remove-Item -LiteralPath $fakeRelease -Recurse -Force
        }
    }
    if (Test-Path -LiteralPath $paths.RuntimeLock) {
        throw 'PowerShell stop command left the supervisor lock.'
    }

    $fixture = Join-Path $paths.State 'models-fixture.json'
    Write-CHGAtomicJson $fixture ([ordered]@{
        backendVersion = 'test'
        data = @(
            [ordered]@{ id = 'claude-sonnet-test'; object = 'model' },
            [ordered]@{ id = 'gpt-codex-test'; object = 'model' }
        )
    })
    $clientHome = Join-Path $installRoot 'test-client-home'
    $null = Invoke-CHGConfigureClients `
        -InstallRoot $installRoot `
        -Clients @('all') `
        -ClientHome $clientHome `
        -ModelsFile $fixture `
        -DryRun
    if (Test-Path -LiteralPath $clientHome) {
        throw 'Installed client configurator dry-run wrote client files.'
    }

    $sentinel = Join-Path $installRoot 'user-owned-sentinel.txt'
    [IO.File]::WriteAllText($sentinel, 'preserve me')
    $result = Uninstall-CHGGateway `
        -InstallRoot $installRoot `
        -KeepClientConfiguration
    if ($result.Status -ne 'uninstalled') {
        throw 'Uninstall did not report success.'
    }
    if (-not (Test-Path -LiteralPath $sentinel)) {
        throw 'Scoped uninstall deleted an unrelated file.'
    }
    if (Test-Path -LiteralPath $paths.Versions) {
        throw 'Scoped uninstall left the owned immutable versions.'
    }

    Write-Host 'PASS install, repair, update, rollback, lifecycle, client dry-run, and uninstall'
}
finally {
    if (Test-Path -LiteralPath $installRoot) {
        Remove-Item -LiteralPath $installRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $updateSource) {
        Remove-Item -LiteralPath $updateSource -Recurse -Force
    }
}
