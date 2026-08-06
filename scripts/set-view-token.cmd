@echo off
REM Double-clickable wrapper for set-view-token.ps1.
REM
REM -NoProfile so a slow or noisy PowerShell profile cannot interfere, and
REM -ExecutionPolicy Bypass scoped to THIS process only -- it changes nothing
REM about the machine's policy, which a setup script has no business touching.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-view-token.ps1" %*
echo.
pause
