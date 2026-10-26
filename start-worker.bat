@echo off
title AI Worker Server Dashboard
color 0A

echo ========================================================================
echo         AI WORKER - AUTONOMOUS MULTI-AGENT PIPELINE SERVER
echo ========================================================================
echo.
echo [*] Starting AI Worker Server...
set "PROJECT_ROOT=%~dp0"
cd /d "%PROJECT_ROOT%"
echo [*] Thư mục làm việc: %PROJECT_ROOT%
echo.
set "NODE_CMD=node"
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\fnm.exe" (
        set NODE_CMD="%LOCALAPPDATA%\Microsoft\WinGet\Links\fnm.exe" exec --using=default -- node
    ) else if exist "%USERPROFILE%\AppData\Local\Microsoft\WinGet\Links\fnm.exe" (
        set NODE_CMD="%USERPROFILE%\AppData\Local\Microsoft\WinGet\Links\fnm.exe" exec --using=default -- node
    )
)

echo [*] Checking Node.js runtime...
%NODE_CMD% -v >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not found in PATH or fnm!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

echo [*] Node.js runtime ready!
echo [*] Khoi dong AI Worker chay ngam (Headless Background Daemon)...
call "%~dp0clear-systemone-env.bat"
%NODE_CMD% "%~dp0scripts\worker-control.js" start

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Khong the khoi dong worker. Xem logs\server-bg.log de biet chi tiet.
    pause
    exit /b 1
)

echo.
echo ========================================================================
echo [OK] AI Worker Server da khoi dong thanh cong o che do chay ngam!
echo      - Khong co cua so terminal nao bi chiem hay ngáng man hinh.
echo      - Xem toan bo logs truc tiep tren Web Dashboard tai nut [Worker Logs].
echo      - De dung worker bat cu luc nao: chay file stop-worker.bat.
echo ========================================================================
echo.
echo [*] Dang mo Web UI Dashboard tai http://localhost:3000...
start http://localhost:3000

echo [*] Cua so nay se tu dong dong sau 2 giay...
ping -n 3 127.0.0.1 >nul
exit /b 0
