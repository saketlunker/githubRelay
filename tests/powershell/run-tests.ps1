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

function Invoke-WithLoopbackServer {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Server,
        [Parameter(Mandatory = $true)][scriptblock]$Client
    )

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $runspace = $null
    $serverPowerShell = $null
    $serverInvocation = $null
    $endInvokeCalled = $false
    try {
        $listener.Start()
        $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
        $runspace = [Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
        $runspace.Open()
        $serverPowerShell = [Management.Automation.PowerShell]::Create()
        $serverPowerShell.Runspace = $runspace
        [void]$serverPowerShell.AddScript($Server.ToString()).AddArgument($listener)
        $serverInvocation = $serverPowerShell.BeginInvoke()

        $result = & $Client $port
        if (-not $serverInvocation.AsyncWaitHandle.WaitOne(7000)) {
            throw 'Timed out waiting for the loopback test server to finish.'
        }
        try {
            [void]$serverPowerShell.EndInvoke($serverInvocation)
        }
        finally {
            $endInvokeCalled = $true
        }
        if ($serverPowerShell.Streams.Error.Count -gt 0) {
            throw ($serverPowerShell.Streams.Error -join ' | ')
        }
        return $result
    }
    finally {
        $listener.Stop()
        if ($null -ne $serverInvocation -and -not $endInvokeCalled) {
            if (-not $serverInvocation.IsCompleted) {
                $stop = $serverPowerShell.BeginStop($null, $null)
                try {
                    if (-not $stop.AsyncWaitHandle.WaitOne(7000)) {
                        throw 'Timed out stopping the loopback test server.'
                    }
                    $serverPowerShell.EndStop($stop)
                }
                finally {
                    $stop.AsyncWaitHandle.Close()
                }
            }

            if ($serverInvocation.AsyncWaitHandle.WaitOne(7000)) {
                try {
                    [void]$serverPowerShell.EndInvoke($serverInvocation)
                }
                catch [Management.Automation.PipelineStoppedException] {
                }
                finally {
                    $endInvokeCalled = $true
                }
            }
        }

        if ($null -ne $serverInvocation) {
            $serverInvocation.AsyncWaitHandle.Close()
        }
        if ($null -ne $serverPowerShell) {
            $serverPowerShell.Dispose()
        }
        if ($null -ne $runspace) {
            $runspace.Close()
            $runspace.Dispose()
        }
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

    Invoke-Test 'health probes report blocked states instead of unreachable' {
        $health = Invoke-WithLoopbackServer -Server {
            param([Net.Sockets.TcpListener]$Listener)

            $ErrorActionPreference = 'Stop'
            $client = $null
            $stream = $null
            try {
                $accept = $Listener.AcceptTcpClientAsync()
                if (-not ([IAsyncResult]$accept).AsyncWaitHandle.WaitOne(5000)) {
                    throw 'Timed out waiting for the health connection.'
                }
                $client = $accept.GetAwaiter().GetResult()
                $stream = $client.GetStream()
                $stream.ReadTimeout = 5000
                $stream.WriteTimeout = 5000
                $buffer = New-Object byte[] 4096
                if ($stream.Read($buffer, 0, $buffer.Length) -le 0) {
                    throw 'Health client closed before sending a request.'
                }

                $body = '{"status":"blocked-auth","backendReady":false}'
                $response = "HTTP/1.1 503 Service Unavailable`r`n"
                $response += "Content-Type: application/json`r`n"
                $response += "Content-Length: $([Text.Encoding]::UTF8.GetByteCount($body))`r`n"
                $response += "Connection: close`r`n`r`n$body"
                $bytes = [Text.Encoding]::UTF8.GetBytes($response)
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush()
            }
            finally {
                if ($null -ne $stream) {
                    $stream.Dispose()
                }
                if ($null -ne $client) {
                    $client.Dispose()
                }
            }
        } -Client {
            param([int]$Port)

            $probeContext = [ordered]@{
                Configuration = [PSCustomObject]@{
                    listen = [PSCustomObject]@{ address = '127.0.0.1'; port = $Port }
                }
                Secrets = [PSCustomObject]@{ clientApiKey = 'unused-test-key' }
            }
            return & $gatewayModule {
                param($TargetContext)
                Invoke-CHGHealthRequest -Context $TargetContext -TimeoutSeconds 5
            } $probeContext
        }
        Assert-Equal 'blocked-auth' ([string]$health.status) 'Health probe did not surface the blocked state.'
    }

    Invoke-Test 'health probes enforce one response deadline' {
        $outcome = Invoke-WithLoopbackServer -Server {
            param([Net.Sockets.TcpListener]$Listener)

            $ErrorActionPreference = 'Stop'
            $client = $null
            $stream = $null
            try {
                $accept = $Listener.AcceptTcpClientAsync()
                if (-not ([IAsyncResult]$accept).AsyncWaitHandle.WaitOne(5000)) {
                    throw 'Timed out waiting for the health connection.'
                }
                $client = $accept.GetAwaiter().GetResult()
                $stream = $client.GetStream()
                $stream.ReadTimeout = 5000
                $stream.WriteTimeout = 5000
                $buffer = New-Object byte[] 4096
                if ($stream.Read($buffer, 0, $buffer.Length) -le 0) {
                    throw 'Health client closed before sending a request.'
                }

                $bodyBytes = [Text.Encoding]::UTF8.GetBytes('{"status":"x"}')
                $headers = "HTTP/1.1 200 OK`r`n"
                $headers += "Content-Type: application/json`r`n"
                $headers += "Content-Length: $($bodyBytes.Length)`r`n"
                $headers += "Connection: close`r`n`r`n"
                $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers)
                $stream.Write($headerBytes, 0, $headerBytes.Length)
                $stream.Flush()
                for ($index = 0; $index -lt $bodyBytes.Length; $index++) {
                    try {
                        $stream.Write($bodyBytes, $index, 1)
                        $stream.Flush()
                    }
                    catch [IO.IOException] {
                        break
                    }
                    catch [ObjectDisposedException] {
                        break
                    }
                    Start-Sleep -Milliseconds 150
                }
            }
            finally {
                if ($null -ne $stream) {
                    $stream.Dispose()
                }
                if ($null -ne $client) {
                    $client.Dispose()
                }
            }
        } -Client {
            param([int]$Port)

            $probeContext = [ordered]@{
                Configuration = [PSCustomObject]@{
                    listen = [PSCustomObject]@{ address = '127.0.0.1'; port = $Port }
                }
                Secrets = [PSCustomObject]@{ clientApiKey = 'unused-test-key' }
            }
            $stopwatch = [Diagnostics.Stopwatch]::StartNew()
            $message = $null
            try {
                & $gatewayModule {
                    param($TargetContext)
                    Invoke-CHGHealthRequest -Context $TargetContext -TimeoutSeconds 1
                } $probeContext
            }
            catch {
                $message = $_.Exception.Message
            }
            finally {
                $stopwatch.Stop()
            }
            return [PSCustomObject]@{
                Message = $message
                ElapsedSeconds = $stopwatch.Elapsed.TotalSeconds
            }
        }

        Assert-Equal `
            'Loopback request timed out after 1 seconds.' `
            $outcome.Message `
            'Trickling health response did not time out.'
        Assert-True ($outcome.ElapsedSeconds -lt 3) 'Health response deadline was not bounded.'
    }

    Invoke-Test 'foreground process preserves inherited output and exact arguments' {
        $unicodeSuffix = [char]0x00E9
        $fixtureRoot = Join-Path $testRoot "foreground process $unicodeSuffix"
        $null = New-Item -ItemType Directory -Path $fixtureRoot -Force
        $childScript = Join-Path $fixtureRoot 'write arguments.mjs'
        $childResultPath = Join-Path $fixtureRoot 'child-result.json'
        $expectedPath = Join-Path $fixtureRoot 'expected.json'
        $driverScript = Join-Path $fixtureRoot 'capture driver.ps1'
        $driverResultPath = Join-Path $fixtureRoot 'driver-result.json'
        $source = @'
import { writeFileSync } from "node:fs";

const [outputPath, ...values] = process.argv.slice(2);
writeFileSync(
  outputPath,
  JSON.stringify({
    values,
    environment: process.env.CHG_TEST_CHILD_ENV,
  }),
  "utf8",
);
console.log("CHG_TEST_STDOUT_VISIBLE");
console.error("CHG_TEST_STDERR_VISIBLE");
'@
        [IO.File]::WriteAllText(
            $childScript,
            $source,
            [Text.UTF8Encoding]::new($false)
        )

        $expected = @(
            '',
            'value with spaces',
            'quote"value',
            'trailing\',
            'slashes\\"quote',
            "caf$unicodeSuffix"
        )
        $nodePath = [string](Get-Command node -ErrorAction Stop).Source
        [IO.File]::WriteAllText(
            $expectedPath,
            (ConvertTo-Json -InputObject $expected -Compress),
            [Text.UTF8Encoding]::new($false)
        )

        $driverSource = @'
[CmdletBinding()]
param(
    [string]$ModulePath,
    [string]$NodePath,
    [string]$ChildScript,
    [string]$ChildResultPath,
    [string]$ExpectedPath,
    [string]$WorkingDirectory,
    [string]$DriverResultPath
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force
$module = Get-Module CopilotHarnessGateway
$decodedArguments = (
    [IO.File]::ReadAllText($ExpectedPath, [Text.Encoding]::UTF8) |
        ConvertFrom-Json
)
$arguments = New-Object Collections.Generic.List[string]
foreach ($argument in $decodedArguments) {
    [void]$arguments.Add([string]$argument)
}
$pipelineOutput = @(
    & $module {
        param($Executable, $Arguments, $Directory)
        Invoke-CHGForegroundProcess `
            -FilePath $Executable `
            -ArgumentList $Arguments `
            -WorkingDirectory $Directory `
            -EnvironmentVariables @{ CHG_TEST_CHILD_ENV = 'child-value' } `
            -TimeoutSeconds 10 `
            -Operation 'Process helper test'
    } $NodePath (@($ChildScript, $ChildResultPath) + $arguments.ToArray()) $WorkingDirectory
)
$result = [ordered]@{
    pipelineCount = $pipelineOutput.Count
    parentEnvironment = $env:CHG_TEST_CHILD_ENV
}
[IO.File]::WriteAllText(
    $DriverResultPath,
    (ConvertTo-Json -InputObject $result -Compress),
    [Text.UTF8Encoding]::new($false)
)
'@
        [IO.File]::WriteAllText(
            $driverScript,
            $driverSource,
            [Text.UTF8Encoding]::new($false)
        )

        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = [string](Get-Process -Id $PID).Path
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $driverArguments = @(
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            $driverScript,
            $modulePath,
            $nodePath,
            $childScript,
            $childResultPath,
            $expectedPath,
            $fixtureRoot,
            $driverResultPath
        )
        & $gatewayModule {
            param($DriverStartInfo, $Arguments)
            Set-CHGProcessArguments -StartInfo $DriverStartInfo -ArgumentList $Arguments
        } $startInfo $driverArguments
        $startInfo.EnvironmentVariables['CHG_TEST_CHILD_ENV'] = 'parent-value'

        $driver = New-Object Diagnostics.Process
        $driver.StartInfo = $startInfo
        $started = $false
        try {
            $started = $driver.Start()
            Assert-True $started 'Output-capture driver did not start.'
            $stdoutTask = $driver.StandardOutput.ReadToEndAsync()
            $stderrTask = $driver.StandardError.ReadToEndAsync()
            if (-not $driver.WaitForExit(20000)) {
                $driver.Kill()
                $driver.WaitForExit()
                throw 'Output-capture driver timed out.'
            }
            $stdout = $stdoutTask.GetAwaiter().GetResult()
            $stderr = $stderrTask.GetAwaiter().GetResult()
            Assert-Equal 0 $driver.ExitCode "Output-capture driver failed: $stderr"
        }
        finally {
            if ($started -and -not $driver.HasExited) {
                $driver.Kill()
                $driver.WaitForExit()
            }
            $driver.Dispose()
        }

        Assert-True ($stdout -like '*CHG_TEST_STDOUT_VISIBLE*') 'Child stdout was not inherited.'
        Assert-True ($stderr -like '*CHG_TEST_STDERR_VISIBLE*') 'Child stderr was not inherited.'
        $driverResult = [IO.File]::ReadAllText(
            $driverResultPath,
            [Text.Encoding]::UTF8
        ) | ConvertFrom-Json
        Assert-Equal 0 $driverResult.pipelineCount 'Child output leaked into the PowerShell pipeline.'
        Assert-Equal `
            'parent-value' `
            $driverResult.parentEnvironment `
            'Child environment override changed the parent process.'

        $payload = [IO.File]::ReadAllText(
                $childResultPath,
                [Text.Encoding]::UTF8
            ) | ConvertFrom-Json
        Assert-Equal 'child-value' $payload.environment 'Child environment override was not applied.'
        Assert-Equal $expected.Count @($payload.values).Count 'Child argument count changed.'
        for ($index = 0; $index -lt $expected.Count; $index++) {
            Assert-Equal $expected[$index] $payload.values[$index] "Child argument $index changed."
        }
    }

    Invoke-Test 'foreground process failures are bounded and reap the owned child' {
        $fixtureRoot = Join-Path $testRoot 'foreground timeout'
        $null = New-Item -ItemType Directory -Path $fixtureRoot -Force
        $timeoutScript = Join-Path $fixtureRoot 'timeout.mjs'
        $pidPath = Join-Path $fixtureRoot 'child.pid'
        $source = @'
import { writeFileSync } from "node:fs";

writeFileSync(process.argv[2], String(process.pid), "utf8");
setTimeout(() => {}, 10000);
'@
        [IO.File]::WriteAllText(
            $timeoutScript,
            $source,
            [Text.UTF8Encoding]::new($false)
        )

        $nodePath = [string](Get-Command node -ErrorAction Stop).Source
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        $timeoutMessage = $null
        try {
            & $gatewayModule {
                param($Executable, $Arguments, $Directory)
                Invoke-CHGForegroundProcess `
                    -FilePath $Executable `
                    -ArgumentList $Arguments `
                    -WorkingDirectory $Directory `
                    -EnvironmentVariables @{} `
                    -TimeoutSeconds 1 `
                    -Operation 'Timeout test'
            } $nodePath @($timeoutScript, $pidPath) $fixtureRoot
        }
        catch {
            $timeoutMessage = $_.Exception.Message
        }
        finally {
            $stopwatch.Stop()
        }

        Assert-Equal 'Timeout test timed out after 1 seconds.' $timeoutMessage 'Unexpected timeout error.'
        Assert-True ($stopwatch.Elapsed.TotalSeconds -lt 5) 'Timed-out child cleanup was not bounded.'
        Assert-True (Test-Path -LiteralPath $pidPath -PathType Leaf) 'Timeout child did not record its PID.'
        $childPid = [int]([IO.File]::ReadAllText($pidPath))
        Assert-True `
            ($null -eq (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) `
            'Timed-out child process was not reaped.'

        $failureScript = Join-Path $fixtureRoot 'failure.mjs'
        [IO.File]::WriteAllText(
            $failureScript,
            'process.exit(7);',
            [Text.UTF8Encoding]::new($false)
        )
        $failureMessage = $null
        try {
            & $gatewayModule {
                param($Executable, $Arguments, $Directory)
                Invoke-CHGForegroundProcess `
                    -FilePath $Executable `
                    -ArgumentList $Arguments `
                    -WorkingDirectory $Directory `
                    -EnvironmentVariables @{} `
                    -TimeoutSeconds 10 `
                    -Operation 'Failure test'
            } $nodePath @($failureScript) $fixtureRoot
        }
        catch {
            $failureMessage = $_.Exception.Message
        }
        Assert-Equal 'Failure test failed with exit code 7.' $failureMessage 'Unexpected exit-code error.'
    }

    Invoke-Test 'authentication failure restores the prior running state' {
        $authenticationRoot = Join-Path $testRoot 'authentication restoration'
        $backendHome = Join-Path $authenticationRoot 'backend'
        $desiredState = Join-Path $authenticationRoot 'desired-state.json'
        $null = New-Item -ItemType Directory -Path $backendHome -Force
        Write-CHGAtomicJson $desiredState ([ordered]@{
            schemaVersion = 1
            state = 'running'
        })
        $fakeContext = [ordered]@{
            Paths = [ordered]@{
                DesiredState = $desiredState
                BackendHome = $backendHome
            }
            Install = [PSCustomObject]@{ nodePath = 'unused-test-node' }
            Entrypoint = 'unused-test-entrypoint'
            ReleasePath = $authenticationRoot
        }

        $outcome = & $gatewayModule {
            param($Context)

            $calls = New-Object Collections.Generic.List[string]
            function Get-CHGInstalledContext {
                param([string]$InstallRoot)
                [void]$calls.Add('context')
                return $Context
            }
            function Stop-CHGGateway {
                param([string]$InstallRoot)
                [void]$calls.Add('stop')
            }
            function Invoke-CHGForegroundProcess {
                param(
                    $FilePath,
                    $ArgumentList,
                    $WorkingDirectory,
                    $EnvironmentVariables,
                    $TimeoutSeconds,
                    $Operation
                )
                [void]$calls.Add('authenticate')
                throw [TimeoutException]::new(
                    "Authentication timed out after $TimeoutSeconds seconds."
                )
            }
            function Start-CHGGateway {
                param([string]$InstallRoot)
                [void]$calls.Add('restore')
                return [PSCustomObject]@{ Status = 'restored' }
            }

            $message = $null
            try {
                Invoke-CHGAuthenticate -InstallRoot 'unused-test-root' -TimeoutSeconds 60
            }
            catch {
                $message = $_.Exception.Message
            }
            return [PSCustomObject]@{
                Calls = $calls -join ','
                Message = $message
            }
        } $fakeContext

        Assert-Equal `
            'context,stop,authenticate,restore' `
            $outcome.Calls `
            'Authentication failure did not restore state in order.'
        Assert-Equal `
            'Authentication timed out after 60 seconds.' `
            $outcome.Message `
            'Authentication timeout was not rethrown after restoration.'
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
