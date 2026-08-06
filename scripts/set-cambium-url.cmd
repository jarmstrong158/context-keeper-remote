@echo off
REM Double-clickable wrapper for set-cambium-url.ps1.
REM
REM Exists because `npm run set-cambium` requires the repo to be the current
REM directory, and a shell that sits anywhere else fails with an npm ENOENT
REM about a missing package.json -- an error that names neither the script nor
REM the directory, so it reads as the tool being broken. %~dp0 is this file's
REM own folder, so double-clicking always resolves correctly (con-003).
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-cambium-url.ps1" %*
echo.
pause
