@echo off
rem ============================================================================
rem PocketBridge Gateway - Windows launcher
rem
rem All real logic lives in gateway-daemon.js, shared by every platform.
rem This file only locates a Node runtime and calls it.
rem
rem Placed in the Startup folder for auto-run at logon; can also be run manually.
rem Safe to run repeatedly - services that are already running are skipped.
rem
rem IMPORTANT: keep this file ASCII-only and CRLF-terminated.
rem cmd.exe reads .bat files using the OEM code page, so non-ASCII comments
rem turn into garbage and break parsing (that mistake was made once already).
rem ============================================================================

setlocal
set "BASE=%~dp0.."
set "NODE_EXE="

rem Prefer the bundled standalone Node. Using DSH's own Electron would tie the
rem gateway's lifetime to DSH's - closing DSH would kill the gateway too.
for /d %%D in ("%BASE%\runtime\node-*") do (
    if exist "%%~fD\node.exe" set "NODE_EXE=%%~fD\node.exe"
)
if not defined NODE_EXE (
    for /d %%D in ("%BASE%\runtime\node-*") do (
        if exist "%%~fD\bin\node.exe" set "NODE_EXE=%%~fD\bin\node.exe"
    )
)

rem Fall back to a system Node on PATH.
if not defined NODE_EXE (
    where node >nul 2>nul
    if not errorlevel 1 set "NODE_EXE=node"
)

if not defined NODE_EXE (
    echo [DSH Gateway] No Node runtime found.
    echo                Check that %BASE%\runtime\ is intact, or install Node.js.
    exit /b 1
)

"%NODE_EXE%" "%BASE%\scripts\gateway-daemon.js" %*
exit /b %ERRORLEVEL%
