@echo off
REM Double-clickable. Repairs cambium-remote's GitHub Actions deploy, whose two
REM Cloudflare secrets are empty so every merge there looks green and deploys
REM nothing. %~dp0 resolves from any current directory (con-003).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-cambium-ci.ps1" %*
echo.
pause
