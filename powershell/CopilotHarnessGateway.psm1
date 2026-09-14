Set-StrictMode -Version Latest

$script:GatewayName = 'CopilotHarnessGateway'
$script:BackendPackage = '@jeffreycao/copilot-api'
$script:EnvironmentVariable = 'COPILOT_HARNESS_GATEWAY_API_KEY'
$script:MarkerName = '.copilot-harness-gateway-root.json'

function Get-CHGInstallRoot {
    param([string]$InstallRoot)

    if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            throw 'LOCALAPPDATA is not available. Specify -InstallRoot.'
        }
        $InstallRoot = Join-Path $env:LOCALAPPDATA 'CopilotHarnessGateway'
    }
    return [IO.Path]::GetFullPath($InstallRoot)
}

function Get-CHGPaths {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)

    $root = Get-CHGInstallRoot $InstallRoot
    return [ordered]@{
        Root = $root
        Marker = Join-Path $root $script:MarkerName
        Versions = Join-Path $root 'versions'
        ConfigDirectory = Join-Path $root 'config'
        GatewayConfig = Join-Path $root 'config\gateway.json'
        SecretsDirectory = Join-Path $root 'secrets'
        Secrets = Join-Path $root 'secrets\secrets.json'
        State = Join-Path $root 'state'
        InstallState = Join-Path $root 'state\install.json'
        DesiredState = Join-Path $root 'state\desired-state.json'
        RuntimeState = Join-Path $root 'state\runtime.json'
        RuntimeLock = Join-Path $root 'state\runtime.lock'
        Models = Join-Path $root 'state\models.json'
        ClientOwnership = Join-Path $root 'state\client-ownership.json'
        Data = Join-Path $root 'data'
        BackendHome = Join-Path $root 'data\backend'
        Logs = Join-Path $root 'logs'
        Backups = Join-Path $root 'backups'
        Staging = Join-Path $root 'staging'
        StableGateway = Join-Path $root 'gateway.ps1'
        StableLauncher = Join-Path $root 'launcher.ps1'
    }
}

function Read-CHGJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is missing: $Path"
    }
    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
    catch {
        throw "Invalid JSON in $Description '$Path': $($_.Exception.Message)"
    }
}

function Write-CHGAtomicText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content
    )

    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) {
        $null = New-Item -ItemType Directory -Path $directory -Force
    }
    $temporary = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText(
            $temporary,
            $Content,
            [Text.UTF8Encoding]::new($false)
        )
        if (Test-Path -LiteralPath $Path) {
            $replacementBackup = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).replace-backup"
            try {
                [IO.File]::Replace($temporary, $Path, $replacementBackup, $true)
            }
            catch [PlatformNotSupportedException] {
                Move-Item -LiteralPath $temporary -Destination $Path -Force
            }
            finally {
                if (Test-Path -LiteralPath $replacementBackup) {
                    Remove-Item -LiteralPath $replacementBackup -Force -ErrorAction SilentlyContinue
                }
            }
        }
        else {
            Move-Item -LiteralPath $temporary -Destination $Path
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Write-CHGAtomicJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 100
    Write-CHGAtomicText -Path $Path -Content "$json`n"
}

function Write-CHGJsonIfChanged {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value,
        [string]$BackupDirectory
    )

    $content = "$($Value | ConvertTo-Json -Depth 100)`n"
    if (Test-Path -LiteralPath $Path) {
        $existing = [IO.File]::ReadAllText($Path)
        if ($existing -eq $content) {
            return $false
        }
        if (-not [string]::IsNullOrWhiteSpace($BackupDirectory)) {
            if (-not (Test-Path -LiteralPath $BackupDirectory)) {
                $null = New-Item -ItemType Directory -Path $BackupDirectory -Force
            }
            $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss.fffZ')
            $backup = Join-Path $BackupDirectory "$timestamp-$(Split-Path -Leaf $Path).bak"
            Copy-Item -LiteralPath $Path -Destination $backup
        }
    }
    Write-CHGAtomicText -Path $Path -Content $content
    return $true
}

function Copy-CHGAtomicFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $content = [IO.File]::ReadAllText($Source)
    Write-CHGAtomicText -Path $Destination -Content $content
}

function New-CHGSecret {
    param([int]$Bytes = 32)

    $buffer = New-Object byte[] $Bytes
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($buffer)
    }
    finally {
        $generator.Dispose()
    }
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-CHGSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-CHGReleaseFileHashes {
    param([Parameter(Mandatory = $true)][string]$ReleaseRoot)

    $relativeFiles = New-Object Collections.Generic.List[string]
    foreach ($fileName in @(
        'package.json',
        'package-lock.json',
        'gateway.ps1',
        'THIRD_PARTY_NOTICES.md'
    )) {
        if (Test-Path -LiteralPath (Join-Path $ReleaseRoot $fileName) -PathType Leaf) {
            $relativeFiles.Add($fileName)
        }
    }
    foreach ($directoryName in @(
        'runtime',
        'powershell',
        'licenses',
        'node_modules\@jeffreycao\copilot-api'
    )) {
        $directory = Join-Path $ReleaseRoot $directoryName
        if (Test-Path -LiteralPath $directory -PathType Container) {
            foreach ($file in Get-ChildItem -LiteralPath $directory -File -Recurse | Sort-Object FullName) {
                $relativeFiles.Add(
                    $file.FullName.Substring($ReleaseRoot.Length).TrimStart('\')
                )
            }
        }
    }
    $hashes = [ordered]@{}
    foreach ($relative in $relativeFiles | Sort-Object -Unique) {
        $hashes[$relative] = Get-CHGSha256 (Join-Path $ReleaseRoot $relative)
    }
    return $hashes
}

function Test-CHGReleaseFileHashes {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseRoot,
        [Parameter(Mandatory = $true)]$ExpectedHashes
    )

    if ($null -eq $ExpectedHashes) {
        return $false
    }
    foreach ($property in $ExpectedHashes.PSObject.Properties) {
        $file = Join-Path $ReleaseRoot $property.Name
        if (
            -not (Test-Path -LiteralPath $file -PathType Leaf) -or
            (Get-CHGSha256 $file) -ne [string]$property.Value
        ) {
            return $false
        }
    }
    return @($ExpectedHashes.PSObject.Properties).Count -gt 0
}

function Get-CHGSourceFingerprint {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$BackendVersion
    )

    $targets = @(
        (Join-Path $SourceRoot 'package.json'),
        (Join-Path $SourceRoot 'package-lock.json'),
        (Join-Path $SourceRoot 'gateway.ps1')
    )
    foreach ($directoryName in @('runtime', 'powershell')) {
        $directory = Join-Path $SourceRoot $directoryName
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            throw "Required source directory is missing: $directory"
        }
        $targets += Get-ChildItem -LiteralPath $directory -File -Recurse |
            Sort-Object FullName |
            ForEach-Object { $_.FullName }
    }

    $lines = New-Object Collections.Generic.List[string]
    $lines.Add("backend=$BackendVersion")
    foreach ($target in $targets) {
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            throw "Required source file is missing: $target"
        }
        $relative = $target.Substring([IO.Path]::GetFullPath($SourceRoot).Length).TrimStart('\')
        $lines.Add("$relative=$(Get-CHGSha256 $target)")
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
        return [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-CHGNode {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        $command = Get-Command node -ErrorAction SilentlyContinue
    }
    if ($null -eq $command) {
        throw 'Node.js 22.13 or newer is required and was not found on PATH.'
    }
    $versionText = (& $command.Source --version).Trim().TrimStart('v')
    $version = $null
    if (-not [Version]::TryParse($versionText.Split('-')[0], [ref]$version)) {
        throw "Unable to parse Node.js version '$versionText'."
    }
    if ($version -lt [Version]'22.13.0') {
        throw "Node.js 22.13 or newer is required; found $versionText."
    }
    return [ordered]@{
        Path = [IO.Path]::GetFullPath($command.Source)
        Version = $versionText
    }
}

function Get-CHGNpm {
    $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        $command = Get-Command npm -ErrorAction SilentlyContinue
    }
    if ($null -eq $command) {
        throw 'npm was not found on PATH.'
    }
    return $command.Source
}

