@echo off
powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File "%~dp0windows-setup.ps1" -Step 3
set "WHALE_STEP_EXIT=%ERRORLEVEL%"
pause
exit /b %WHALE_STEP_EXIT%
