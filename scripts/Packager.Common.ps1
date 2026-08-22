Set-StrictMode -Version Latest

function Write-Utf8File {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Lines
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($Path, $Lines, $encoding)
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)

    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try { return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose() }
    }
    finally { $algorithm.Dispose() }
}

function Get-BuildWorkContainer {
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    return Join-Path $tempRoot 'dsh-build'
}

function Add-YamlMappingEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Section,
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.AddRange([string[]][System.IO.File]::ReadAllLines($Path))
    $sectionIndex = -1
    for ($index = 0; $index -lt $lines.Count; $index += 1) {
        if ($lines[$index] -match ('^' + [regex]::Escape($Section) + ':\s*$')) {
            $sectionIndex = $index
            break
        }
    }

    if ($sectionIndex -lt 0) {
        if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -ne '') {
            $lines.Add('')
        }
        $lines.Add("${Section}:")
        $lines.Add("  ${Key}: ${Value}")
        Write-Utf8File -Path $Path -Lines $lines.ToArray()
        return
    }

    $sectionEnd = $lines.Count
    for ($index = $sectionIndex + 1; $index -lt $lines.Count; $index += 1) {
        if ($lines[$index] -match '^[^\s#][^:]*:\s*(?:#.*)?$') {
            $sectionEnd = $index
            break
        }
    }

    $entryPattern = '^\s{2}' + [regex]::Escape($Key) + ':\s*'
    for ($index = $sectionIndex + 1; $index -lt $sectionEnd; $index += 1) {
        if ($lines[$index] -match $entryPattern) {
            $lines[$index] = "  ${Key}: ${Value}"
            Write-Utf8File -Path $Path -Lines $lines.ToArray()
            return
        }
    }

    $lines.Insert($sectionEnd, "  ${Key}: ${Value}")
    Write-Utf8File -Path $Path -Lines $lines.ToArray()
}

function Set-JsonVersion {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Version
    )

    $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $manifest.version = $Version
    $json = $manifest | ConvertTo-Json -Depth 100
    Write-Utf8File -Path $Path -Lines @($json)
}

function Set-JsonDependency {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Version
    )

    $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $dependenciesProperty = $manifest.PSObject.Properties['dependencies']
    if ($null -eq $dependenciesProperty) {
        $manifest | Add-Member -MemberType NoteProperty -Name 'dependencies' -Value ([pscustomobject]@{})
    }
    $dependencyProperty = $manifest.dependencies.PSObject.Properties[$Name]
    if ($null -eq $dependencyProperty) {
        $manifest.dependencies | Add-Member -MemberType NoteProperty -Name $Name -Value $Version
    }
    else {
        $dependencyProperty.Value = $Version
    }
    $json = $manifest | ConvertTo-Json -Depth 100
    Write-Utf8File -Path $Path -Lines @($json)
}

function Remove-UnavailableWorkspaceDependencies {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$WorkingRoot
    )

    $availablePackages = @{}
    foreach ($packagePath in Get-ChildItem -LiteralPath $WorkingRoot -Filter 'package.json' -File -Recurse | Where-Object { $_.FullName -notmatch '[\\/](?:node_modules|\.git)[\\/]' }) {
        try {
            $packageJson = [System.IO.File]::ReadAllText($packagePath.FullName, [System.Text.Encoding]::UTF8)
            $packageManifest = $packageJson | ConvertFrom-Json
            if (-not [string]::IsNullOrWhiteSpace([string]$packageManifest.name)) {
                $availablePackages[[string]$packageManifest.name] = $true
            }
        }
        catch {
            throw "Could not read workspace package manifest $($packagePath.FullName): $_"
        }
    }

    $manifestJson = [System.IO.File]::ReadAllText($ManifestPath, [System.Text.Encoding]::UTF8)
    $manifest = $manifestJson | ConvertFrom-Json
    $removed = [System.Collections.Generic.List[string]]::new()
    foreach ($dependency in @($manifest.dependencies.PSObject.Properties)) {
        if (-not ([string]$dependency.Value).StartsWith('workspace:')) { continue }
        if ($availablePackages.ContainsKey($dependency.Name)) { continue }
        $manifest.dependencies.PSObject.Properties.Remove($dependency.Name)
        $removed.Add($dependency.Name)
    }
    if ($removed.Count -gt 0) {
        Write-Host "Removed workspace dependencies no longer present upstream: $($removed -join ', ')"
        Write-Utf8File -Path $ManifestPath -Lines @(($manifest | ConvertTo-Json -Depth 100))
    }
}

