param(
  [string]$InstallRoot,
  [string]$Version,
  [string]$ReleaseApiUrl = 'https://api.github.com/repos/thienty1207/Tyranitar/releases/latest',
  [switch]$LibraryOnly
)

$ErrorActionPreference = 'Stop'

function Get-TyrantReleaseAsset($Release) {
  if ($null -eq $Release -or $Release.draft -eq $true) { throw 'release_not_published' }
  if ($Release.prerelease -eq $true) { throw 'release_prerelease_unsupported' }
  if ($Release.tag_name -notmatch '^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$') { throw 'release_tag_invalid' }
  $releaseVersion = $Matches[1]
  if ($Version -and $releaseVersion -ne $Version) { throw 'release_version_mismatch' }
  $expectedName = "tyrant-engine-$releaseVersion-windows-x64.zip"
  $assets = @($Release.assets | Where-Object { $_.name -ceq $expectedName })
  if ($assets.Count -ne 1) { throw 'release_asset_missing' }
  $asset = $assets[0]
  if ($asset.state -cne 'uploaded') { throw 'release_asset_unavailable' }
  if ($asset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw 'release_digest_missing' }
  $assetUrl = $null
  try { $assetUrl = [uri]$asset.browser_download_url } catch { throw 'release_asset_url_untrusted' }
  $expectedPath = "/thienty1207/Tyranitar/releases/download/v$releaseVersion/$expectedName"
  if ($assetUrl.Scheme -cne 'https' -or $assetUrl.Host -cne 'github.com' -or $assetUrl.AbsolutePath -cne $expectedPath -or $assetUrl.UserInfo) {
    throw 'release_asset_url_untrusted'
  }
  return [pscustomobject]@{ version = $releaseVersion; name = $expectedName; url = $assetUrl.AbsoluteUri; sha256 = $Matches[1].ToLowerInvariant() }
}