function Initialize-CHGDirectories {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [switch]$SkipAcl
    )

    foreach ($directory in @(
        $Paths.Root,
        $Paths.Versions,
        $Paths.ConfigDirectory,
        $Paths.SecretsDirectory,
        $Paths.State,
        $Paths.Data,
        $Paths.BackendHome,
        $Paths.Logs,
        $Paths.Backups,
        $Paths.Staging
    )) {
        if (-not (Test-Path -LiteralPath $directory)) {
            $null = New-Item -ItemType Directory -Path $directory -Force
        }
    }

    if (-not $SkipAcl) {
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        try {
            $acl = [Security.AccessControl.DirectorySecurity]::new()
            $acl.SetAccessRuleProtection($true, $false)
            $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                [Security.AccessControl.InheritanceFlags]::ObjectInherit
            foreach ($identity in @($sid, 'S-1-5-18')) {
                $principal = [Security.Principal.SecurityIdentifier]::new($identity)
                $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                    $principal,
                    [Security.AccessControl.FileSystemRights]::FullControl,
                    $inheritance,
                    [Security.AccessControl.PropagationFlags]::None,
                    [Security.AccessControl.AccessControlType]::Allow
                )
                $null = $acl.AddAccessRule($rule)
            }
            Set-Acl -LiteralPath $Paths.Root -AclObject $acl
        }
        catch {
            throw "Unable to restrict the install directory ACL '$($Paths.Root)': $($_.Exception.Message)"
        }
    }
}

function Protect-CHGFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$SkipAcl
    )

    if ($SkipAcl) {
        return
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & "$env:SystemRoot\System32\icacls.exe" $Path '/inheritance:r' '/grant:r' "*${sid}:F" '*S-1-5-18:F' '/Q' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to restrict the file ACL: $Path"
    }
}

function Get-CHGDefaultConfiguration {
    return [ordered]@{
        schemaVersion = 1
        listen = [ordered]@{
            address = '127.0.0.1'
            port = 4141
        }
        backend = [ordered]@{
            address = '127.0.0.1'
            port = 4142
        }
        limits = [ordered]@{
            maxConcurrentRequests = 2
            requestsPerMinute = 20
            burst = 4
            requestTimeoutMs = 900000
        }
        supervision = [ordered]@{
            startupTimeoutMs = 60000
            initialRestartDelayMs = 1000
            maximumRestartDelayMs = 60000
            maximumRestarts = 8
            restartWindowMs = 900000
            stableResetMs = 600000
        }
        logging = [ordered]@{
            maximumFileBytes = 5242880
            retainedFiles = 5
            captureBackendOutput = $false
        }
        network = [ordered]@{
            proxyFromEnvironment = $false
        }
        models = [ordered]@{
            refreshTtlSeconds = 900
            aliases = [ordered]@{}
        }
    }
}

function Test-CHGConfiguration {
    param([Parameter(Mandatory = $true)]$Configuration)

    if ($Configuration.schemaVersion -ne 1) {
        throw "Unsupported gateway configuration schema '$($Configuration.schemaVersion)'."
    }
    if ($Configuration.listen.address -ne '127.0.0.1') {
        throw 'The public listener must be 127.0.0.1.'
    }
    if ($Configuration.backend.address -ne '127.0.0.1') {
        throw 'The backend listener must be 127.0.0.1.'
    }
    foreach ($entry in @(
        @{ Name = 'listen.port'; Value = $Configuration.listen.port },
        @{ Name = 'backend.port'; Value = $Configuration.backend.port }
    )) {
        $port = [int]$entry.Value
        if ($port -lt 1024 -or $port -gt 65535) {
            throw "$($entry.Name) must be from 1024 through 65535."
        }
    }
    if ($Configuration.listen.port -eq $Configuration.backend.port) {
        throw 'listen.port and backend.port must differ.'
    }
}

function Initialize-CHGConfiguration {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [switch]$SkipAcl
    )

    if (Test-Path -LiteralPath $Paths.GatewayConfig) {
        $configuration = Read-CHGJson $Paths.GatewayConfig 'gateway configuration'
        Test-CHGConfiguration $configuration
    }
    else {
        $configuration = Get-CHGDefaultConfiguration
        Write-CHGAtomicJson $Paths.GatewayConfig $configuration
    }

    if (Test-Path -LiteralPath $Paths.Secrets) {
        $secrets = Read-CHGJson $Paths.Secrets 'gateway secrets'
        foreach ($name in @('clientApiKey', 'internalApiKey', 'adminApiKey')) {
            $property = $secrets.PSObject.Properties[$name]
            if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value) -or ([string]$property.Value).Length -lt 32) {
                throw "Gateway secrets file has an invalid $name."
            }
        }
    }
    else {
        $secrets = [ordered]@{
            schemaVersion = 1
            clientApiKey = New-CHGSecret
            internalApiKey = New-CHGSecret
            adminApiKey = New-CHGSecret
            createdAt = [DateTime]::UtcNow.ToString('o')
        }
        Write-CHGAtomicJson $Paths.Secrets $secrets
    }
    Protect-CHGFile $Paths.Secrets -SkipAcl:$SkipAcl

    Initialize-CHGBackendConfiguration -Paths $Paths -Secrets $secrets -SkipAcl:$SkipAcl
    return [ordered]@{
        Configuration = $configuration
        Secrets = $secrets
    }
}