function Add-RequiredWorkspacePeers {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$WorkingRoot
    )

    $workspacePackages = @{}
    foreach ($packagePath in Get-ChildItem -LiteralPath $WorkingRoot -Filter 'package.json' -File -Recurse | Where-Object { $_.FullName -notmatch '[\\/](?:node_modules|\.git)[\\/]' }) {
        $packageJson = [System.IO.File]::ReadAllText($packagePath.FullName, [System.Text.Encoding]::UTF8)
        $packageManifest = $packageJson | ConvertFrom-Json
        if (-not [string]::IsNullOrWhiteSpace([string]$packageManifest.name)) {
            $workspacePackages[[string]$packageManifest.name] = $packageManifest
        }
    }

    $desktopJson = [System.IO.File]::ReadAllText($ManifestPath, [System.Text.Encoding]::UTF8)
    $desktopManifest = $desktopJson | ConvertFrom-Json
    $runtimeDependencies = @{}
    $canonicalPath = Join-Path $WorkingRoot 'python\sdk-runtime\package.json'
    if (Test-Path -LiteralPath $canonicalPath) {
        $canonicalJson = [System.IO.File]::ReadAllText($canonicalPath, [System.Text.Encoding]::UTF8)
        $canonicalManifest = $canonicalJson | ConvertFrom-Json
        foreach ($dependency in @($canonicalManifest.dependencies.PSObject.Properties)) {
            $runtimeDependencies[$dependency.Name] = [string]$dependency.Value
        }
    }
    foreach ($dependency in @($desktopManifest.dependencies.PSObject.Properties)) {
        $runtimeDependencies[$dependency.Name] = [string]$dependency.Value
    }

    $queue = [System.Collections.Generic.List[string]]::new()
    $reachable = @{}
    foreach ($dependencyName in @($runtimeDependencies.Keys)) {
        if (-not $workspacePackages.ContainsKey($dependencyName)) { continue }
        $reachable[$dependencyName] = $true
        $queue.Add($dependencyName)
    }

    $added = [System.Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $queue.Count; $index += 1) {
        $packageName = $queue[$index]
        $packageManifest = $workspacePackages[$packageName]
        $peerDependenciesProperty = $packageManifest.PSObject.Properties['peerDependencies']
        $peerDependencies = if ($null -eq $peerDependenciesProperty) { $null } else { $peerDependenciesProperty.Value }
        $peerProperties = @()
        if ($null -ne $peerDependencies) { $peerProperties = @($peerDependencies.PSObject.Properties) }
        foreach ($peer in $peerProperties) {
            $peerName = $peer.Name
            if (-not $workspacePackages.ContainsKey($peerName)) { continue }
            $peerMeta = $null
            $peerMetaProperty = $packageManifest.PSObject.Properties['peerDependenciesMeta']
            if ($null -ne $peerMetaProperty) {
                $peerMeta = $peerMetaProperty.Value.PSObject.Properties[$peerName]
            }
            $optionalProperty = if ($null -eq $peerMeta) { $null } else { $peerMeta.Value.PSObject.Properties['optional'] }
            if ($null -ne $optionalProperty -and $optionalProperty.Value -eq $true) { continue }
            if (-not $runtimeDependencies.ContainsKey($peerName)) {
                $peerVersion = [string]$peer.Value
                if (-not $peerVersion.StartsWith('workspace:')) { $peerVersion = 'workspace:^' }
                $desktopManifest.dependencies | Add-Member -MemberType NoteProperty -Name $peerName -Value $peerVersion
                $runtimeDependencies[$peerName] = $peerVersion
                $added.Add($peerName)
            }
            if (-not $reachable.ContainsKey($peerName)) {
                $reachable[$peerName] = $true
                $queue.Add($peerName)
            }
        }
        foreach ($sectionName in @('dependencies', 'optionalDependencies')) {
            $sectionProperty = $packageManifest.PSObject.Properties[$sectionName]
            if ($null -eq $sectionProperty) { continue }
            $section = $sectionProperty.Value
            foreach ($dependency in @($section.PSObject.Properties)) {
                $dependencyName = $dependency.Name
                if (-not $workspacePackages.ContainsKey($dependencyName) -or $reachable.ContainsKey($dependencyName)) { continue }
                $reachable[$dependencyName] = $true
                $queue.Add($dependencyName)
            }
        }
    }

    if ($added.Count -gt 0) {
        Write-Host "Added required workspace peers to the desktop runtime: $($added -join ', ')"
        Write-Utf8File -Path $ManifestPath -Lines @(($desktopManifest | ConvertTo-Json -Depth 100))
    }
}

