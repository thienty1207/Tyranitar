param(
  [string]$RepositoryRoot = (Split-Path $PSScriptRoot -Parent),
  [string]$ReleaseTag,
  [string]$DestinationDirectory
)

$ErrorActionPreference = 'Stop'
$RepositoryRoot = [IO.Path]::GetFullPath($RepositoryRoot)
$manifestPath = Join-Path $RepositoryRoot 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'package_manifest_missing' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -cne 'tyrant-engine' -or $manifest.version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
  throw 'package_manifest_invalid'
}
$expectedTag = "v$($manifest.version)"
if (-not $ReleaseTag) { $ReleaseTag = $expectedTag }
if ($ReleaseTag -cne $expectedTag) { throw 'release_tag_version_mismatch' }

$required = @(
  'package.json', 'bun.lock', 'README.md', 'LICENSE', 'src\cli.ts', 'src\index.ts',
  'integrations\command-hook.js', 'integrations\dsh\index.js', 'integrations\opencode\index.js',
  'vendor\skills\manifest.json', 'installers\tyrant.cmd'
)
foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $RepositoryRoot $path) -PathType Leaf)) {
    throw "release_payload_missing:$($path.Replace('\', '/'))"
  }
}

$outputDirectory = if ($DestinationDirectory) { [IO.Path]::GetFullPath($DestinationDirectory) } else { Join-Path $RepositoryRoot 'dist' }
$archivePath = Join-Path $outputDirectory "tyrant-engine-$($manifest.version)-windows-x64.zip"
if (Test-Path -LiteralPath $archivePath) { throw 'release_archive_already_exists' }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$temporaryArchivePath = Join-Path $outputDirectory "tyrant-engine-$($manifest.version)-$([guid]::NewGuid().ToString('N')).tmp"

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$stageRoot = Join-Path $tempBase "tyrant-release-$([guid]::NewGuid().ToString('N'))"
$stageRoot = [IO.Path]::GetFullPath($stageRoot)
if (-not $stageRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'release_stage_path_untrusted' }

try {
  New-Item -ItemType Directory -Path $stageRoot | Out-Null
  foreach ($directory in @('src', 'integrations', 'vendor')) {
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot $directory) -Destination $stageRoot -Recurse
  }
  foreach ($file in @('package.json', 'bun.lock', 'README.md', 'LICENSE')) {
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot $file) -Destination $stageRoot
  }
  New-Item -ItemType Directory -Path (Join-Path $stageRoot 'installers') | Out-Null
  Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'installers\tyrant.cmd') -Destination (Join-Path $stageRoot 'installers\tyrant.cmd')

  $unexpectedNodeModules = Get-ChildItem -LiteralPath $stageRoot -Directory -Recurse -Force | Where-Object { $_.Name -ceq 'node_modules' }
  if ($unexpectedNodeModules) { throw 'release_archive_contains_node_modules' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($stageRoot, $temporaryArchivePath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  $zip = [System.IO.Compression.ZipFile]::OpenRead($temporaryArchivePath)
  try {
    $entries = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    foreach ($entry in $entries) {
      if (-not $entry -or $entry.StartsWith('/') -or $entry -match '^[A-Za-z]:' -or $entry.Split('/') -contains '..') {
        throw 'release_archive_path_invalid'
      }
    }
    foreach ($path in @('package.json', 'bun.lock', 'src/cli.ts', 'src/index.ts', 'integrations/command-hook.js', 'integrations/dsh/index.js', 'vendor/skills/manifest.json', 'installers/tyrant.cmd')) {
      if ($entries -cnotcontains $path) { throw "release_archive_payload_missing:$path" }
    }
    if ($entries | Where-Object { $_ -match '(^|/)node_modules/' -or $_ -match '(^|/)\.git/' -or $_ -match '(^|/)tests?/' }) {
      throw 'release_archive_contains_development_files'
    }
  } finally { $zip.Dispose() }

  if (Test-Path -LiteralPath $archivePath) { throw 'release_archive_already_exists' }
  [IO.File]::Move($temporaryArchivePath, $archivePath)
  $file = Get-Item -LiteralPath $archivePath
  $digest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  [pscustomobject]@{ path = $archivePath; version = $manifest.version; tag = $ReleaseTag; bytes = $file.Length; sha256 = $digest }
} catch {
  Remove-Item -LiteralPath $temporaryArchivePath -Force -ErrorAction SilentlyContinue
  throw
} finally {
  Remove-Item -LiteralPath $temporaryArchivePath -Force -ErrorAction SilentlyContinue
  if ($stageRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $stageRoot)) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
