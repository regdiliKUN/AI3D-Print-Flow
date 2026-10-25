param(
  [string]$PackageRoot = '',
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
if (-not $PackageRoot) {
  $PackageRoot = Split-Path -Parent $PSScriptRoot
}
$PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path

$packageJsonPath = Join-Path $PackageRoot 'package.json'
if (-not (Test-Path -LiteralPath $packageJsonPath)) {
  throw "package.json not found: $packageJsonPath"
}
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
if (-not $Version) { $Version = [string]$packageJson.version }
if (-not $Version) { throw 'Could not read version from package.json.' }

$source = Join-Path $PackageRoot 'launcher\Program.cs'
if (-not (Test-Path -LiteralPath $source)) {
  throw "Launcher source not found: $source"
}

$csc = @(
  'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
  'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
  throw 'C# compiler (csc.exe from .NET Framework 4.x) was not found. Install .NET Framework 4.8 or run start.cmd as a fallback.'
}

# Assembly metadata is generated from package.json so Explorer shows the same
# version as the web UI without maintaining a second hard-coded number.
$versionParts = @(($Version -replace '[^0-9.]', '').Split('.') | Where-Object { $_ -ne '' })
while ($versionParts.Count -lt 4) { $versionParts += '0' }
$assemblyVersion = ($versionParts[0..3] -join '.')

$tempName = ".ai3d-launcher-$PID"
$tempSource = Join-Path $PackageRoot "$tempName.cs"
$tempExe = Join-Path $PackageRoot "$tempName.exe"
$output = Join-Path $PackageRoot 'AI3D-Print-Flow.exe'
$icon = Join-Path $PackageRoot 'app\public\icon.ico'

$assemblyInfo = @"
using System.Reflection;
[assembly: AssemblyTitle("AI3D Print Flow")]
[assembly: AssemblyDescription("AI3D Print Flow 本地启动器")]
[assembly: AssemblyProduct("AI3D Print Flow")]
[assembly: AssemblyCompany("AI3D Print Flow")]
[assembly: AssemblyCopyright("MIT License")]
[assembly: AssemblyVersion("$assemblyVersion")]
[assembly: AssemblyFileVersion("$assemblyVersion")]
[assembly: AssemblyInformationalVersion("$Version")]
"@

try {
  [IO.File]::WriteAllText($tempSource, $assemblyInfo + "`r`n", (New-Object Text.UTF8Encoding($false)))

  Push-Location -LiteralPath $PackageRoot
  try {
    $compilerArgs = @(
      '/nologo',
      '/target:exe',
      '/platform:anycpu',
      '/optimize+',
      '/codepage:65001',
      "/out:$tempName.exe",
      '/reference:System.dll',
      'launcher\Program.cs',
      "$tempName.cs"
    )
    if (Test-Path -LiteralPath 'app\public\icon.ico') {
      $compilerArgs += '/win32icon:app\public\icon.ico'
    }
    Write-Host "Building AI3D-Print-Flow.exe ($Version)..." -ForegroundColor Cyan
    & $csc @compilerArgs
    if ($LASTEXITCODE -ne 0) { throw "csc.exe failed with code $LASTEXITCODE." }
  }
  finally {
    Pop-Location
  }

  if (-not (Test-Path -LiteralPath $tempExe)) {
    throw 'Launcher compiler did not produce an executable.'
  }
  if ((Get-Item -LiteralPath $tempExe).Length -lt 10000) {
    throw 'Launcher executable is unexpectedly small.'
  }

  try {
    Move-Item -LiteralPath $tempExe -Destination $output -Force
  } catch {
    throw "Cannot replace $output. Close any running AI3D-Print-Flow.exe and retry. $($_.Exception.Message)"
  }

  Write-Host "Launcher: $output" -ForegroundColor Green
  Write-Host "Version:  $Version" -ForegroundColor DarkGray
  if (Test-Path -LiteralPath $icon) { Write-Host "Icon:     $icon" -ForegroundColor DarkGray }
}
finally {
  foreach ($path in @($tempSource, $tempExe)) {
    if (Test-Path -LiteralPath $path) {
      try { Remove-Item -LiteralPath $path -Force } catch {}
    }
  }
}