function Install-DesktopOverlay {
    param(
        [Parameter(Mandatory = $true)][string]$OverlayRoot,
        [Parameter(Mandatory = $true)][string]$WorkingRoot
    )

    $source = Join-Path $OverlayRoot 'apps\desktop'
    $destination = Join-Path $WorkingRoot 'apps\desktop'
    if (-not (Test-Path -LiteralPath (Join-Path $source 'package.json'))) {
        throw "Desktop overlay is incomplete: $source"
    }
    if (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force

    $clientSource = Join-Path $OverlayRoot 'packages\client\ui-desktop'
    $clientDestination = Join-Path $WorkingRoot 'packages\client\ui-desktop'
    if (-not (Test-Path -LiteralPath (Join-Path $clientSource 'package.json'))) {
        throw "Desktop Web overlay is incomplete: $clientSource"
    }
    if (Test-Path -LiteralPath $clientDestination) {
        Remove-Item -LiteralPath $clientDestination -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $clientDestination) | Out-Null
    Copy-Item -LiteralPath $clientSource -Destination $clientDestination -Recurse -Force
}

function Prepare-UpstreamSource {
    param(
        [Parameter(Mandatory = $true)][string]$OverlayRoot,
        [Parameter(Mandatory = $true)][string]$WorkingRoot
    )

    $rootManifestPath = Join-Path $WorkingRoot 'package.json'
    $workspacePath = Join-Path $WorkingRoot 'pnpm-workspace.yaml'
    if (-not (Test-Path -LiteralPath $rootManifestPath)) {
        throw "Upstream package.json was not found: $rootManifestPath"
    }
    if (-not (Test-Path -LiteralPath $workspacePath)) {
        throw "Upstream pnpm-workspace.yaml was not found: $workspacePath"
    }

    $rootManifest = Get-Content -LiteralPath $rootManifestPath -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$rootManifest.version)) {
        throw 'The upstream root package has no version.'
    }

    Install-DesktopOverlay -OverlayRoot $OverlayRoot -WorkingRoot $WorkingRoot
    $desktopManifestPath = Join-Path $WorkingRoot 'apps\desktop\package.json'
    Set-JsonVersion -Path $desktopManifestPath -Version ([string]$rootManifest.version)
    Set-JsonVersion -Path (Join-Path $WorkingRoot 'packages\client\ui-desktop\package.json') -Version ([string]$rootManifest.version)
    Set-JsonDependency -Path (Join-Path $WorkingRoot 'packages\bundle\web-app\package.json') -Name '@runwen-you/dsh-client-ui-desktop' -Version 'workspace:^'
    Remove-UnavailableWorkspaceDependencies -ManifestPath $desktopManifestPath -WorkingRoot $WorkingRoot
    Add-RequiredWorkspacePeers -ManifestPath $desktopManifestPath -WorkingRoot $WorkingRoot

    $webPatchPath = Join-Path $WorkingRoot 'packages\bundle\web-app\cordis.patch.yml'
    $webPatch = [System.IO.File]::ReadAllText($webPatchPath, [System.Text.Encoding]::UTF8)
    if ($webPatch -notmatch '(?m)^\s+- id: ui-desktop\s*$') {
        $settingsMarker = "    - id: ui-settings-general`n      name: '@deepseek-ai/dsh-client-ui-settings-general'"
        $normalizedPatch = $webPatch.Replace("`r`n", "`n")
        if (-not $normalizedPatch.Contains($settingsMarker)) {
            throw "Could not locate the General settings row in $webPatchPath"
        }
        $desktopRow = "`n`n    # Desktop-only bridge: native title bar theme sync and updater settings row.`n    - id: ui-desktop`n      name: '@runwen-you/dsh-client-ui-desktop'"
        $normalizedPatch = $normalizedPatch.Replace($settingsMarker, $settingsMarker + $desktopRow)
        Write-Utf8File -Path $webPatchPath -Lines @($normalizedPatch.TrimEnd("`n") -split "`n")
    }

    $clientConfigPath = Join-Path $WorkingRoot 'tsconfig.client.json'
    $clientConfig = [System.IO.File]::ReadAllText($clientConfigPath, [System.Text.Encoding]::UTF8)
    if ($clientConfig -notmatch 'packages/client/ui-desktop') {
        $configMarker = '    { "path": "./apps/web" }'
        if (-not $clientConfig.Contains($configMarker)) {
            throw "Could not locate the Web project reference in $clientConfigPath"
        }
        $clientConfig = $clientConfig.Replace($configMarker, "    { `"path`": `"./packages/client/ui-desktop`" },`r`n$configMarker")
        Write-Utf8File -Path $clientConfigPath -Lines @($clientConfig -split "`r?`n")
    }

    Add-YamlMappingEntry -Path $workspacePath -Section 'overrides' -Key "'@electron/get'" -Value "'5.1.0'"
    Add-YamlMappingEntry -Path $workspacePath -Section 'allowBuilds' -Key 'electron' -Value 'true'
    Add-YamlMappingEntry -Path $workspacePath -Section 'allowBuilds' -Key 'electron-winstaller' -Value 'true'

    return [string]$rootManifest.version
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )

    $parentPath = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    $childPath = [System.IO.Path]::GetFullPath($Child).TrimEnd('\') + '\'
    if (-not $childPath.StartsWith($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside $parentPath`: $childPath"
    }
}

function Assert-SourceInfo {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$SourceInfo
    )

    foreach ($key in @('cleanupMode', 'commit', 'ref', 'source')) {
        if (-not $SourceInfo.Contains($key) -or [string]::IsNullOrWhiteSpace([string]$SourceInfo[$key])) {
            throw "Build source information is missing $key."
        }
    }
}