function Initialize-CHGBackendConfiguration {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)]$Secrets,
        [switch]$SkipAcl
    )

    $path = Join-Path $Paths.BackendHome 'config.json'
    if (Test-Path -LiteralPath $path) {
        try {
            $config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
        }
        catch {
            throw "Upstream configuration is invalid JSON: $path"
        }
    }
    else {
        $config = [PSCustomObject]@{}
    }

    if ($null -eq $config.PSObject.Properties['auth']) {
        $config | Add-Member -NotePropertyName auth -NotePropertyValue ([PSCustomObject]@{})
    }
    $keys = New-Object Collections.Generic.List[string]
    $existingKeys = $config.auth.PSObject.Properties['apiKeys']
    if ($null -ne $existingKeys) {
        foreach ($key in @($existingKeys.Value)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$key) -and -not $keys.Contains([string]$key)) {
                $keys.Add([string]$key)
            }
        }
    }
    if (-not $keys.Contains([string]$Secrets.internalApiKey)) {
        $keys.Add([string]$Secrets.internalApiKey)
    }
    if ($null -eq $config.auth.PSObject.Properties['apiKeys']) {
        $config.auth | Add-Member -NotePropertyName apiKeys -NotePropertyValue $keys.ToArray()
    }
    else {
        $config.auth.apiKeys = $keys.ToArray()
    }
    if ($null -eq $config.auth.PSObject.Properties['adminApiKey']) {
        $config.auth | Add-Member -NotePropertyName adminApiKey -NotePropertyValue ([string]$Secrets.adminApiKey)
    }
    else {
        $config.auth.adminApiKey = [string]$Secrets.adminApiKey
    }
    $null = Write-CHGJsonIfChanged `
        -Path $path `
        -Value $config `
        -BackupDirectory (Join-Path $Paths.Backups 'backend')
    Protect-CHGFile $path -SkipAcl:$SkipAcl
}

function Get-CHGPackageEntry {
    param(
        [Parameter(Mandatory = $true)]$Lock,
        [Parameter(Mandatory = $true)][string]$PackagePath
    )

    $property = $Lock.packages.PSObject.Properties[$PackagePath]
    if ($null -eq $property) {
        throw "Package lock does not contain '$PackagePath'."
    }
    return $property.Value
}

function Read-CHGPackageLock {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Package lock is missing: $Path"
    }
    $raw = [IO.File]::ReadAllText($Path)
    # PowerShell's JSON converter rejects npm's intentional empty root-package key.
    $normalized = [Text.RegularExpressions.Regex]::Replace(
        $raw,
        '("packages"\s*:\s*\{)\s*""\s*:',
        '$1 "__root__":',
        [Text.RegularExpressions.RegexOptions]::None,
        [TimeSpan]::FromSeconds(1)
    )
    try {
        return $normalized | ConvertFrom-Json
    }
    catch {
        throw "Invalid JSON in package lock '$Path': $($_.Exception.Message)"
    }
}

function Invoke-CHGNpm {
    param(
        [Parameter(Mandatory = $true)][string]$Npm,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Push-Location $WorkingDirectory
    try {
        & $Npm @Arguments | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "npm failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

function Install-CHGImmutableRelease {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$BackendVersion,
        [string]$ExpectedIntegrity,
        [switch]$Offline
    )

    if ($BackendVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
        throw "Backend version must be an exact semver, not a tag or range: $BackendVersion"
    }
    $packagePath = Join-Path $SourceRoot 'package.json'
    $lockPath = Join-Path $SourceRoot 'package-lock.json'
    if (-not (Test-Path -LiteralPath $packagePath) -or -not (Test-Path -LiteralPath $lockPath)) {
        throw 'package.json and package-lock.json are required in the source root.'
    }
    $sourcePackage = Read-CHGJson $packagePath 'source package manifest'
    $projectVersion = [string]$sourcePackage.version
    $fingerprint = Get-CHGSourceFingerprint -SourceRoot $SourceRoot -BackendVersion $BackendVersion
    $releaseId = "gateway-$projectVersion-backend-$BackendVersion-$($fingerprint.Substring(0, 12))"
    $target = Join-Path $Paths.Versions $releaseId
    if (Test-Path -LiteralPath $target -PathType Container) {
        $verified = $false
        try {
            $manifest = Read-CHGJson (Join-Path $target 'release.json') 'release manifest'
            $verified = (
                $manifest.backendVersion -eq $BackendVersion -and
                $manifest.sourceFingerprint -eq $fingerprint -and
                (Test-CHGReleaseFileHashes `
                    -ReleaseRoot $target `
                    -ExpectedHashes $manifest.fileHashes)
            )
        }
        catch {
            $verified = $false
        }
        if ($verified) {
            return [ordered]@{
                Id = $releaseId
                Path = $target
                Manifest = $manifest
            }
        }

        if (Test-Path -LiteralPath $Paths.RuntimeLock) {
            throw "Immutable release '$releaseId' is modified while the gateway may be running. Stop it before repair."
        }
        $quarantine = Join-Path $Paths.Backups (
            'corrupt-releases\{0}-{1}-{2}' -f
                $releaseId,
                [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss.fffZ'),
                [Guid]::NewGuid().ToString('N')
        )
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $quarantine) -Force
        Move-Item -LiteralPath $target -Destination $quarantine
    }

    $staging = Join-Path $Paths.Staging "$releaseId.$([Guid]::NewGuid().ToString('N'))"
    $null = New-Item -ItemType Directory -Path $staging
    try {
        Copy-Item -LiteralPath $packagePath -Destination (Join-Path $staging 'package.json')
        $lockedSourceVersion = [string]$sourcePackage.dependencies.PSObject.Properties[$script:BackendPackage].Value
        if ($lockedSourceVersion -ne $BackendVersion) {
            throw "The source bundle pins backend '$lockedSourceVersion', not requested '$BackendVersion'. Obtain a reviewed checkout with a committed lock for the requested version."
        }
        Copy-Item -LiteralPath $lockPath -Destination (Join-Path $staging 'package-lock.json')

        $lock = Read-CHGPackageLock (Join-Path $staging 'package-lock.json')
        $backendEntry = Get-CHGPackageEntry $lock "node_modules/$($script:BackendPackage)"
        if ($backendEntry.version -ne $BackendVersion) {
            throw "Staged lock resolved backend $($backendEntry.version), expected $BackendVersion."
        }
        if (-not [string]::IsNullOrWhiteSpace($ExpectedIntegrity) -and $backendEntry.integrity -ne $ExpectedIntegrity) {
            throw 'The backend package integrity does not match -ExpectedIntegrity.'
        }

        $npm = Get-CHGNpm
        $installArguments = @(
            'ci',
            '--omit=dev',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--fetch-retries=2',
            '--fetch-retry-mintimeout=1000',
            '--fetch-retry-maxtimeout=10000',
            '--fetch-timeout=60000'
        )
        if ($Offline) { $installArguments += '--offline' }
        Invoke-CHGNpm -Npm $npm -WorkingDirectory $staging -Arguments $installArguments

        $installedPackagePath = Join-Path $staging 'node_modules\@jeffreycao\copilot-api\package.json'
        $installedPackage = Read-CHGJson $installedPackagePath 'installed backend package'
        if ($installedPackage.version -ne $BackendVersion) {
            throw "Installed backend version '$($installedPackage.version)' is not '$BackendVersion'."
        }
        $entrypoint = 'node_modules\@jeffreycao\copilot-api\dist\main.js'
        if (-not (Test-Path -LiteralPath (Join-Path $staging $entrypoint) -PathType Leaf)) {
            throw 'The pinned backend entrypoint is missing after npm ci.'
        }

        foreach ($directoryName in @('runtime', 'powershell')) {
            Copy-Item -LiteralPath (Join-Path $SourceRoot $directoryName) -Destination (Join-Path $staging $directoryName) -Recurse
        }
        foreach ($fileName in @('gateway.ps1', 'THIRD_PARTY_NOTICES.md')) {
            $sourceFile = Join-Path $SourceRoot $fileName
            if (Test-Path -LiteralPath $sourceFile) {
                Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $staging $fileName)
            }
        }
        $licenseDirectory = Join-Path $SourceRoot 'licenses'
        if (Test-Path -LiteralPath $licenseDirectory) {
            Copy-Item -LiteralPath $licenseDirectory -Destination (Join-Path $staging 'licenses') -Recurse
        }

        $shasumProperty = $backendEntry.PSObject.Properties['shasum']
        $manifest = [ordered]@{
            schemaVersion = 1
            releaseId = $releaseId
            gatewayVersion = $projectVersion
            backendPackage = $script:BackendPackage
            backendVersion = $BackendVersion
            backendIntegrity = [string]$backendEntry.integrity
            backendShasum = if ($null -eq $shasumProperty) { $null } else { [string]$shasumProperty.Value }
            entrypoint = $entrypoint
            sourceFingerprint = $fingerprint
            packageLockSha256 = Get-CHGSha256 (Join-Path $staging 'package-lock.json')
            installedAt = [DateTime]::UtcNow.ToString('o')
        }
        $manifest.fileHashes = Get-CHGReleaseFileHashes -ReleaseRoot $staging
        Write-CHGAtomicJson (Join-Path $staging 'release.json') $manifest
        Move-Item -LiteralPath $staging -Destination $target
        return [ordered]@{
            Id = $releaseId
            Path = $target
            Manifest = $manifest
        }
    }
    catch {
        if (Test-Path -LiteralPath $staging) {
            Remove-Item -LiteralPath $staging -Recurse -Force
        }
        throw
    }
}

function ConvertTo-CHGReleaseMap {
    param($InstallState)

    $map = [ordered]@{}
    if ($null -ne $InstallState -and $null -ne $InstallState.PSObject.Properties['releases']) {
        foreach ($property in $InstallState.releases.PSObject.Properties) {
            $map[$property.Name] = $property.Value
        }
    }
    return $map
}

function Set-CHGActiveRelease {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)]$Node,
        [Parameter(Mandatory = $true)]$Release
    )

    $existing = $null
    if (Test-Path -LiteralPath $Paths.InstallState) {
        $existing = Read-CHGJson $Paths.InstallState 'install state'
    }
    $releaseMap = ConvertTo-CHGReleaseMap $existing
    $releaseMap[$Release.Id] = [ordered]@{
        backendVersion = [string]$Release.Manifest.backendVersion
        backendIntegrity = [string]$Release.Manifest.backendIntegrity
        entrypoint = [string]$Release.Manifest.entrypoint
        sourceFingerprint = [string]$Release.Manifest.sourceFingerprint
        installedAt = [string]$Release.Manifest.installedAt
    }
    $previous = $null
    if ($null -ne $existing -and $existing.activeVersionId -ne $Release.Id) {
        $previous = [string]$existing.activeVersionId
    }
    elseif ($null -ne $existing -and $null -ne $existing.PSObject.Properties['previousVersionId']) {
        $previous = [string]$existing.previousVersionId
    }
    $state = [ordered]@{
        schemaVersion = 1
        activeVersionId = $Release.Id
        previousVersionId = $previous
        nodePath = $Node.Path
        nodeVersion = $Node.Version
        backendPackage = $script:BackendPackage
        releases = $releaseMap
        updatedAt = [DateTime]::UtcNow.ToString('o')
    }
    Write-CHGAtomicJson $Paths.InstallState $state
    return $state
}

function Get-CHGTaskName {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $bytes = [Text.Encoding]::UTF8.GetBytes($sid)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
    return "$($script:GatewayName)-$($hash.Substring(0, 10))"
}

function New-CHGScheduledTaskDefinition {
    param(
        [Parameter(Mandatory = $true)]$Paths
    )

    Import-Module ScheduledTasks -ErrorAction Stop
    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -InstallRoot "{1}"' -f $Paths.StableLauncher, $Paths.Root
    $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $Paths.Root
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()

    # Two triggers. The logon trigger starts the gateway at sign-in. The
    # repeating trigger is a watchdog: a supervisor that died mid-session would
    # otherwise stay dead until the next sign-in. Repetition attached to a
    # logon trigger does not reliably schedule future runs, so the watchdog is
    # a separate trigger. While the gateway is healthy the extra run is
    # discarded by MultipleInstances IgnoreNew, so this costs nothing.
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $watchdogTrigger = New-ScheduledTaskTrigger `
        -Once `
        -At (Get-Date).AddMinutes(5) `
        -RepetitionInterval (New-TimeSpan -Minutes 5)
    $trigger = @($logonTrigger, $watchdogTrigger)

    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -StartWhenAvailable `
        -Hidden `
        -DontStopIfGoingOnBatteries `
        -AllowStartIfOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    return [ordered]@{
        Action = $action
        Trigger = $trigger
        Principal = $principal
        Settings = $settings
    }
}

function Register-CHGScheduledTask {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [switch]$SkipTask
    )

    if ($SkipTask) {
        return
    }
    $definition = New-CHGScheduledTaskDefinition -Paths $Paths
    Register-ScheduledTask `
        -TaskName (Get-CHGTaskName) `
        -Action $definition.Action `
        -Trigger $definition.Trigger `
        -Principal $definition.Principal `
        -Settings $definition.Settings `
        -Description 'Loopback-only GitHub Copilot compatibility gateway.' `
        -Force | Out-Null
}

