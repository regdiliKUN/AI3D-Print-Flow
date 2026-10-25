param(
  [string]$PackageRoot = '',
  [string]$Name = 'AI3D 打印工作流',
  [switch]$StartMenu
)

$ErrorActionPreference = 'Stop'
if (-not $PackageRoot) {
  $PackageRoot = Split-Path -Parent $PSScriptRoot
}
$PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path

$target = Join-Path $PackageRoot 'AI3D-Print-Flow.exe'
if (-not (Test-Path -LiteralPath $target)) {
  # Source checkouts may not have the generated binary yet. Build it once so a
  # shortcut can still point at the exe instead of silently falling back to a
  # .cmd file (which is exactly what this change is meant to avoid).
  $builder = Join-Path $PSScriptRoot 'build-launcher.ps1'
  if (Test-Path -LiteralPath $builder) {
    Write-Host 'AI3D-Print-Flow.exe is missing; building the launcher first...' -ForegroundColor Yellow
    & $builder -PackageRoot $PackageRoot
  }
}
if (-not (Test-Path -LiteralPath $target)) {
  throw "Launcher not found in $PackageRoot. Expected AI3D-Print-Flow.exe. Run scripts\build-launcher.ps1 first."
}

if ($StartMenu) {
  $folder = Join-Path ([Environment]::GetFolderPath('Programs')) 'AI3D Print Flow'
  if (-not (Test-Path -LiteralPath $folder)) {
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
  }
} else {
  $folder = [Environment]::GetFolderPath('Desktop')
}

$linkPath = Join-Path $folder "$Name.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = $target
$shortcut.Arguments = ''
$shortcut.WorkingDirectory = $PackageRoot
$shortcut.Description = 'AI3D Print Flow - local image to watertight STL'
$shortcut.WindowStyle = 1
$shortcut.IconLocation = "$target,0"
$shortcut.Save()

if (-not (Test-Path -LiteralPath $linkPath)) {
  throw "Shortcut was not created: $linkPath"
}

# Read the link back so a stale/cached COM object can never make this script
# report success while the desktop still points at start.cmd.
$verify = $shell.CreateShortcut($linkPath)
if ([IO.Path]::GetFullPath($verify.TargetPath) -ne [IO.Path]::GetFullPath($target)) {
  throw "Shortcut target verification failed: $($verify.TargetPath)"
}

Write-Host "Shortcut created: $linkPath" -ForegroundColor Green
Write-Host "Target: $target" -ForegroundColor DarkGray
Write-Host "Arguments: (none)" -ForegroundColor DarkGray
Write-Host "Package folder: $PackageRoot" -ForegroundColor DarkGray
Write-Host "Right-click the shortcut -> Open file location opens the package folder above." -ForegroundColor DarkGray
