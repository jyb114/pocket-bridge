@echo off
rem ============================================================================
rem PocketBridge Gateway - open the desktop console
rem
rem Double-click this to see service status, access URLs and QR codes
rem without typing any command.
rem
rem IMPORTANT: keep this file ASCII-only and CRLF-terminated.
rem cmd.exe reads .bat files using the OEM code page, so non-ASCII comments
rem turn into garbage and break parsing.
rem ============================================================================

setlocal
set "BASE=%~dp0.."
set "NODE_EXE="

for /d %%D in ("%BASE%\runtime\node-*") do (
    if exist "%%~fD\node.exe" set "NODE_EXE=%%~fD\node.exe"
)
if not defined NODE_EXE (
    for /d %%D in ("%BASE%\runtime\node-*") do (
        if exist "%%~fD\bin\node.exe" set "NODE_EXE=%%~fD\bin\node.exe"
    )
)
if not defined NODE_EXE (
    where node >nul 2>nul
    if not errorlevel 1 set "NODE_EXE=node"
)

if not defined NODE_EXE (
    echo [DSH Gateway] No Node runtime found.
    echo                Check that %BASE%\runtime\ is intact, or install Node.js.
    pause
    exit /b 1
)

"%NODE_EXE%" "%BASE%\scripts\open-console.js"
pause
exit /b %ERRORLEVEL%