function Install-CHGGateway {
    [CmdletBinding()]
    param(
        [string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [string]$BackendVersion,
        [string]$ExpectedIntegrity,
        [switch]$SkipTask,
        [switch]$SkipAcl,
        [switch]$Offline,
        [switch]$DryRun
    )

    $root = Get-CHGInstallRoot $InstallRoot
    $paths = Get-CHGPaths $root
    $sourcePackage = Read-CHGJson (Join-Path $SourceRoot 'package.json') 'source package manifest'
    if ([string]::IsNullOrWhiteSpace($BackendVersion)) {
        $property = $sourcePackage.dependencies.PSObject.Properties[$script:BackendPackage]
        if ($null -eq $property) {
            throw "Source manifest does not pin $($script:BackendPackage)."
        }
        $BackendVersion = [string]$property.Value
    }
    if ($BackendVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
        throw "Backend version must be exact: $BackendVersion"
    }
    $sourcePin = [string]$sourcePackage.dependencies.PSObject.Properties[$script:BackendPackage].Value
    if ($BackendVersion -ne $sourcePin) {
        throw "The source bundle pins backend '$sourcePin', not requested '$BackendVersion'."
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedIntegrity) -and $ExpectedIntegrity -notmatch '^sha512-[A-Za-z0-9+/]+={0,2}$') {
        throw '-ExpectedIntegrity must be a canonical npm sha512 SRI value.'
    }
    $node = Get-CHGNode

    if ($DryRun) {
        return [PSCustomObject]@{
            Action = 'install'
            InstallRoot = $root
            BackendPackage = $script:BackendPackage
            BackendVersion = $BackendVersion
            NodePath = $node.Path
            ScheduledTask = -not $SkipTask
            WritesPerformed = $false
        }
    }

    if (
        (Test-Path -LiteralPath $paths.Root -PathType Container) -and
        -not (Test-Path -LiteralPath $paths.Marker) -and
        (Get-ChildItem -LiteralPath $paths.Root -Force | Measure-Object).Count -gt 0
    ) {
        throw "Refusing to claim a non-empty directory without an ownership marker: $($paths.Root)"
    }
    Initialize-CHGDirectories -Paths $paths -SkipAcl:$SkipAcl
    if (-not (Test-Path -LiteralPath $paths.Marker)) {
        Write-CHGAtomicJson $paths.Marker ([ordered]@{
            schemaVersion = 1
            product = $script:GatewayName
            installationId = [Guid]::NewGuid().ToString()
            createdAt = [DateTime]::UtcNow.ToString('o')
        })
    }
    $marker = Read-CHGJson $paths.Marker 'install-root marker'
    if ($marker.product -ne $script:GatewayName) {
        throw "Install root is owned by another product: $root"
    }

    $null = Initialize-CHGConfiguration -Paths $paths -SkipAcl:$SkipAcl
    $release = Install-CHGImmutableRelease `
        -Paths $paths `
        -SourceRoot $SourceRoot `
        -BackendVersion $BackendVersion `
        -ExpectedIntegrity $ExpectedIntegrity `
        -Offline:$Offline
    $null = Set-CHGActiveRelease -Paths $paths -Node $node -Release $release
    Copy-CHGAtomicFile (Join-Path $SourceRoot 'gateway.ps1') $paths.StableGateway
    Copy-CHGAtomicFile (Join-Path $SourceRoot 'powershell\launcher.ps1') $paths.StableLauncher
    if (-not (Test-Path -LiteralPath $paths.DesiredState)) {
        Write-CHGAtomicJson $paths.DesiredState ([ordered]@{
            schemaVersion = 1
            state = 'stopped'
            updatedAt = [DateTime]::UtcNow.ToString('o')
        })
    }
    Register-CHGScheduledTask -Paths $paths -SkipTask:$SkipTask

    return [PSCustomObject]@{
        Action = 'install'
        InstallRoot = $root
        ReleaseId = $release.Id
        BackendVersion = $BackendVersion
        NodeVersion = $node.Version
        TaskName = if ($SkipTask) { $null } else { Get-CHGTaskName }
        NextStep = "& `"$($paths.StableGateway)`" authenticate"
    }
}

function Get-CHGInstalledContext {
    param([string]$InstallRoot)

    $paths = Get-CHGPaths (Get-CHGInstallRoot $InstallRoot)
    $marker = Read-CHGJson $paths.Marker 'install-root marker'
    if ($marker.product -ne $script:GatewayName) {
        throw "Refusing an install root not owned by $($script:GatewayName)."
    }
    $install = Read-CHGJson $paths.InstallState 'install state'
    $releaseProperty = $install.releases.PSObject.Properties[$install.activeVersionId]
    if ($null -eq $releaseProperty) {
        throw "Active release '$($install.activeVersionId)' is missing."
    }
    $releasePath = Join-Path $paths.Versions $install.activeVersionId
    return [ordered]@{
        Paths = $paths
        Install = $install
        Release = $releaseProperty.Value
        ReleasePath = $releasePath
        Entrypoint = Join-Path $releasePath ([string]$releaseProperty.Value.entrypoint)
        Configuration = Read-CHGJson $paths.GatewayConfig 'gateway configuration'
        Secrets = Read-CHGJson $paths.Secrets 'gateway secrets'
    }
}

function Set-CHGDesiredState {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)][ValidateSet('running', 'stopped')][string]$State
    )

    Write-CHGAtomicJson $Paths.DesiredState ([ordered]@{
        schemaVersion = 1
        state = $State
        updatedAt = [DateTime]::UtcNow.ToString('o')
    })
}

function Invoke-CHGLoopbackRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [hashtable]$Headers = @{},
        [int]$TimeoutSeconds = 5
    )

    $timeoutMilliseconds = [int]([long]$TimeoutSeconds * [long]1000)
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $request = [Net.WebRequest]::Create($Uri)
    $request.Method = 'GET'
    $request.Timeout = $timeoutMilliseconds
    $request.ReadWriteTimeout = $timeoutMilliseconds
    $request.Proxy = $null
    foreach ($name in $Headers.Keys) {
        $request.Headers[[string]$name] = [string]$Headers[$name]
    }

    $response = $null
    try {
        $response = $request.GetResponse()
    }
    catch [Net.WebException] {
        # A 4xx/5xx status is a meaningful gateway state, not a transport failure.
        if ($null -eq $_.Exception.Response) {
            throw
        }
        $response = $_.Exception.Response
    }

    try {
        $statusCode = [int]$response.StatusCode
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try {
            $remainingMilliseconds = [long]$timeoutMilliseconds - $stopwatch.ElapsedMilliseconds
            if ($remainingMilliseconds -le 0) {
                $request.Abort()
                throw [TimeoutException]::new(
                    "Loopback request timed out after $TimeoutSeconds seconds."
                )
            }

            $readTask = $reader.ReadToEndAsync()
            if (-not ([IAsyncResult]$readTask).AsyncWaitHandle.WaitOne(
                [int]$remainingMilliseconds
            )) {
                $request.Abort()
                throw [TimeoutException]::new(
                    "Loopback request timed out after $TimeoutSeconds seconds."
                )
            }
            $text = $readTask.GetAwaiter().GetResult()
        }
        finally {
            $reader.Dispose()
        }
    }
    finally {
        $response.Dispose()
    }

    $body = $null
    if (-not [string]::IsNullOrWhiteSpace($text)) {
        try {
            $body = $text | ConvertFrom-Json
        }
        catch {
            $body = $text
        }
    }
    return [ordered]@{
        StatusCode = $statusCode
        Body = $body
    }
}

