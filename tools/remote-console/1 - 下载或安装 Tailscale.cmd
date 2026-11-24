@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows-setup.ps1" -Step 1
if errorlevel 1 pause
