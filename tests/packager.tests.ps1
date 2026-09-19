$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $projectRoot 'scripts\Packager.Common.ps1')

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) {
        throw "$Message Expected <$Expected>, got <$Actual>."
    }
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-packager-test-" + [guid]::NewGuid().ToString('N'))
$sourceRoot = Join-Path $testRoot 'source'
$workingRoot = Join-Path $testRoot 'working'

try {
    New-Item -ItemType Directory -Force -Path $sourceRoot, $workingRoot | Out-Null
    Write-Utf8File -Path (Join-Path $sourceRoot 'package.json') -Lines @(
        '{',
        '  "name": "fixture",',
        '  "version": "9.8.7",',
        '  "packageManager": "pnpm@11.7.0"',
        '}'
    )
    Write-Utf8File -Path (Join-Path $sourceRoot 'pnpm-workspace.yaml') -Lines @(
        'packages:',
        '  - apps/*',
        '',
        'overrides:',
        "  '@deepseek-ai/cosmokit': 'link:vendor/cosmokit'",
        '',
        'allowBuilds:',
        '  esbuild: true'
    )
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'package.json'), (Join-Path $sourceRoot 'pnpm-workspace.yaml') -Destination $workingRoot -Force
    $webBundleRoot = Join-Path $workingRoot 'packages\bundle\web-app'
    New-Item -ItemType Directory -Force -Path $webBundleRoot | Out-Null
    Write-Utf8File -Path (Join-Path $webBundleRoot 'package.json') -Lines @(
        '{',
        '  "name": "@deepseek-ai/dsh-web-app",',
        '  "dependencies": {}',
        '}'
    )
    Write-Utf8File -Path (Join-Path $webBundleRoot 'cordis.patch.yml') -Lines @(
        '- insert:',
        '    - id: ui-settings-general',
        "      name: '@deepseek-ai/dsh-client-ui-settings-general'"
    )
    Write-Utf8File -Path (Join-Path $workingRoot 'tsconfig.client.json') -Lines @(
        '{',
        '  "references": [',
        '    { "path": "./apps/web" }',
        '  ]',
        '}'
    )
    $sourcePackageHash = Get-Sha256Hex -Path (Join-Path $sourceRoot 'package.json')
    $sourceWorkspaceHash = Get-Sha256Hex -Path (Join-Path $sourceRoot 'pnpm-workspace.yaml')

    # Snapshot workspaces may contain npm settings without defining a package.
    $snapshotRoot = Join-Path $workingRoot 'snapshots\session\browser-use-chrome-devtools-mcp\workspace'
    New-Item -ItemType Directory -Force -Path $snapshotRoot | Out-Null
    Write-Utf8File -Path (Join-Path $snapshotRoot 'package.json') -Lines @(
        '{"private":true,"type":"module","dependencies":{"fixture-only":"1.0.0"}}'
    )
    $snapshotHash = Get-Sha256Hex -Path (Join-Path $snapshotRoot 'package.json')

    $expectedDesktopVersion = [string](Get-Content -LiteralPath (Join-Path $projectRoot 'overlay\apps\desktop\package.json') -Raw | ConvertFrom-Json).version
    $version = Prepare-UpstreamSource -OverlayRoot (Join-Path $projectRoot 'overlay') -WorkingRoot $workingRoot
    Assert-Equal $expectedDesktopVersion $version 'The independent desktop version was not returned.'
    $desktopManifest = Get-Content -LiteralPath (Join-Path $workingRoot 'apps\desktop\package.json') -Raw | ConvertFrom-Json
    Assert-Equal $expectedDesktopVersion $desktopManifest.version 'The desktop version was not preserved from the overlay.'
    $desktopPluginManifest = Get-Content -LiteralPath (Join-Path $workingRoot 'packages\client\ui-desktop\package.json') -Raw | ConvertFrom-Json
    Assert-Equal $expectedDesktopVersion $desktopPluginManifest.version 'The desktop Web plugin version was not synchronized.'
    Assert-Equal '6.8.9' $desktopManifest.dependencies.'electron-updater' 'Registry dependencies were not preserved.'
    $unavailableWorkspaceDependencies = @($desktopManifest.dependencies.PSObject.Properties | Where-Object {
        ([string]$_.Value).StartsWith('workspace:')
    })
    Assert-Equal 1 $unavailableWorkspaceDependencies.Count 'Unexpected workspace dependencies remained after pruning.'
    Assert-Equal '@runwen-you/dsh-client-ui-desktop' $unavailableWorkspaceDependencies[0].Name 'The retained workspace dependency is not the installed desktop Web plugin.'
    Assert-True (Test-Path -LiteralPath (Join-Path $workingRoot 'apps\desktop\src\main.ts')) 'The desktop overlay was not installed.'
    Assert-True (Test-Path -LiteralPath (Join-Path $workingRoot 'packages\client\ui-desktop\src\client\index.ts')) 'The desktop Web plugin was not installed.'
    $webPatch = Get-Content -LiteralPath (Join-Path $webBundleRoot 'cordis.patch.yml') -Raw
    Assert-Equal 1 ([regex]::Matches($webPatch, '(?m)^    - id: ui-desktop\r?$').Count) 'The desktop Web plugin row was not inserted once.'
    $webBundleManifest = Get-Content -LiteralPath (Join-Path $webBundleRoot 'package.json') -Raw | ConvertFrom-Json
    Assert-Equal 'workspace:^' $webBundleManifest.dependencies.'@runwen-you/dsh-client-ui-desktop' 'The desktop Web plugin was not linked from the Web bundle.'
    Assert-True ((Get-Content -LiteralPath (Join-Path $workingRoot 'tsconfig.client.json') -Raw).Contains('packages/client/ui-desktop')) 'The desktop Web plugin project reference was not inserted.'
    Assert-True (Test-Path -LiteralPath (Join-Path $workingRoot 'apps\desktop\bin\dsh.cmd')) 'The dsh command shim was not installed.'
    Assert-True (Test-Path -LiteralPath (Join-Path $workingRoot 'apps\desktop\bin\pnpm.cmd')) 'The bundled pnpm command shim was not installed.'
    $runtimeLockPath = Join-Path $workingRoot 'apps\desktop\scripts\primary-runtime-lock.json'
    Assert-True (-not (Test-Path -LiteralPath $runtimeLockPath)) 'A desktop runtime lock was fabricated for older upstream sources.'

    $buildWorkContainer = Get-BuildWorkContainer
    Assert-True ($buildWorkContainer.StartsWith([System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()), [System.StringComparison]::OrdinalIgnoreCase)) 'The build work container is not under the system temporary directory.'
    Assert-True ($buildWorkContainer.Length -lt 100) 'The build work container is too long for deeply nested Node.js dependencies.'

    # Newer upstream notice generators import this file from the desktop app.
    # A BOM, mixed line endings, and no trailing newline detect text rewriting.
    $runtimeLockEncoding = New-Object System.Text.UTF8Encoding($true)
    [byte[]]$runtimeLockBytes = $runtimeLockEncoding.GetPreamble() + $runtimeLockEncoding.GetBytes("{`r`n  `"pythonPackages`": {`"numpy`": `"2.3.5`"}`n}")
    [System.IO.File]::WriteAllBytes($runtimeLockPath, $runtimeLockBytes)
    $runtimeLockHash = Get-Sha256Hex -Path $runtimeLockPath
    $staleDesktopSource = Join-Path $workingRoot 'apps\desktop\src\upstream-only.ts'
    Write-Utf8File -Path $staleDesktopSource -Lines @('export const upstreamOnly = true')

    $overrideVersion = Prepare-UpstreamSource -OverlayRoot (Join-Path $projectRoot 'overlay') -WorkingRoot $workingRoot -DesktopVersion '0.2.1'
    Assert-Equal '0.2.1' $overrideVersion 'The workflow desktop-version override was not returned.'
    $desktopManifest = Get-Content -LiteralPath (Join-Path $workingRoot 'apps\desktop\package.json') -Raw | ConvertFrom-Json
    $desktopPluginManifest = Get-Content -LiteralPath (Join-Path $workingRoot 'packages\client\ui-desktop\package.json') -Raw | ConvertFrom-Json
    Assert-Equal '0.2.1' $desktopManifest.version 'The workflow desktop-version override was not applied.'
    Assert-Equal '0.2.1' $desktopPluginManifest.version 'The workflow version was not applied to the desktop Web plugin.'
    Assert-Equal $runtimeLockHash (Get-Sha256Hex -Path $runtimeLockPath) 'The upstream desktop runtime lock was removed or rewritten.'
    Assert-True (-not (Test-Path -LiteralPath $staleDesktopSource)) 'Upstream desktop sources survived overlay replacement.'
    Prepare-UpstreamSource -OverlayRoot (Join-Path $projectRoot 'overlay') -WorkingRoot $workingRoot -DesktopVersion '0.2.1' | Out-Null
    Assert-Equal $runtimeLockHash (Get-Sha256Hex -Path $runtimeLockPath) 'Desktop runtime lock preservation is not idempotent.'
    $workspace = Get-Content -LiteralPath (Join-Path $workingRoot 'pnpm-workspace.yaml') -Raw
    Assert-Equal 1 ([regex]::Matches($workspace, "(?m)^  '@electron/get':").Count) 'The Electron override is not idempotent.'
    Assert-Equal 1 ([regex]::Matches($workspace, '(?m)^  electron:').Count) 'The Electron build permission is not idempotent.'
    Assert-Equal 1 ([regex]::Matches($workspace, '(?m)^  electron-winstaller:').Count) 'The installer build permission is not idempotent.'
    $webPatch = Get-Content -LiteralPath (Join-Path $webBundleRoot 'cordis.patch.yml') -Raw
    Assert-Equal 1 ([regex]::Matches($webPatch, '(?m)^    - id: ui-desktop\r?$').Count) 'The desktop Web plugin row is not idempotent.'
    $webBundleManifest = Get-Content -LiteralPath (Join-Path $webBundleRoot 'package.json') -Raw | ConvertFrom-Json
    Assert-Equal 'workspace:^' $webBundleManifest.dependencies.'@runwen-you/dsh-client-ui-desktop' 'The Web bundle dependency is not idempotent.'
    Assert-Equal 1 ([regex]::Matches((Get-Content -LiteralPath (Join-Path $workingRoot 'tsconfig.client.json') -Raw), 'packages/client/ui-desktop').Count) 'The desktop Web plugin project reference is not idempotent.'

    Assert-Equal $snapshotHash (Get-Sha256Hex -Path (Join-Path $snapshotRoot 'package.json')) 'The nameless snapshot manifest was modified.'
    Assert-Equal $sourcePackageHash (Get-Sha256Hex -Path (Join-Path $sourceRoot 'package.json')) 'The source package.json was modified.'
    Assert-Equal $sourceWorkspaceHash (Get-Sha256Hex -Path (Join-Path $sourceRoot 'pnpm-workspace.yaml')) 'The source workspace config was modified.'
    Assert-SourceInfo -SourceInfo ([ordered]@{
        cleanupMode = 'worktree'
        commit = '0123456789abcdef'
        ref = 'origin/master'
        source = 'https://example.invalid/upstream.git'
    })
    $invalidSourceInfoRejected = $false
    try { Assert-SourceInfo -SourceInfo ([ordered]@{ commit = '0123456789abcdef' }) }
    catch { $invalidSourceInfoRejected = $true }
    Assert-True $invalidSourceInfoRejected 'Incomplete source information was accepted.'

    $peerRoot = Join-Path $testRoot 'peer-closure'
    $peerDesktop = Join-Path $peerRoot 'apps\desktop'
    $peerConsumer = Join-Path $peerRoot 'packages\fixture\consumer'
    $peerRequired = Join-Path $peerRoot 'packages\fixture\required'
    New-Item -ItemType Directory -Force -Path $peerDesktop, $peerConsumer, $peerRequired | Out-Null
    Write-Utf8File -Path (Join-Path $peerDesktop 'package.json') -Lines @(
        '{"name":"fixture-desktop","dependencies":{"fixture-consumer":"workspace:^","registry-package":"1.0.0"}}'
    )
    Write-Utf8File -Path (Join-Path $peerConsumer 'package.json') -Lines @(
        '{"name":"fixture-consumer","peerDependencies":{"fixture-required":"workspace:^"}}'
    )
    Write-Utf8File -Path (Join-Path $peerRequired 'package.json') -Lines @(
        '{"name":"fixture-required"}'
    )
    Add-RequiredWorkspacePeers -ManifestPath (Join-Path $peerDesktop 'package.json') -WorkingRoot $peerRoot
    $peerManifest = Get-Content -LiteralPath (Join-Path $peerDesktop 'package.json') -Raw | ConvertFrom-Json
    Assert-Equal 'workspace:^' $peerManifest.dependencies.'fixture-required' 'A required workspace peer was not added.'
    Assert-Equal '1.0.0' $peerManifest.dependencies.'registry-package' 'A registry dependency changed while closing workspace peers.'

    Write-Host 'PASS: overlay injection, runtime lock preservation, version synchronization, peer closure, idempotency, and source isolation'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