function Invoke-CHGHealthRequest {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [switch]$Deep,
        [int]$TimeoutSeconds = 5
    )

    $base = "http://127.0.0.1:$($Context.Configuration.listen.port)"
    if ($Deep) {
        $result = Invoke-CHGLoopbackRequest `
            -Uri "$base/v1/models" `
            -Headers @{ 'x-api-key' = [string]$Context.Secrets.clientApiKey } `
            -TimeoutSeconds $TimeoutSeconds
        if ($result.StatusCode -ne 200) {
            throw "Authenticated model probe returned HTTP $($result.StatusCode)."
        }
        return $result.Body
    }

    $result = Invoke-CHGLoopbackRequest `
        -Uri "$base/_gateway/health" `
        -TimeoutSeconds $TimeoutSeconds
    if ($null -eq $result.Body -or $null -eq $result.Body.status) {
        throw "Health endpoint returned HTTP $($result.StatusCode) without a status."
    }
    return $result.Body
}

function Wait-CHGHealth {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [int]$TimeoutSeconds = 60
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastError = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $health = Invoke-CHGHealthRequest -Context $Context -TimeoutSeconds 3
            if ($health.status -eq 'ready') {
                return $health
            }
            if ($health.status -like 'blocked-*') {
                throw "Gateway is $($health.status)."
            }
        }
        catch {
            $lastError = $_.Exception.Message
            if (Test-Path -LiteralPath $Context.Paths.RuntimeState) {
                try {
                    $runtime = Read-CHGJson $Context.Paths.RuntimeState 'runtime state'
                    if ([string]$runtime.status -like 'blocked-*') {
                        throw "Gateway is $($runtime.status): $($runtime.lastError)"
                    }
                }
                catch {
                    if ($_.Exception.Message -like 'Gateway is blocked-*') {
                        throw
                    }
                }
            }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Gateway did not become healthy within $TimeoutSeconds seconds. Last error: $lastError"
}

function Start-CHGGateway {
    [CmdletBinding()]
    param(
        [string]$InstallRoot,
        [ValidateRange(5, 300)]
        [int]$TimeoutSeconds = 60,
        [switch]$SkipTask
    )

    $context = Get-CHGInstalledContext $InstallRoot
    Set-CHGDesiredState -Paths $context.Paths -State running
    $task = $null
    if (-not $SkipTask) {
        $task = Get-ScheduledTask -TaskName (Get-CHGTaskName) -ErrorAction SilentlyContinue
    }
    if ($null -ne $task) {
        Start-ScheduledTask -TaskName (Get-CHGTaskName)
    }
    else {
        $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -InstallRoot "{1}"' -f $context.Paths.StableLauncher, $context.Paths.Root
        Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden | Out-Null
    }
    $health = Wait-CHGHealth -Context $context -TimeoutSeconds $TimeoutSeconds
    return [PSCustomObject]@{
        Status = $health.status
        Endpoint = "http://127.0.0.1:$($context.Configuration.listen.port)"
        ReleaseId = $context.Install.activeVersionId
    }
}

function Test-CHGProcessOwnership {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedFragment
    )

    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        if ($null -eq $process -or [string]::IsNullOrWhiteSpace([string]$process.CommandLine)) {
            return $false
        }
        return (
            ([string]$process.CommandLine).IndexOf($InstallRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            ([string]$process.CommandLine).IndexOf($ExpectedFragment, [StringComparison]::OrdinalIgnoreCase) -ge 0
        )
    }
    catch {
        return $false
    }
}

function Stop-CHGOwnedProcesses {
    param([Parameter(Mandatory = $true)]$Context)

    if (-not (Test-Path -LiteralPath $Context.Paths.RuntimeState)) {
        return
    }
    try {
        $runtime = Read-CHGJson $Context.Paths.RuntimeState 'runtime state'
    }
    catch {
        return
    }
    $candidates = @(
        @{
            ProcessId = [int]$runtime.supervisorPid
            Fragment = 'supervisor.mjs'
        },
        @{
            ProcessId = [int]$runtime.backendPid
            Fragment = [IO.Path]::GetFileName([string]$Context.Entrypoint)
        }
    )
    foreach ($candidate in $candidates) {
        if ($candidate.ProcessId -le 0) {
            continue
        }
        if (Test-CHGProcessOwnership `
                -ProcessId $candidate.ProcessId `
                -InstallRoot $Context.Paths.Root `
                -ExpectedFragment $candidate.Fragment) {
            Stop-Process -Id $candidate.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 250
    if (Test-Path -LiteralPath $Context.Paths.RuntimeLock) {
        try {
            $lock = Read-CHGJson $Context.Paths.RuntimeLock 'runtime lock'
            if ($null -eq (Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue)) {
                Remove-Item -LiteralPath $Context.Paths.RuntimeLock -Force
            }
        }
        catch {
            # An unreadable lock is preserved for explicit diagnosis.
        }
    }
}

function Stop-CHGGateway {
    [CmdletBinding()]
    param(
        [string]$InstallRoot,
        [ValidateRange(1, 120)]
        [int]$TimeoutSeconds = 15,
        [switch]$KeepDesiredState
    )

    $context = Get-CHGInstalledContext $InstallRoot
    if (-not $KeepDesiredState) {
        Set-CHGDesiredState -Paths $context.Paths -State stopped
    }
    try {
        Invoke-RestMethod `
            -Uri "http://127.0.0.1:$($context.Configuration.listen.port)/_gateway/shutdown" `
            -Method Post `
            -Headers @{ 'x-gateway-admin' = [string]$context.Secrets.adminApiKey } `
            -TimeoutSec 3 | Out-Null
    }
    catch {
        # Task Scheduler is the bounded fallback when the control endpoint is absent.
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Test-Path -LiteralPath $context.Paths.RuntimeLock)) {
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (Test-Path -LiteralPath $context.Paths.RuntimeLock) {
        $task = Get-ScheduledTask -TaskName (Get-CHGTaskName) -ErrorAction SilentlyContinue
        if ($null -ne $task) {
            Stop-ScheduledTask -TaskName (Get-CHGTaskName) -ErrorAction SilentlyContinue
        }
    }
    Stop-CHGOwnedProcesses -Context $context
    if (Test-Path -LiteralPath $context.Paths.RuntimeLock) {
        throw 'Gateway processes did not stop cleanly; the runtime lock remains.'
    }
    return [PSCustomObject]@{ Status = 'stopped' }
}

function Restart-CHGGateway {
    [CmdletBinding()]
    param(
        [string]$InstallRoot,
        [ValidateRange(5, 300)]
        [int]$TimeoutSeconds = 60
    )

    $null = Stop-CHGGateway -InstallRoot $InstallRoot
    return Start-CHGGateway -InstallRoot $InstallRoot -TimeoutSeconds $TimeoutSeconds
}

function ConvertTo-CHGWindowsCommandLineArgument {
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [AllowEmptyString()]
        [object]$Argument
    )

    if ($null -eq $Argument) {
        throw 'A process argument cannot be null.'
    }
    if ($Argument -isnot [string]) {
        throw 'A process argument must be a string.'
    }
    if ($Argument.IndexOf([char]0) -ge 0) {
        throw 'A Windows process argument cannot contain NUL.'
    }

    $builder = New-Object Text.StringBuilder
    [void]$builder.Append([char]0x22)
    $backslashes = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq [char]0x5c) {
            $backslashes++
            continue
        }
        if ($character -eq [char]0x22) {
            # Quotes preceded by n backslashes require 2n+1 backslashes.
            [void]$builder.Append([char]0x5c, (2 * $backslashes + 1))
            [void]$builder.Append([char]0x22)
        }
        else {
            if ($backslashes -gt 0) {
                [void]$builder.Append([char]0x5c, $backslashes)
            }
            [void]$builder.Append($character)
        }
        $backslashes = 0
    }

    # Backslashes before the closing quote must be doubled.
    if ($backslashes -gt 0) {
        [void]$builder.Append([char]0x5c, (2 * $backslashes))
    }
    [void]$builder.Append([char]0x22)
    return $builder.ToString()
}

