@echo off
rem PocketBridge - fix the LAN firewall rule (needs admin)
rem
rem Why this exists: renaming the project also renamed the firewall rule,
rem and renaming a firewall rule requires administrator rights. This asks for
rem elevation once, then reconciles everything: it removes the rules left over
rem from the old project name and from the abandoned Caddy setup, and creates
rem the current rule. Running it twice is harmless.
setlocal
set "HERE=%~dp0"
set "PS1=%HERE%..\scripts\enable-lan-access.ps1"

net session >nul 2>&1
if %errorlevel%==0 goto run

echo Requesting administrator rights...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%PS1%'"
goto :eof

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
echo.
pause
