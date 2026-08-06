@echo off
REM Double-clickable. Makes `git push` deploy the Worker -- no API token, no
REM GitHub secret, no dashboard. %~dp0 resolves from any directory (con-003).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-deploy-hook.ps1" %*
echo.
pause
