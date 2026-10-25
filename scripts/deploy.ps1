param(
  [switch]$NoStart,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# Read the version from package.json so the banner can never drift from it.
$appVersion = ''
try {
  $pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  $appVersion = $pkg.version
} catch {}

Write-Host ''
Write-Host "  AI3D Print Flow $appVersion - first deployment" -ForegroundColor Cyan
Write-Host '  Local image -> Qwen-Image -> TRELLIS.2 -> watertight STL' -ForegroundColor DarkGray
Write-Host ''

$node = Join-Path $root 'runtime\node.exe'
$launcher = Join-Path $root 'AI3D-Print-Flow.exe'
if (-not (Test-Path $node)) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    Write-Host '  Node.js runtime was not found.' -ForegroundColor Red
    Write-Host '  The package should contain runtime\node.exe. Re-extract the ZIP, or install Node.js 20+.' -ForegroundColor Yellow
    Read-Host 'Press Enter to close'
    exit 1
  }
  $node = $nodeCommand.Source
}

Write-Host "  Node: $node" -ForegroundColor DarkGray
Write-Host "  Root: $root" -ForegroundColor DarkGray

$dirs = @(
  'config', 'logs', 'workspace', 'workspace\input', 'workspace\glb',
  'workspace\stl', 'workspace\reports', 'workflows'
)
foreach ($dir in $dirs) {
  $full = Join-Path $root $dir
  if (-not (Test-Path $full)) { New-Item -ItemType Directory -Path $full -Force | Out-Null }
}

$configPath = Join-Path $root 'config\config.json'
$defaultConfig = Join-Path $root 'config\default.json'
if (-not (Test-Path $configPath) -and (Test-Path $defaultConfig)) {
  Copy-Item -LiteralPath $defaultConfig -Destination $configPath
  Write-Host '  Created config\config.json from defaults.' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '  Checking this PC...' -ForegroundColor Cyan
Write-Host ''
& $node (Join-Path $root 'app\cli.mjs') check
Write-Host ''

if ($NoStart) {
  Write-Host '  Check finished. Start later with AI3D-Print-Flow.exe.' -ForegroundColor Green
  exit 0
}

Write-Host '  Opening the local console in your browser...' -ForegroundColor Cyan
Write-Host '  Keep this window open while you work. Press Ctrl+C to stop.' -ForegroundColor DarkGray
Write-Host ''

if (Test-Path -LiteralPath $launcher) {
  $launcherArgs = @('start', '--deploy')
  if ($NoOpen) { $launcherArgs += '--no-open' }
  & $launcher @launcherArgs
} else {
  $serverArgs = @((Join-Path $root 'app\server.mjs'), '--deploy')
  if ($NoOpen) { $serverArgs += '--no-open' }
  & $node @serverArgs
}

if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1073741510) {
  Write-Host ''
  Write-Host "  Server exited with code $LASTEXITCODE." -ForegroundColor Red
  Read-Host 'Press Enter to close'
}
