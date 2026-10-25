@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if exist "%~dp0AI3D-Print-Flow.exe" (
  "%~dp0AI3D-Print-Flow.exe" %*
  exit /b %errorlevel%
)

title AI3D Print Flow - Keep this window open
echo.
echo  AI3D-Print-Flow.exe was not found; falling back to the bundled Node runtime.
echo  Keep this window open while using the console.
echo.
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0app\server.mjs" %*
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo Node.js runtime was not found.
    echo Run deploy.cmd first, or install Node.js 20 or newer.
    echo.
    pause
    exit /b 1
  )
  node "%~dp0app\server.mjs" %*
)
if errorlevel 1 pause