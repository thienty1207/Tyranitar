$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$installer = Join-Path $repositoryRoot 'installers\install.ps1'
. $installer -LibraryOnly

function Assert-Equal($actual, $expected, $label) {
  if ($actual -ne $expected) { throw "${label}: expected '$expected', got '$actual'" }
}
function Assert-Throws([scriptblock]$action, [string]$expectedMessage, [string]$label) {
  try { & $action; throw "${label}: expected exception '$expectedMessage'" }
  catch { if ($_.Exception.Message -notlike "*$expectedMessage*") { throw } }
}

$digest = 'a' * 64
$release = [pscustomobject]@{
  tag_name = 'v0.1.1'
  draft = $false
  prerelease = $false
  assets = @([pscustomobject]@{
    name = 'tyrant-engine-0.1.1-windows-x64.zip'
    browser_download_url = 'https://github.com/thienty1207/Tyranitar/releases/download/v0.1.1/tyrant-engine-0.1.1-windows-x64.zip'
    digest = "sha256:$digest"
    state = 'uploaded'
  })
}
$asset = Get-TyrantReleaseAsset $release
Assert-Equal $asset.version '0.1.1' 'version'
Assert-Equal $asset.sha256 $digest 'digest'
Assert-Equal (Test-TyrantArchiveEntry 'src/index.ts') $true 'safe path'
Assert-Equal (Test-TyrantArchiveEntry '../outside') $false 'traversal path'
$draft = [pscustomobject]@{ tag_name = $release.tag_name; draft = $true; prerelease = $false; assets = $release.assets }
Assert-Throws { Get-TyrantReleaseAsset $draft } 'release_not_published' 'draft release'

Write-Output 'Installer contract checks passed.'
