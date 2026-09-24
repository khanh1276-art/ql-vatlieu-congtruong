@echo off
title Quan Ly Kho Vat Lieu Cong Truong
cd /d "%~dp0"

echo ========================================================
echo   PHAN MEM XUAT NHAP KHO VAT LIEU XAY DUNG CONG TRUONG
echo   Dang khoi chay may chu tai: http://localhost:3000
echo ========================================================
echo.

set "NODE22_EXE=C:\Users\Khanh\AppData\Local\Logi\LogiPluginService\PluginHosts\node22\node\node.exe"
set ELECTRON_RUN_AS_NODE=1
set "AGY_EXE=C:\Users\Khanh\AppData\Local\Programs\antigravity\Antigravity.exe"
set "AGY_NODE=C:\Users\Khanh\AppData\Roaming\Antigravity\bin\agy-node.cmd"

echo [1/2] Dang mo trinh duyet...
start "" "http://localhost:3000"

echo [2/2] Dang chay he thong du lieu...
if exist "%NODE22_EXE%" (
    "%NODE22_EXE%" "%~dp0src\server.js"
) else if exist "%AGY_EXE%" (
    "%AGY_EXE%" "%~dp0src\server.js"
) else if exist "%AGY_NODE%" (
    call "%AGY_NODE%" "%~dp0src\server.js"
) else (
    node "%~dp0src\server.js"
)

echo.
echo ========================================================
echo May chu da dung.
pause
