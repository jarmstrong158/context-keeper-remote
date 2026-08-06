@echo off
REM Double-clickable: connects the Knowledge tab to cambium-remote in one run.
REM Nothing to look up, nothing to paste.
REM
REM %~dp0 resolves to this file's own folder, so it works from any current
REM directory -- unlike `npm run`, which needs the repo as cwd and otherwise
REM fails with an npm ENOENT that names neither the script nor the folder
REM (con-003).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0connect-cambium.ps1" %*
echo.
pause