function Set-CHGProcessArguments {
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.ProcessStartInfo]$StartInfo,
        [Parameter(Mandatory = $true)]
        [object[]]$ArgumentList
    )

    foreach ($argument in $ArgumentList) {
        if ($null -eq $argument -or $argument -isnot [string]) {
            throw 'Every process argument must be a non-null string.'
        }
        if ($argument.IndexOf([char]0) -ge 0) {
            throw 'A Windows process argument cannot contain NUL.'
        }
    }

    if ($null -ne $StartInfo.PSObject.Properties['ArgumentList']) {
        foreach ($argument in $ArgumentList) {
            [void]$StartInfo.ArgumentList.Add([string]$argument)
        }
        return
    }

    $StartInfo.Arguments = @(
        foreach ($argument in $ArgumentList) {
            ConvertTo-CHGWindowsCommandLineArgument $argument
        }
    ) -join ' '
}

function Invoke-CHGForegroundProcess {
    [OutputType([void])]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][object[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][hashtable]$EnvironmentVariables,
        [Parameter(Mandatory = $true)]
        [ValidateRange(1, 3600)][int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)][string]$Operation
    )

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    $startInfo.ErrorDialog = $false
    $startInfo.RedirectStandardInput = $false
    $startInfo.RedirectStandardOutput = $false
    $startInfo.RedirectStandardError = $false
    Set-CHGProcessArguments -StartInfo $startInfo -ArgumentList $ArgumentList

    foreach ($name in $EnvironmentVariables.Keys) {
        $startInfo.EnvironmentVariables[[string]$name] = [string]$EnvironmentVariables[$name]
    }

    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    $started = $false
    $primaryError = $null
    $cleanupFailures = @()
    try {
        try {
            $started = $process.Start()
            if (-not $started) {
                throw "$Operation process could not be started."
            }

            $timeoutMilliseconds = [int]([long]$TimeoutSeconds * [long]1000)
            if (-not $process.WaitForExit($timeoutMilliseconds)) {
                throw [TimeoutException]::new(
                    "$Operation timed out after $TimeoutSeconds seconds."
                )
            }

            [void]$process.WaitForExit()
            $exitCode = $process.ExitCode
            if ($exitCode -ne 0) {
                throw [InvalidOperationException]::new(
                    "$Operation failed with exit code $exitCode."
                )
            }
        }
        catch {
            $primaryError = $_
        }
    }
    finally {
        $associated = $started
        if (-not $associated) {
            try {
                $unused = $process.Id
                $associated = $true
            }
            catch {
                $associated = $false
            }
        }

        if ($associated) {
            $hasExited = $false
            try {
                $hasExited = $process.HasExited
            }
            catch {
                $cleanupFailures += $_.Exception.Message
            }

            if (-not $hasExited) {
                try {
                    $process.Kill()
                }
                catch [InvalidOperationException] {
                    # The child exited between HasExited and Kill.
                }
                catch {
                    $cleanupFailures += $_.Exception.Message
                }
            }

            try {
                if ($process.WaitForExit(5000)) {
                    [void]$process.WaitForExit()
                }
                else {
                    $cleanupFailures += "$Operation child did not exit within 5 seconds of termination."
                }
            }
            catch {
                $cleanupFailures += $_.Exception.Message
            }
        }

        try {
            $process.Dispose()
        }
        catch {
            $cleanupFailures += $_.Exception.Message
        }
    }

    if ($cleanupFailures.Count -gt 0) {
        $cleanupText = $cleanupFailures -join ' | '
        if ($null -ne $primaryError) {
            throw [InvalidOperationException]::new(
                "$($primaryError.Exception.Message) Child-process cleanup also failed: $cleanupText",
                $primaryError.Exception
            )
        }
        throw "$Operation child-process cleanup failed: $cleanupText"
    }
    if ($null -ne $primaryError) {
        throw $primaryError
    }
}

function Invoke-CHGAuthenticate {
    [CmdletBinding()]
    param(
        [string]$InstallRoot,
        [ValidateRange(60, 3600)]
        [int]$TimeoutSeconds = 900
    )

    $context = Get-CHGInstalledContext $InstallRoot
    $desiredWasRunning = $false
    if (Test-Path -LiteralPath $context.Paths.DesiredState) {
        $desiredWasRunning = (Read-CHGJson $context.Paths.DesiredState 'desired state').state -eq 'running'
    }
    $null = Stop-CHGGateway -InstallRoot $InstallRoot

    $authenticationFailure = $null
    try {
        Write-Host ''
        Write-Host 'Starting GitHub device sign-in.' -ForegroundColor Cyan
        Write-Host 'A verification URL and one-time code appear below. Approve it in a browser.' -ForegroundColor Cyan
        Write-Host ''

        Invoke-CHGForegroundProcess `
            -FilePath ([string]$context.Install.nodePath) `
            -ArgumentList @(
                [string]$context.Entrypoint,
                'auth',
                'login',
                '--provider',
                'copilot'
            ) `
            -WorkingDirectory ([string]$context.ReleasePath) `
            -EnvironmentVariables @{
                COPILOT_API_HOME = [string]$context.Paths.BackendHome
                HOST = '127.0.0.1'
                NODE_USE_SYSTEM_CA = '1'
            } `
            -TimeoutSeconds $TimeoutSeconds `
            -Operation 'Authentication'

        $tokenPath = Join-Path $context.Paths.BackendHome 'github_token'
        if (-not (Test-Path -LiteralPath $tokenPath) -or [string]::IsNullOrWhiteSpace((Get-Content -LiteralPath $tokenPath -Raw))) {
            throw 'Authentication completed without a persisted GitHub token.'
        }
        Protect-CHGFile $tokenPath
        $null = Initialize-CHGConfiguration -Paths $context.Paths
    }
    catch {
        $authenticationFailure = $_
    }

    if ($null -ne $authenticationFailure) {
        if ($desiredWasRunning) {
            try {
                $null = Start-CHGGateway -InstallRoot $InstallRoot
            }
            catch {
                throw "Authentication failed and the prior running state could not be restored. Authentication error: $($authenticationFailure.Exception.Message) Restore error: $($_.Exception.Message)"
            }
        }
        throw $authenticationFailure
    }
    if ($desiredWasRunning) {
        return Start-CHGGateway -InstallRoot $InstallRoot
    }
    return [PSCustomObject]@{
        Status = 'authenticated'
        Note = 'GitHub controls token lifetime; revocation or expiry can require authentication again.'
    }
}

function Get-CHGGatewayStatus {
    [CmdletBinding()]
    param([string]$InstallRoot)

    $context = Get-CHGInstalledContext $InstallRoot
    $desired = Read-CHGJson $context.Paths.DesiredState 'desired state'
    $runtime = $null
    $runtimeReadError = $null
    if (Test-Path -LiteralPath $context.Paths.RuntimeState) {
        try {
            $runtime = Read-CHGJson $context.Paths.RuntimeState 'runtime state'
        }
        catch {
            $runtimeReadError = $_.Exception.Message
        }
    }
    $task = Get-ScheduledTask -TaskName (Get-CHGTaskName) -ErrorAction SilentlyContinue
    $health = $null
    $healthError = $null
    try {
        $health = Invoke-CHGHealthRequest -Context $context -TimeoutSeconds 2
    }
    catch {
        $healthError = $_.Exception.Message
    }
    $reportedError = if ($null -ne $runtime) {
        $runtime.lastError
    }
    elseif (-not [string]::IsNullOrWhiteSpace($runtimeReadError)) {
        $runtimeReadError
    }
    else {
        $healthError
    }
    return [PSCustomObject]@{
        InstallRoot = $context.Paths.Root
        Endpoint = "http://127.0.0.1:$($context.Configuration.listen.port)"
        DesiredState = $desired.state
        Health = if ($null -eq $health) { 'unreachable' } else { $health.status }
        TaskState = if ($null -eq $task) { 'not-registered' } else { [string]$task.State }
        SupervisorPid = if ($null -eq $runtime) { $null } else { $runtime.supervisorPid }
        BackendPid = if ($null -eq $runtime) { $null } else { $runtime.backendPid }
        ActiveRelease = $context.Install.activeVersionId
        BackendVersion = $context.Release.backendVersion
        NodeVersion = $context.Install.nodeVersion
        LastError = $reportedError
    }
}

function Get-CHGGatewayHealth {
    [CmdletBinding()]
    param(
        [string]$InstallRoot,
        [switch]$Deep
    )

    $context = Get-CHGInstalledContext $InstallRoot
    $result = Invoke-CHGHealthRequest -Context $context -Deep:$Deep
    if ($Deep) {
        return [PSCustomObject]@{
            Status = 'healthy'
            ModelCount = @($result.data).Count
            Deep = $true
        }
    }
    return $result
}

