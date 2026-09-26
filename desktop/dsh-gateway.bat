@echo off
rem PocketBridge Gateway - desktop client
rem ASCII only, CRLF only: cmd.exe reads this file in the OEM code page.
setlocal
set "HERE=%~dp0"
start "" wscript.exe "%HERE%launch-tray.vbs"
exit /b 0
