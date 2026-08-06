@echo off
REM Double-clickable wrapper for set-view-token.ps1. Double-click it and the
REM whole job is done: token generated, installed, route verified, view opened.
REM
REM -NoProfile so a slow or noisy PowerShell profile cannot interfere, and
REM -ExecutionPolicy Bypass scoped to THIS process only -- it changes nothing
REM about the machine's policy, which a setup script has no business touching.
REM
REM `powershell` is Windows PowerShell 5.1, which is what set-view-token.ps1 is
REM written against. Do not "modernise" this to `pwsh`: 5.1 is the one that is
REM guaranteed present, and the script already avoids every 7-only construct.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-view-token.ps1" %*
echo.
pause
