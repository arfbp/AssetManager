@echo off
REM Double-click this file. It will ask for Administrator permission once
REM (a Windows security requirement for installing any service - cannot be
REM skipped) then install and start the OptiFleet AI Agent automatically.

net session >nul 2>&1
if %errorlevel% == 0 goto :run

echo Requesting Administrator permission...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:run
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
