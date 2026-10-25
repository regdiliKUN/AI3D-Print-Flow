param(
  [string]$ZipPath = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path (Split-Path -Parent $root) 'release'
if (-not $ZipPath) {
  $latest = Get-ChildItem -LiteralPath $release -Filter 'AI3D-Print-Flow-v*-win-x64.zip' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $latest) { throw "No package ZIP found in $release." }
  $ZipPath = $latest.FullName
}
$ZipPath = (Resolve-Path -LiteralPath $ZipPath).Path
$stage = Join-Path $env:TEMP "ai3d-verify-$PID"
$proc = $null
$oldPort = $env:AI3D_PORT
$oldNoOpen = $env:AI3D_NO_OPEN
$oldNoSave = $env:AI3D_NO_SAVE_PORT

try {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  Write-Host "Extracting $ZipPath ..." -ForegroundColor Cyan
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $stage -Force

  $required = @(
    'AI3D-Print-Flow.exe',
    'start.cmd',
    'deploy.cmd',
    'app\server.mjs',
    'app\cli.mjs',
    'app\public\index.html',
    'app\public\app.js',
    'app\public\style.css',
    'config\default.json',
    'config\config.json',
    'runtime\node.exe',
    'PACKAGE_INFO.json',
    'README.md',
    'docs'
  )
  foreach ($rel in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $rel))) { throw "Missing from package: $rel" }
  }
  if (Test-Path -LiteralPath (Join-Path $stage 'config\config.json.bak')) { throw 'config.json.bak must not be packaged.' }
  if (Get-ChildItem -LiteralPath $stage -Recurse -File -Filter '*.corrupt-*' -ErrorAction SilentlyContinue) {
    throw 'Damaged config files must not be packaged.'
  }

  $info = Get-Content -LiteralPath (Join-Path $stage 'PACKAGE_INFO.json') -Raw | ConvertFrom-Json
  if (-not $info.version) { throw 'PACKAGE_INFO.json has no version.' }
  if ([string]$info.entry -ne 'AI3D-Print-Flow.exe') { throw 'PACKAGE_INFO.json entry must be AI3D-Print-Flow.exe.' }
  $launcherExe = Join-Path $stage 'AI3D-Print-Flow.exe'
  $launcherVersion = (& $launcherExe --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Packaged launcher --version failed: $launcherVersion" }
  if ($launcherVersion -ne [string]$info.version) {
    throw "Packaged launcher version '$launcherVersion' does not match manifest $($info.version)."
  }
  $nodeExe = Join-Path $stage 'runtime\node.exe'
  $nodeCheck = & $nodeExe --check (Join-Path $stage 'app\server.mjs') 2>&1
  if ($LASTEXITCODE -ne 0) { throw "runtime node --check failed: $nodeCheck" }

  $hashFile = "$ZipPath.sha256"
  if (Test-Path -LiteralPath $hashFile) {
    $expected = ((Get-Content -LiteralPath $hashFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw 'SHA256 file does not match the ZIP.' }
  }

  $port = Get-Random -Minimum 18100 -Maximum 18999
  $env:AI3D_PORT = [string]$port
  $env:AI3D_NO_OPEN = '1'
  $env:AI3D_NO_SAVE_PORT = '1'

  # Start-Process builds a case-sensitive dictionary from the environment in
  # PowerShell 5.1, so a process that has both HTTPS_PROXY and https_proxy
  # fails with "key already added" before the server even starts. Using
  # ProcessStartInfo inherits the environment directly and also removes the
  # need to parse the startup banner for the URL.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $nodeExe
  $psi.Arguments = 'app/server.mjs --no-open'
  $psi.WorkingDirectory = $stage
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $null = $proc.Start()
  # Drain stdout continuously, otherwise the pipe buffer fills and the server blocks.
  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()

  $base = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 300
    foreach ($candidate in @($port, ($port + 1), ($port + 2))) {
      try {
        $probe = Invoke-RestMethod -Uri "http://127.0.0.1:$candidate/api/health" -TimeoutSec 2
        if ($probe.app -eq 'ai3d-print-flow') {
          $base = "http://127.0.0.1:$candidate"
          break
        }
      } catch {}
    }
    if ($base) { break }
    if ($proc.HasExited) {
      $err = $proc.StandardError.ReadToEnd()
      throw "Packaged server exited early (code $($proc.ExitCode)): $err"
    }
  }
  if (-not $base) { throw 'Packaged server did not become reachable on /api/health.' }

  $health = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 10
  if (-not $health.ok) { throw 'Health endpoint did not return ok.' }
  if ($health.app -ne 'ai3d-print-flow') { throw 'Health endpoint did not identify the app.' }
  if ([string]$health.version -ne [string]$info.version) {
    throw "Health version $($health.version) does not match manifest $($info.version)."
  }

  $page = Invoke-WebRequest -Uri "$base/" -UseBasicParsing -TimeoutSec 15
  if ($page.StatusCode -ne 200) { throw 'Static index did not return 200.' }
  $csp = [string]$page.Headers['Content-Security-Policy']
  if ($csp -notmatch "default-src 'self'") { throw 'CSP header is missing.' }
  if ($csp -notmatch "form-action 'self'") { throw 'CSP form-action is missing.' }
  if ([string]$page.Headers['X-Content-Type-Options'] -ne 'nosniff') { throw 'nosniff header is missing.' }
  if ([string]$page.Headers['Permissions-Policy'] -notmatch 'camera=\(\)') { throw 'Permissions-Policy header is missing.' }

  $script = Invoke-WebRequest -Uri "$base/app.js" -UseBasicParsing -TimeoutSec 15
  if ($script.StatusCode -ne 200 -or -not $script.Content -or $script.Content.Length -lt 1000) { throw 'Static app.js is missing or empty.' }

  $originRejected = $false
  try {
    Invoke-WebRequest -Uri "$base/api/action" -Method Post -ContentType 'application/json' `
      -Headers @{ Origin = 'http://evil.example' } -Body '{"action":"app.info"}' `
      -UseBasicParsing -TimeoutSec 10 | Out-Null
  } catch {
    $code = 0
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -ne 403) { throw "Malicious Origin should be 403, got $code." }
    $originRejected = $true
  }
  if (-not $originRejected) { throw 'Malicious Origin was not rejected.' }

  $wrongTypeRejected = $false
  try {
    Invoke-WebRequest -Uri "$base/api/action" -Method Post -ContentType 'text/plain' `
      -Body '{"action":"app.info"}' -UseBasicParsing -TimeoutSec 10 | Out-Null
  } catch {
    $code = 0
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -ne 415) { throw "text/plain should be 415, got $code." }
    $wrongTypeRejected = $true
  }
  if (-not $wrongTypeRejected) { throw 'text/plain request was not rejected.' }

  $infoResponse = Invoke-RestMethod -Uri "$base/api/action" -Method Post -ContentType 'application/json' `
    -Body '{"action":"app.info"}' -TimeoutSec 15
  if (-not $infoResponse.ok -or [string]$infoResponse.version -ne [string]$info.version) {
    throw 'app.info response did not match the manifest version.'
  }

  $diagnostics = Invoke-RestMethod -Uri "$base/api/diagnostics" -TimeoutSec 15
  if (-not $diagnostics.ok -or -not $diagnostics.paths -or -not $diagnostics.log) {
    throw 'Diagnostics endpoint returned an incomplete payload.'
  }

  $workspaceFiles = Get-ChildItem -LiteralPath (Join-Path $stage 'workspace') -Recurse -File -ErrorAction SilentlyContinue
  if ($workspaceFiles) { throw 'workspace/ must not contain user files in the package.' }

  Write-Host ""
  Write-Host "Package verification OK" -ForegroundColor Green
  Write-Host "  ZIP:     $ZipPath" -ForegroundColor DarkGray
  Write-Host "  Version: $($info.version)" -ForegroundColor DarkGray
  Write-Host "  Server:  $base" -ForegroundColor DarkGray
  Write-Host "  Checks:  health, CSP, diagnostics, app.info, Origin 403, Content-Type 415, empty workspace" -ForegroundColor DarkGray
}
finally {
  if ($proc -and -not $proc.HasExited) {
    & taskkill.exe /PID $proc.Id /T /F *> $null
    Start-Sleep -Milliseconds 300
  }
  $env:AI3D_PORT = $oldPort
  $env:AI3D_NO_OPEN = $oldNoOpen
  $env:AI3D_NO_SAVE_PORT = $oldNoSave
  if (Test-Path -LiteralPath $stage) {
    try { Remove-Item -LiteralPath $stage -Recurse -Force } catch {}
  }
}