function Test-TyrantArchiveEntry([string]$Entry) {
  if ([string]::IsNullOrWhiteSpace($Entry) -or $Entry.Contains([char]0)) { return $false }
  $normalized = $Entry.Replace('\', '/')
  if ($normalized.StartsWith('/') -or $normalized.StartsWith('//') -or $normalized -match '^[A-Za-z]:') { return $false }
  foreach ($part in $normalized.Split('/')) {
    if ($part -eq '..' -or $part -eq '.') { return $false }
  }
  return $true
}

function Add-TyrantUserPath([string]$Directory) {
  $resolved = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if (-not ($entries | Where-Object { [string]::Equals($_.TrimEnd('\'), $resolved, [StringComparison]::OrdinalIgnoreCase) })) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $resolved) -join ';'), 'User')
  }
  if (-not (($env:Path -split ';') | Where-Object { [string]::Equals($_.TrimEnd('\'), $resolved, [StringComparison]::OrdinalIgnoreCase) })) {
    $env:Path = "$resolved;$env:Path"
  }
}

function Install-TyrantBun {
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'windows_x64_required' }
  if (-not $env:USERPROFILE) { throw 'user_profile_missing' }
  $installer = Join-Path ([IO.Path]::GetTempPath()) "bun-install-$([guid]::NewGuid().ToString('N')).ps1"
  try {
    Invoke-WebRequest -Uri 'https://bun.sh/install.ps1' -OutFile $installer -TimeoutSec 60
    & $installer | Out-Null
  } finally {
    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
  }
}

function Get-TyrantBunPath {
  if (-not $env:USERPROFILE) { throw 'user_profile_missing' }
  $preferredPath = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
  $command = Get-Command bun -ErrorAction SilentlyContinue
  $bunPath = if ($command) { $command.Source } elseif (Test-Path -LiteralPath $preferredPath -PathType Leaf) { $preferredPath } else { $null }
  $versionText = $null
  if ($bunPath) {
    $versionText = (& $bunPath --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^\d+\.\d+\.\d+$') { $bunPath = $null }
  }
  if (-not $bunPath -or [version]$versionText -lt [version]'1.4.0') {
    Install-TyrantBun
    $bunPath = $preferredPath
  }
  if (-not (Test-Path -LiteralPath $bunPath -PathType Leaf)) { throw 'bun_install_failed' }
  $versionText = (& $bunPath --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^\d+\.\d+\.\d+$' -or [version]$versionText -lt [version]'1.4.0') {
    throw 'bun_version_unsupported'
  }
  Add-TyrantUserPath (Split-Path -Parent $bunPath)
  return $bunPath
}

function Test-TyrantPathWithin([string]$Parent, [string]$Child) {
  $base = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  $target = [IO.Path]::GetFullPath($Child)
  return $target.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)
}

function Read-TyrantVersionManifest([string]$Root, [string]$ExpectedVersion) {
  $fullRoot = [IO.Path]::GetFullPath($Root)
  $versionsPath = Join-Path $InstallRoot 'versions'
  if (-not (Test-TyrantPathWithin $versionsPath $fullRoot)) { throw 'release_version_path_untrusted' }
  $rootItem = Get-Item -LiteralPath $fullRoot -Force -ErrorAction Stop
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'release_version_path_untrusted' }
  $manifestPath = Join-Path $fullRoot 'package.json'
  $manifestItem = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
  if ($manifestItem.PSIsContainer -or ($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'release_package_invalid' }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.name -cne 'tyrant-engine' -or $manifest.version -cne $ExpectedVersion) { throw 'release_package_version_mismatch' }
  return $manifest
}

function Test-TyrantReleaseReceipt([string]$Root, [string]$ExpectedVersion) {
  $receiptPath = Join-Path $Root '.tyrant-release.json'
  $receiptItem = Get-Item -LiteralPath $receiptPath -Force -ErrorAction Stop
  if ($receiptItem.PSIsContainer -or ($receiptItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'release_version_receipt_invalid' }
  $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
  $expectedAsset = "tyrant-engine-$ExpectedVersion-windows-x64.zip"
  if ($receipt.schema_version -ne 1 -or $receipt.version -cne $ExpectedVersion -or $receipt.asset_name -cne $expectedAsset -or $receipt.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
    throw 'release_version_receipt_invalid'
  }
}

function Set-TyrantActiveRoot([string]$Root) {
  $newVersion = [IO.Path]::GetFileName([IO.Path]::GetFullPath($Root))
  Read-TyrantVersionManifest $Root $newVersion | Out-Null
  Test-TyrantReleaseReceipt $Root $newVersion
  $pointer = Join-Path $InstallRoot 'current.txt'
  $tempPointer = "$pointer.$([guid]::NewGuid().ToString('N')).tmp"
  $backupPointer = "$pointer.$([guid]::NewGuid().ToString('N')).bak"
  [IO.File]::WriteAllText($tempPointer, ([IO.Path]::GetFullPath($Root) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  $hadPointer = Test-Path -LiteralPath $pointer
  if ($hadPointer) {
    $pointerItem = Get-Item -LiteralPath $pointer -Force
    if ($pointerItem.PSIsContainer -or ($pointerItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'release_active_pointer_invalid' }
    $previousRoot = (Get-Content -LiteralPath $pointer -Raw).Trim()
    if (-not $previousRoot) { throw 'release_active_pointer_invalid' }
    $previousVersion = [IO.Path]::GetFileName([IO.Path]::GetFullPath($previousRoot))
    try {
      Read-TyrantVersionManifest $previousRoot $previousVersion | Out-Null
      Test-TyrantReleaseReceipt $previousRoot $previousVersion
    }
    catch { throw 'release_active_pointer_invalid' }
  }
  try {
    if ($hadPointer) { Move-Item -LiteralPath $pointer -Destination $backupPointer }
    Move-Item -LiteralPath $tempPointer -Destination $pointer
    if ($hadPointer) { Remove-Item -LiteralPath $backupPointer -Force }
  } catch {
    if (Test-Path -LiteralPath $pointer) { Remove-Item -LiteralPath $pointer -Force -ErrorAction SilentlyContinue }
    if ($hadPointer -and (Test-Path -LiteralPath $backupPointer)) { Move-Item -LiteralPath $backupPointer -Destination $pointer }
    Remove-Item -LiteralPath $tempPointer -Force -ErrorAction SilentlyContinue
    throw 'release_activation_failed'
  }
}

function Invoke-TyrantInstall {
  if (-not $InstallRoot) {
    if (-not $env:LOCALAPPDATA) { throw 'local_app_data_missing' }
    $InstallRoot = Join-Path $env:LOCALAPPDATA 'Tyrant'
  }
  $InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
  if (-not $ReleaseApiUrl.StartsWith('https://api.github.com/repos/thienty1207/Tyranitar/releases/', [StringComparison]::Ordinal)) {
    throw 'release_metadata_url_untrusted'
  }
  if ($Version) {
    if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw 'release_version_invalid' }
    $ReleaseApiUrl = "https://api.github.com/repos/thienty1207/Tyranitar/releases/tags/v$Version"
  }
  $release = Invoke-RestMethod -Uri $ReleaseApiUrl -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'Tyrant-Installer' } -TimeoutSec 20
  $asset = Get-TyrantReleaseAsset $release
  $bunPath = Get-TyrantBunPath
  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) "tyrant-install-$([guid]::NewGuid().ToString('N'))"
  $archivePath = Join-Path $tempRoot $asset.name
  $stagePath = Join-Path $tempRoot 'package'
  $versionsPath = Join-Path $InstallRoot 'versions'
  $versionPath = Join-Path $versionsPath $asset.version
  $binPath = Join-Path $InstallRoot 'bin'
  try {
    New-Item -ItemType Directory -Path $stagePath -Force | Out-Null
    Invoke-WebRequest -Uri $asset.url -OutFile $archivePath -Headers @{ 'User-Agent' = 'Tyrant-Installer' } -TimeoutSec 120
    if ((Get-Item -LiteralPath $archivePath).Length -gt 268435456) { throw 'release_asset_too_large' }
    $actualDigest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualDigest -cne $asset.sha256) { throw 'release_digest_mismatch' }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
      foreach ($entry in $zip.Entries) {
        if (-not (Test-TyrantArchiveEntry $entry.FullName)) { throw 'release_archive_path_invalid' }
      }
    } finally { $zip.Dispose() }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $stagePath -Force

    $manifestPath = Join-Path $stagePath 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'release_package_invalid' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.name -cne 'tyrant-engine' -or $manifest.version -cne $asset.version) { throw 'release_package_version_mismatch' }
    foreach ($required in @('bun.lock', 'src\cli.ts', 'src\index.ts', 'integrations\command-hook.js', 'integrations\dsh\index.js', 'vendor\skills\manifest.json')) {
      if (-not (Test-Path -LiteralPath (Join-Path $stagePath $required) -PathType Leaf)) { throw 'release_package_payload_missing' }
    }

    if (Test-Path -LiteralPath $versionPath) {
      try {
        Read-TyrantVersionManifest $versionPath $asset.version | Out-Null
        Test-TyrantReleaseReceipt $versionPath $asset.version
        $installedDigest = (Get-Content -LiteralPath (Join-Path $versionPath '.tyrant-release.json') -Raw | ConvertFrom-Json).sha256
        if ($installedDigest -cne $asset.sha256) { throw 'release_version_receipt_invalid' }
      } catch { throw 'release_version_path_conflict' }
    } else {
      New-Item -ItemType Directory -Path $versionsPath -Force | Out-Null
      Push-Location $stagePath
      try {
        & $bunPath install --frozen-lockfile --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw 'release_dependency_install_failed' }
        if (Test-Path -LiteralPath (Join-Path $stagePath '.tyrant-release.json')) { throw 'release_package_payload_conflict' }
        $receipt = @{ schema_version = 1; version = $asset.version; asset_name = $asset.name; sha256 = $asset.sha256 } | ConvertTo-Json
        $receiptPath = Join-Path $stagePath '.tyrant-release.json'
        $receiptStream = [IO.File]::Open($receiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
          $receiptBytes = [Text.UTF8Encoding]::new($false).GetBytes($receipt + [Environment]::NewLine)
          $receiptStream.Write($receiptBytes, 0, $receiptBytes.Length)
        } finally { $receiptStream.Dispose() }
      } finally { Pop-Location }
      Move-Item -LiteralPath $stagePath -Destination $versionPath
    }

    New-Item -ItemType Directory -Path $binPath -Force | Out-Null
    $shimSource = Join-Path $versionPath 'installers\tyrant.cmd'
    if (-not (Test-Path -LiteralPath $shimSource -PathType Leaf)) { throw 'release_command_shim_missing' }
    $shimDestination = Join-Path $binPath 'tyrant.cmd'
    if (Test-Path -LiteralPath $shimDestination) {
      $sourceHash = (Get-FileHash -LiteralPath $shimSource -Algorithm SHA256).Hash
      $installedHash = (Get-FileHash -LiteralPath $shimDestination -Algorithm SHA256).Hash
      if ($sourceHash -cne $installedHash) { throw 'command_shim_conflict' }
    } else {
      Copy-Item -LiteralPath $shimSource -Destination $shimDestination
    }
    Set-TyrantActiveRoot $versionPath
    Add-TyrantUserPath $binPath
    Write-Output "Installed Tyrant $($asset.version). Run tyrant setup <vault-path>, then tyrant init in each project."
  } finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if (-not $LibraryOnly) { Invoke-TyrantInstall }
