param(
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path (Split-Path -Parent $root) 'release'
if (-not (Test-Path -LiteralPath $release)) {
  New-Item -ItemType Directory -Path $release -Force | Out-Null
}

# package.json is the single source of truth for the version; app/lib/paths.mjs
# reads it at runtime and the UI shows it from /api/state. This script only
# verifies that everything else agrees with it.
$packageJson = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $packageJson.version }
if (-not $Version) { throw 'Could not read version from package.json.' }
if ($packageJson.version -ne $Version) {
  throw "Version mismatch: package.json is $($packageJson.version), package.ps1 requested $Version."
}
$pathsFile = Join-Path $root 'app\lib\paths.mjs'
$pathsSource = Get-Content -LiteralPath $pathsFile -Raw
if ($pathsSource -notmatch 'readFileSync\(PACKAGE_JSON') {
  throw 'app\lib\paths.mjs should read the version from package.json.'
}
$indexHtml = Get-Content -LiteralPath (Join-Path $root 'app\public\index.html') -Raw
if ($indexHtml -notmatch 'id="appVersion"') {
  throw 'app\public\index.html is missing the version placeholder (id="appVersion").'
}
if ($indexHtml -match '\?v=\d+\.\d+\.\d+') {
  throw 'app\public\index.html must not hard-code a cache-busting version.'
}
$readme = Get-Content -LiteralPath (Join-Path $root 'README.md') -Raw
if ($readme -notmatch [regex]::Escape("v$Version")) {
  throw "Version mismatch: README.md does not contain v$Version."
}

# Build the native launcher before staging. The desktop shortcut points at this
# exe, so a package without it would regress to start.cmd.
$launcherBuilder = Join-Path $root 'scripts\build-launcher.ps1'
if (-not (Test-Path -LiteralPath $launcherBuilder)) {
  throw 'scripts\build-launcher.ps1 is missing.'
}
& $launcherBuilder -PackageRoot $root -Version $Version
$launcherExe = Join-Path $root 'AI3D-Print-Flow.exe'
if (-not (Test-Path -LiteralPath $launcherExe)) {
  throw 'AI3D-Print-Flow.exe was not built.'
}

$stage = Join-Path $env:TEMP "ai3d-print-flow-$PID"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

try {
  Write-Host "Staging package $Version..." -ForegroundColor Cyan
  $excludeDirs = @(
    (Join-Path $root 'workspace'),
    (Join-Path $root 'logs'),
    (Join-Path $root 'workflows'),
    (Join-Path $root '.git'),
    (Join-Path $root 'node_modules'),
    (Join-Path $root '.vscode'),
    (Join-Path $root 'release')
  )
  $excludeFiles = @(
    'config.json',
    'config.json.bak',
    'config.json.corrupt-*',
    'config.json.tmp-*'
  )

  $robocopyArgs = @($root, $stage, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  $robocopyArgs += '/XD'
  $robocopyArgs += $excludeDirs
  $robocopyArgs += '/XF'
  $robocopyArgs += $excludeFiles
  # Never ship interrupted downloads or test uploads.
  $robocopyArgs += '/XF'
  $robocopyArgs += @('*.part', '*.part.json', '*.tmp-*', '*~')
  & robocopy @robocopyArgs | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "robocopy failed with code $LASTEXITCODE" }

  # Keep the expected empty folders and a clean config in the ZIP.
  foreach ($dir in @('workspace', 'workspace\input', 'workspace\glb', 'workspace\stl', 'workspace\reports', 'workspace\text', 'logs', 'workflows')) {
    $full = Join-Path $stage $dir
    if (-not (Test-Path -LiteralPath $full)) { New-Item -ItemType Directory -Path $full -Force | Out-Null }
  }
  $defaultConfig = Join-Path $root 'config\default.json'
  if (-not (Test-Path -LiteralPath $defaultConfig)) { throw 'config\default.json is missing.' }
  Copy-Item -LiteralPath $defaultConfig -Destination (Join-Path $stage 'config\config.json') -Force

  $nodeExe = Join-Path $stage 'runtime\node.exe'
  if (-not (Test-Path -LiteralPath $nodeExe)) { throw 'runtime\node.exe is missing from the package.' }
  $nodeVersion = (& $nodeExe --version).Trim()

  $info = [ordered]@{
    name = 'AI3D Print Flow'
    version = $Version
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
    platform = 'win-x64'
    entry = 'AI3D-Print-Flow.exe'
    launcher = 'AI3D-Print-Flow.exe'
    server = 'app/server.mjs'
    node = $nodeVersion
    packageRoot = '.'
    notes = 'Start AI3D-Print-Flow.exe (the desktop shortcut targets it). Model weights are downloaded on first deployment; they are not included.'
  }
  $infoPath = Join-Path $stage 'PACKAGE_INFO.json'
  $json = $info | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText($infoPath, $json + "`r`n", (New-Object Text.UTF8Encoding($false)))

  $zip = Join-Path $release "AI3D-Print-Flow-v$Version-win-x64.zip"
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }

  Write-Host "Compressing to $zip ..." -ForegroundColor Cyan
  # Do not use tar.exe here. Windows bsdtar writes entry names in the active ANSI
  # code page and never sets the ZIP UTF-8 flag, so non-ASCII names such as the
  # Chinese doc file names come out as mojibake on non-GBK systems (the v1.5.0
  # package had this bug). 7-Zip with -mcu writes UTF-8 names with the flag set
  # and still records the empty workspace / logs / workflows directory entries.
  $sevenZip = $null
  $sevenZipRoots = @($env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))
  foreach ($base in $sevenZipRoots) {
    if (-not $base) { continue }
    $candidate = Join-Path $base '7-Zip\7z.exe'
    if (Test-Path -LiteralPath $candidate) { $sevenZip = $candidate; break }
  }
  if (-not $sevenZip) {
    $sevenZip = (Get-Command '7z.exe' -ErrorAction SilentlyContinue).Source
  }
  if ($sevenZip) {
    Push-Location -LiteralPath $stage
    try {
      & $sevenZip a -tzip -mx=5 -mcu=on -bso0 -bsp0 $zip . | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "7-Zip failed with code $LASTEXITCODE" }
    }
    finally { Pop-Location }
  } else {
    Write-Warning '7-Zip not found; falling back to tar.exe. Non-ASCII file names may be unreadable on non-GBK systems.'
    & tar.exe -a -c -f $zip -C $stage .
    if ($LASTEXITCODE -ne 0) { throw "tar failed with code $LASTEXITCODE" }
  }

  $hash = Get-FileHash -LiteralPath $zip -Algorithm SHA256
  $hashFile = "$zip.sha256"
  "$($hash.Hash.ToLower())  $(Split-Path -Leaf $zip)" | Set-Content -LiteralPath $hashFile -Encoding ASCII

  $size = (Get-Item -LiteralPath $zip).Length
  Write-Host ""
  Write-Host "Package: $zip" -ForegroundColor Green
  Write-Host "Size:    $([Math]::Round($size / 1024 / 1024, 1)) MB" -ForegroundColor Green
  Write-Host "SHA256:  $($hash.Hash)" -ForegroundColor Green
  Write-Host "Info:    PACKAGE_INFO.json (inside the ZIP)" -ForegroundColor DarkGray
  Write-Host "Hash:    $hashFile" -ForegroundColor DarkGray
}
finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
