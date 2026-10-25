@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title AI3D Print Flow - First Deployment

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy.ps1" %*

if errorlevel 1 pause
