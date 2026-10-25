@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title AI3D Print Flow - Create Desktop Shortcut

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-shortcut.ps1" -PackageRoot "%~dp0"

echo.
pause