function Get-CHGGatewayLogs {
    [CmdletBinding()]
    param(
        [string]$InstallRoot,
        [ValidateRange(1, 10000)]
        [int]$Tail = 100,
        [switch]$Follow
    )

    $context = Get-CHGInstalledContext $InstallRoot
    $path = Join-Path $context.Paths.Logs 'supervisor.jsonl'
    if (-not (Test-Path -LiteralPath $path)) {
        return
    }
    $secrets = @(
        [string]$context.Secrets.clientApiKey,
        [string]$context.Secrets.internalApiKey,
        [string]$context.Secrets.adminApiKey
    )
    Get-Content -LiteralPath $path -Tail $Tail -Wait:$Follow | ForEach-Object {
        $line = $_
        foreach ($secret in $secrets) {
            if (-not [string]::IsNullOrWhiteSpace($secret)) {
                $line = $line.Replace($secret, '[REDACTED]')
            }
        }
        $line
    }
}

function Invoke-CHGNodeTool {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][string]$Script,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $scriptPath = Join-Path $Context.ReleasePath $Script
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "Installed management tool is missing: $scriptPath"
    }
    & $Context.Install.nodePath $scriptPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Management tool failed with exit code $LASTEXITCODE."
    }
}

function Invoke-CHGModels {
    [CmdletBinding()]
    param(
        [string]$InstallRoot,
        [ValidateSet('list', 'refresh', 'set-alias')][string]$Action = 'list',
        [string]$Alias,
        [string]$Model,
        [string]$ModelsFile,
        [ValidateRange(100, 120000)]
        [int]$TimeoutMilliseconds = 10000
    )

    $context = Get-CHGInstalledContext $InstallRoot
    $arguments = @('--root', $context.Paths.Root, $Action, '--timeout-ms', [string]$TimeoutMilliseconds)
    if (-not [string]::IsNullOrWhiteSpace($Alias)) { $arguments += @('--alias', $Alias) }
    if (-not [string]::IsNullOrWhiteSpace($Model)) { $arguments += @('--model', $Model) }
    if (-not [string]::IsNullOrWhiteSpace($ModelsFile)) { $arguments += @('--models-file', $ModelsFile) }
    Invoke-CHGNodeTool -Context $context -Script 'runtime\models-cli.mjs' -Arguments $arguments
}

function Invoke-CHGConfigureClients {
    [CmdletBinding()]
    param(
        [string]$InstallRoot,
        [string[]]$Clients = @('all'),
        [string]$Model,
        [string]$ClaudeModel,
        [string]$CodexModel,
        [string]$FastModel,
        [Alias('Home')][string]$ClientHome,
        [string]$ModelsFile,
        [switch]$SetDefault,
        [switch]$DryRun,
        [switch]$Remove,
        [switch]$Force
    )

    $context = Get-CHGInstalledContext $InstallRoot
    $previousEnvironmentValue = $null
    $environmentChanged = $false
    if (-not $DryRun -and -not $Remove) {
        $previousEnvironmentValue = [Environment]::GetEnvironmentVariable(
            $script:EnvironmentVariable,
            [EnvironmentVariableTarget]::User
        )
        [Environment]::SetEnvironmentVariable(
            $script:EnvironmentVariable,
            [string]$context.Secrets.clientApiKey,
            [EnvironmentVariableTarget]::User
        )
        $environmentChanged = $true
    }
    $arguments = @('--root', $context.Paths.Root, '--clients', ($Clients -join ','))
    foreach ($entry in @(
        @{ Flag = '--model'; Value = $Model },
        @{ Flag = '--claude-model'; Value = $ClaudeModel },
        @{ Flag = '--codex-model'; Value = $CodexModel },
        @{ Flag = '--fast-model'; Value = $FastModel },
        @{ Flag = '--home'; Value = $ClientHome },
        @{ Flag = '--models-file'; Value = $ModelsFile }
    )) {
        if (-not [string]::IsNullOrWhiteSpace([string]$entry.Value)) {
            $arguments += @($entry.Flag, [string]$entry.Value)
        }
    }
    if ($SetDefault) { $arguments += '--set-default' }
    if ($DryRun) { $arguments += '--dry-run' }
    if ($Remove) { $arguments += '--remove' }
    if ($Force) { $arguments += '--force' }
    try {
        Invoke-CHGNodeTool -Context $context -Script 'runtime\configure-clients.mjs' -Arguments $arguments
    }
    catch {
        if ($environmentChanged) {
            [Environment]::SetEnvironmentVariable(
                $script:EnvironmentVariable,
                $previousEnvironmentValue,
                [EnvironmentVariableTarget]::User
            )
        }
        throw
    }
}

function New-CHGBackendSnapshot {
    param([Parameter(Mandatory = $true)]$Paths)

    $snapshot = Join-Path $Paths.Backups (
        'updates\{0}-{1}' -f
            [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss.fffZ'),
            [Guid]::NewGuid().ToString('N')
    )
    $null = New-Item -ItemType Directory -Path $snapshot -Force
    Copy-Item `
        -LiteralPath $Paths.BackendHome `
        -Destination (Join-Path $snapshot 'backend') `
        -Recurse
    return $snapshot
}

function Restore-CHGBackendSnapshot {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)][string]$Snapshot
    )

    $resolvedSnapshot = [IO.Path]::GetFullPath($Snapshot)
    $backupRoot = [IO.Path]::GetFullPath($Paths.Backups)
    if (-not $resolvedSnapshot.StartsWith(
        "$backupRoot\",
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Refusing a backend snapshot outside the protected backup root: $resolvedSnapshot"
    }
    $snapshotBackend = Join-Path $resolvedSnapshot 'backend'
    if (-not (Test-Path -LiteralPath $snapshotBackend -PathType Container)) {
        throw "Backend snapshot is missing: $snapshotBackend"
    }

    $displaced = Join-Path $resolvedSnapshot (
        'displaced-backend-{0}' -f [Guid]::NewGuid().ToString('N')
    )
    Move-Item -LiteralPath $Paths.BackendHome -Destination $displaced
    try {
        Copy-Item `
            -LiteralPath $snapshotBackend `
            -Destination $Paths.BackendHome `
            -Recurse
    }
    catch {
        $restoreFailure = $_
        if (Test-Path -LiteralPath $Paths.BackendHome) {
            Remove-Item -LiteralPath $Paths.BackendHome -Recurse -Force
        }
        Move-Item -LiteralPath $displaced -Destination $Paths.BackendHome
        throw "Backend snapshot restoration failed and the pre-restore directory was reinstated: $($restoreFailure.Exception.Message)"
    }
}

