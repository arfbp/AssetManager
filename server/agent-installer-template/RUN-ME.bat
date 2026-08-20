@echo off
REM ดับเบิลคลิกไฟล์นี้ มันจะขอสิทธิ์ Administrator หนึ่งครั้ง (ข้อกำหนดด้าน
REM ความปลอดภัยของ Windows สำหรับการติดตั้ง service ใดๆ ข้ามไม่ได้)
REM จากนั้นจะติดตั้งและสตาร์ต OptiFleet AI Agent ให้อัตโนมัติ

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
