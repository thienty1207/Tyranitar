$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$vendorRoot = Join-Path $repositoryRoot 'vendor\skills'
New-Item -ItemType Directory -Path $vendorRoot -Force | Out-Null

$packages = @(
  @{ repo='mattpocock/skills'; commit='d1478fcb140db0b93c0c8df17bcfd311844749d0'; tree='42b57b23ac2979fce601ce1d4b4d6c1d46471bbe'; license='MIT'; ids=@('ask-matt','tdd','diagnosing-bugs','code-review') },
  @{ repo='Leonxlnx/taste-skill'; commit='f6b76575f949707b4e3c37cd86cb44b0b98643e8'; tree='8684feda2c345302dab976ae4c42ae62e04e1263'; license='MIT'; ids=@('design-taste-frontend') },
  @{ repo='cloudflare/security-audit-skill'; commit='c1c8a8c1471069fb0e188eeaff69b8e8db6564a8'; tree='8cd03bb3941496e441d6248aaae2429a35b93cc3'; license='MIT'; ids=@('security-audit') }
)

function Get-GitBlobHash([byte[]]$bytes) {
  $header = [System.Text.Encoding]::UTF8.GetBytes("blob $($bytes.Length)`0")
  $gitBytes = [byte[]]::new($header.Length + $bytes.Length)
  [Array]::Copy($header, 0, $gitBytes, 0, $header.Length)
  [Array]::Copy($bytes, 0, $gitBytes, $header.Length, $bytes.Length)
  return [Convert]::ToHexString([Security.Cryptography.SHA1]::HashData($gitBytes)).ToLowerInvariant()
}

function Get-TargetPaths($package, [string]$sourcePath) {
  if ($sourcePath -eq 'LICENSE') {
    $vendorPath = "_licenses/$($package.repo.Replace('/','-'))-LICENSE"
  } elseif ($package.repo -eq 'mattpocock/skills') {
    $match = [regex]::Match($sourcePath, '^skills/engineering/(ask-matt|tdd|diagnosing-bugs|code-review)/(.*)$')
    if (-not $match.Success) { throw "Unexpected Matt skill path: $sourcePath" }
    $vendorPath = "$($match.Groups[1].Value)/$($match.Groups[2].Value)"
  } elseif ($package.repo -eq 'Leonxlnx/taste-skill') {
    $vendorPath = 'design-taste-frontend/' + $sourcePath.Substring('skills/taste-skill/'.Length)
  } else {
    $vendorPath = 'security-audit/' + $sourcePath.Substring('skills/security-audit/'.Length)
  }
  return @{ vendor_path="vendor/skills/$vendorPath"; project_path=".tyrant/skills/$vendorPath" }
}

function Test-SelectedSourcePath($package, [string]$path) {
  if ($path -eq 'LICENSE') { return $true }
  if ($package.repo -eq 'mattpocock/skills') { return $path -match '^skills/engineering/(ask-matt|tdd|diagnosing-bugs|code-review)/' }
  if ($package.repo -eq 'Leonxlnx/taste-skill') {
    return $path -match '^skills/taste-skill/'
  }
  if ($package.repo -eq 'cloudflare/security-audit-skill') { return $path -match '^skills/security-audit/' }
  return $false
}

$manifestPackages = @()
$manifestFiles = @()
foreach ($package in $packages) {
  $headers = @{ 'User-Agent'='Tyrant-Engine-Spec06' }
  $commitInfo = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$($package.repo)/commits/$($package.commit)"
  if ($commitInfo.sha -ne $package.commit -or $commitInfo.commit.tree.sha -ne $package.tree) {
    throw "Pinned commit/tree mismatch: $($package.repo)"
  }
  $tree = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$($package.repo)/git/trees/$($package.tree)?recursive=1"
  if ($tree.sha -ne $package.tree -or $tree.truncated) { throw "Pinned tree unavailable or truncated: $($package.repo)" }
  $selected = @($tree.tree | Where-Object { $_.type -eq 'blob' -and (Test-SelectedSourcePath $package $_.path) })
  if ($selected.Count -eq 0) { throw "Empty pinned skill package: $($package.repo)" }

  $archivePath = Join-Path ([System.IO.Path]::GetTempPath()) ("tyrant-skill-" + [guid]::NewGuid().ToString('N') + '.zip')
  Invoke-WebRequest -Headers $headers -Uri "https://codeload.github.com/$($package.repo)/zip/$($package.commit)" -OutFile $archivePath
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $found = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($entry in $selected) {
      $sourcePath = [string]$entry.path
      $matches = @($archive.Entries | Where-Object { $_.FullName.EndsWith('/' + $sourcePath, [System.StringComparison]::Ordinal) })
      if ($matches.Count -ne 1) { throw "Expected one archive entry for $($package.repo):$sourcePath" }
      $memory = [System.IO.MemoryStream]::new()
      try {
        $stream = $matches[0].Open()
        try { $stream.CopyTo($memory) } finally { $stream.Dispose() }
        $bytes = $memory.ToArray()
      } finally {
        $memory.Dispose()
      }
      $gitBlobHash = Get-GitBlobHash $bytes
      if ($gitBlobHash -ne $entry.sha) { throw "Git blob hash mismatch: $($package.repo):$sourcePath" }
      $sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
      $targets = Get-TargetPaths $package $sourcePath
      $record = [ordered]@{
        source_path=$sourcePath; vendor_path=$targets.vendor_path; project_path=$targets.project_path
        git_blob_sha=$gitBlobHash; sha256=$sha256; size=$bytes.Length
      }
      $manifestFiles += $record
      $target = Join-Path $repositoryRoot ($targets.vendor_path.Replace('/', '\'))
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      [System.IO.File]::WriteAllBytes($target, $bytes)
      [void]$found.Add($sourcePath)
    }
    if ($found.Count -ne $selected.Count) { throw "Archive path coverage mismatch: $($package.repo)" }
  } finally {
    $archive.Dispose()
  }
  $manifestPackages += [ordered]@{
    repository="https://github.com/$($package.repo)"; commit=$package.commit; tree_sha=$package.tree
    license=$package.license; skill_ids=$package.ids
  }
  Write-Output "$($package.repo): verified $($selected.Count) pinned files"
}

$manifest = [ordered]@{ schema_version=1; packages=$manifestPackages; files=$manifestFiles }
$manifestBytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($manifest | ConvertTo-Json -Depth 10))
[System.IO.File]::WriteAllBytes((Join-Path $vendorRoot 'manifest.json'), $manifestBytes)
$totalBytes = 0L
foreach ($file in $manifestFiles) { $totalBytes += [long]$file.size }
Write-Output "Total vendored files: $($manifestFiles.Count); bytes: $totalBytes"