function Update-CHGGateway {
    [CmdletBinding()]
    param(
        [string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [string]$Version,
        [string]$ExpectedIntegrity,
        [switch]$Rollback,
        [switch]$SkipAcl,
        [switch]$SkipTask,
        [switch]$Offline
    )

    if (-not $Rollback) {
        if ([string]::IsNullOrWhiteSpace($Version)) {
            throw 'update requires an exact -Version. The value latest is never accepted.'
        }
        if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
            throw "Backend version must be exact: $Version"
        }
        $sourcePackage = Read-CHGJson (Join-Path $SourceRoot 'package.json') 'source package manifest'
        $sourcePin = [string]$sourcePackage.dependencies.PSObject.Properties[$script:BackendPackage].Value
        if ($Version -ne $sourcePin) {
            throw "The update source bundle pins backend '$sourcePin', not requested '$Version'. Use a reviewed checkout whose committed lock contains the requested version."
        }
    }

    $context = Get-CHGInstalledContext $InstallRoot
    $wasRunning = (Read-CHGJson $context.Paths.DesiredState 'desired state').state -eq 'running'
    $oldState = $context.Install
    try {
        $null = Stop-CHGGateway -InstallRoot $InstallRoot
    }
    catch {
        $stopFailure = $_
        if ($wasRunning) {
            try {
                $null = Start-CHGGateway -InstallRoot $InstallRoot
            }
            catch {
                throw "Update could not stop the gateway and could not restore its prior running state. Stop error: $($stopFailure.Exception.Message) Restore error: $($_.Exception.Message)"
            }
        }
        throw $stopFailure
    }
    try {
        $operationSnapshot = New-CHGBackendSnapshot -Paths $context.Paths
    }
    catch {
        $snapshotFailure = $_
        if ($wasRunning) {
            try {
                $null = Start-CHGGateway -InstallRoot $InstallRoot
            }
            catch {
                throw "Update could not snapshot backend state and could not restore the prior running gateway. Snapshot error: $($snapshotFailure.Exception.Message) Restore error: $($_.Exception.Message)"
            }
        }
        throw $snapshotFailure
    }

    try {
        if ($Rollback) {
            $targetId = [string]$oldState.previousVersionId
            if ([string]::IsNullOrWhiteSpace($targetId)) {
                throw 'No previous immutable release is recorded.'
            }
            $targetProperty = $oldState.releases.PSObject.Properties[$targetId]
            if ($null -eq $targetProperty) {
                throw "Previous release '$targetId' is missing."
            }
            $lastUpdateProperty = $oldState.PSObject.Properties['lastUpdate']
            if (
                $null -ne $lastUpdateProperty -and
                [string]$lastUpdateProperty.Value.fromVersionId -eq $targetId -and
                [string]$lastUpdateProperty.Value.toVersionId -eq [string]$oldState.activeVersionId
            ) {
                Restore-CHGBackendSnapshot `
                    -Paths $context.Paths `
                    -Snapshot ([string]$lastUpdateProperty.Value.backendSnapshot)
            }
            $releases = ConvertTo-CHGReleaseMap $oldState
            Write-CHGAtomicJson $context.Paths.InstallState ([ordered]@{
                schemaVersion = 1
                activeVersionId = $targetId
                previousVersionId = [string]$oldState.activeVersionId
                nodePath = [string]$oldState.nodePath
                nodeVersion = [string]$oldState.nodeVersion
                backendPackage = $script:BackendPackage
                releases = $releases
                lastUpdate = [ordered]@{
                    fromVersionId = [string]$oldState.activeVersionId
                    toVersionId = $targetId
                    backendSnapshot = $operationSnapshot
                    completedAt = [DateTime]::UtcNow.ToString('o')
                }
                updatedAt = [DateTime]::UtcNow.ToString('o')
            })
            $targetRoot = Join-Path $context.Paths.Versions $targetId
            Copy-CHGAtomicFile (Join-Path $targetRoot 'gateway.ps1') $context.Paths.StableGateway
            Copy-CHGAtomicFile (Join-Path $targetRoot 'powershell\launcher.ps1') $context.Paths.StableLauncher
            Register-CHGScheduledTask -Paths $context.Paths -SkipTask:$SkipTask
        }
        else {
            $release = Install-CHGImmutableRelease `
                -Paths $context.Paths `
                -SourceRoot $SourceRoot `
                -BackendVersion $Version `
                -ExpectedIntegrity $ExpectedIntegrity `
                -Offline:$Offline
            $node = [ordered]@{ Path = [string]$oldState.nodePath; Version = [string]$oldState.nodeVersion }
            $null = Set-CHGActiveRelease -Paths $context.Paths -Node $node -Release $release
            $newState = Read-CHGJson $context.Paths.InstallState 'new install state'
            $newState | Add-Member -NotePropertyName lastUpdate -NotePropertyValue ([PSCustomObject]@{
                fromVersionId = [string]$oldState.activeVersionId
                toVersionId = $release.Id
                backendSnapshot = $operationSnapshot
                completedAt = [DateTime]::UtcNow.ToString('o')
            }) -Force
            Write-CHGAtomicJson $context.Paths.InstallState $newState
            Copy-CHGAtomicFile (Join-Path $SourceRoot 'gateway.ps1') $context.Paths.StableGateway
            Copy-CHGAtomicFile (Join-Path $SourceRoot 'powershell\launcher.ps1') $context.Paths.StableLauncher
            Register-CHGScheduledTask -Paths $context.Paths -SkipTask:$SkipTask
        }
        $newContext = Get-CHGInstalledContext $InstallRoot
        $null = Initialize-CHGConfiguration -Paths $newContext.Paths -SkipAcl:$SkipAcl
        if ($wasRunning) {
            return Start-CHGGateway -InstallRoot $InstallRoot
        }
        return Get-CHGGatewayStatus -InstallRoot $InstallRoot
    }
    catch {
        $updateFailure = $_
        try {
            $null = Stop-CHGGateway -InstallRoot $InstallRoot -TimeoutSeconds 15
        }
        catch {
            throw "Update failed and the failed release could not be stopped safely. Update error: $($updateFailure.Exception.Message) Stop error: $($_.Exception.Message)"
        }
        Restore-CHGBackendSnapshot -Paths $context.Paths -Snapshot $operationSnapshot
        Write-CHGAtomicJson $context.Paths.InstallState $oldState
        $oldReleaseRoot = Join-Path $context.Paths.Versions ([string]$oldState.activeVersionId)
        Copy-CHGAtomicFile (Join-Path $oldReleaseRoot 'gateway.ps1') $context.Paths.StableGateway
        Copy-CHGAtomicFile (Join-Path $oldReleaseRoot 'powershell\launcher.ps1') $context.Paths.StableLauncher
        Register-CHGScheduledTask -Paths $context.Paths -SkipTask:$SkipTask
        if ($wasRunning) {
            try {
                $null = Start-CHGGateway -InstallRoot $InstallRoot
            }
            catch {
                throw "Update failed and rollback could not restore the running gateway. Update error: $($updateFailure.Exception.Message) Restore error: $($_.Exception.Message)"
            }
        }
        throw $updateFailure
    }
}

function Uninstall-CHGGateway {
    [CmdletBinding()]
    param(
        [string]$InstallRoot,
        [switch]$PreserveState,
        [switch]$KeepClientConfiguration
    )

    $context = Get-CHGInstalledContext $InstallRoot
    $null = Stop-CHGGateway -InstallRoot $InstallRoot
    $task = Get-ScheduledTask -TaskName (Get-CHGTaskName) -ErrorAction SilentlyContinue
    if ($null -ne $task) {
        Unregister-ScheduledTask -TaskName (Get-CHGTaskName) -Confirm:$false
    }

    if (-not $KeepClientConfiguration) {
        try {
            Invoke-CHGConfigureClients -InstallRoot $InstallRoot -Clients @('all') -Remove
        }
        catch {
            throw "Client configuration cleanup failed; uninstall stopped to avoid destructive cleanup: $($_.Exception.Message)"
        }
        $current = [Environment]::GetEnvironmentVariable(
            $script:EnvironmentVariable,
            [EnvironmentVariableTarget]::User
        )
        if ($current -eq [string]$context.Secrets.clientApiKey) {
            [Environment]::SetEnvironmentVariable(
                $script:EnvironmentVariable,
                $null,
                [EnvironmentVariableTarget]::User
            )
        }
    }

    $marker = Read-CHGJson $context.Paths.Marker 'install-root marker'
    if ($marker.product -ne $script:GatewayName) {
        throw 'Install-root marker changed; refusing deletion.'
    }
    $alwaysRemove = @(
        $context.Paths.Versions,
        $context.Paths.Logs,
        $context.Paths.Staging,
        $context.Paths.StableGateway,
        $context.Paths.StableLauncher
    )
    foreach ($target in $alwaysRemove) {
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Recurse -Force
        }
    }
    if ($PreserveState) {
        foreach ($target in @(
            $context.Paths.InstallState,
            $context.Paths.DesiredState,
            $context.Paths.RuntimeState,
            $context.Paths.RuntimeLock
        )) {
            if (Test-Path -LiteralPath $target) {
                Remove-Item -LiteralPath $target -Force
            }
        }
        return [PSCustomObject]@{
            Status = 'uninstalled'
            Preserved = @('authentication', 'configuration', 'secrets', 'backups')
            InstallRoot = $context.Paths.Root
        }
    }

    foreach ($target in @(
        $context.Paths.ConfigDirectory,
        $context.Paths.SecretsDirectory,
        $context.Paths.State,
        $context.Paths.Data,
        $context.Paths.Backups,
        $context.Paths.Marker
    )) {
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Recurse -Force
        }
    }
    if ((Get-ChildItem -LiteralPath $context.Paths.Root -Force | Measure-Object).Count -eq 0) {
        Remove-Item -LiteralPath $context.Paths.Root -Force
    }
    return [PSCustomObject]@{ Status = 'uninstalled'; Preserved = @() }
}

Export-ModuleMember -Function @(
    'Get-CHGInstallRoot',
    'Get-CHGPaths',
    'Read-CHGJson',
    'Write-CHGAtomicText',
    'Write-CHGAtomicJson',
    'New-CHGSecret',
    'Get-CHGDefaultConfiguration',
    'Test-CHGConfiguration',
    'Get-CHGTaskName',
    'Install-CHGGateway',
    'Start-CHGGateway',
    'Stop-CHGGateway',
    'Restart-CHGGateway',
    'Invoke-CHGAuthenticate',
    'Get-CHGGatewayStatus',
    'Get-CHGGatewayHealth',
    'Get-CHGGatewayLogs',
    'Invoke-CHGModels',
    'Invoke-CHGConfigureClients',
    'Update-CHGGateway',
    'Uninstall-CHGGateway'
)
