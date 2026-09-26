@echo off
rem ============================================================================
rem Pocket Bridge - one-click setup
rem
rem IMPORTANT: keep this file ASCII-only and CRLF-terminated.
rem cmd.exe reads .bat/.cmd using the OEM code page, so non-ASCII comments turn
rem into garbage and break parsing. Chinese text lives in the .vbs launcher.
rem
rem %~dp0 works because this file sits IN the project folder.
rem
rem ORDER MATTERS: start the gateway BEFORE the self-check.
rem First run generates the access key; checking before that shows a wall of
rem auth failures (/k/null - 403) that looks like a broken install.
rem That mistake was made once - setup used to check first and scared people.
rem ============================================================================

setlocal
for %%I in ("%~dp0..") do set "BASE=%%~fI\"
set "NODE_EXE="

for /d %%D in ("%BASE%runtime\node-*") do (
    if exist "%%~fD\node.exe" set "NODE_EXE=%%~fD\node.exe"
)
if not defined NODE_EXE (
    for /d %%D in ("%BASE%runtime\node-*") do (
        if exist "%%~fD\bin\node.exe" set "NODE_EXE=%%~fD\bin\node.exe"
    )
)
if not defined NODE_EXE (
    where node >nul 2>nul
    if not errorlevel 1 set "NODE_EXE=node"
)

echo.
echo ============================================================
echo   Pocket Bridge - setup
echo ============================================================
echo.

if not defined NODE_EXE (
    echo [X] No Node runtime found.
    echo     The runtime\ folder should be inside this package.
    echo     If you deleted it, install Node.js 18+ from nodejs.org
    echo     and run this script again.
    echo.
    pause
    exit /b 1
)

echo [1/4] Node runtime
echo       %NODE_EXE%
"%NODE_EXE%" --version
if errorlevel 1 (
    echo [X] The Node runtime does not run. The package may be damaged.
    pause
    exit /b 1
)
echo.

echo [2/4] Building desktop client + shortcuts
"%NODE_EXE%" "%BASE%desktop\build.js"
if errorlevel 1 (
    echo [X] Desktop build failed. Setup stopped before starting the gateway.
    exit /b 1
)
"%NODE_EXE%" "%BASE%desktop\install-shortcut.js"
if errorlevel 1 (
    echo [X] Shortcut setup failed. Setup stopped before starting the gateway.
    exit /b 1
)
echo.

echo [3/4] Starting the service
echo       first run generates your access key - a few seconds
echo.
start "" /b "%NODE_EXE%" "%BASE%scripts\gateway-daemon.js"
timeout /t 12 /nobreak >nul
echo.

echo [4/4] Checking everything works
echo.
"%NODE_EXE%" "%BASE%scripts\self-check.js" %*
echo.
echo ------------------------------------------------------------
echo   How to read the result above:
echo.
echo     [OK]    that part works
echo     [FAIL]  that part does not. If it mentions DSH or Codex,
echo             it just means you do not have that one installed -
echo             everything else can still work.
echo     [WARN]  works, but worth a look
echo ------------------------------------------------------------
echo.
pause

echo.
echo ============================================================
echo   Done.
echo.
echo   There should be a shortcut on your Desktop now.
echo   Double-click it - a tray icon appears near the clock.
echo   Left-click that icon to open the console, which shows
echo   the address your phone should open.
echo ============================================================
echo.
pause
exit /b 0
