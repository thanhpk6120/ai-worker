@echo off
title AI Worker Server Dashboard
color 0A

echo ========================================================================
echo         AI WORKER - AUTONOMOUS MULTI-AGENT PIPELINE SERVER
echo ========================================================================
echo.
echo [*] Starting AI Worker Server...
echo [*] Workspace: D:\Thanhpk\AI\ai-worker
echo.

cd /d "D:\Thanhpk\AI\ai-worker"

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
echo [*] Opening Web UI Dashboard at http://localhost:3000...
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

echo.
echo [*] Server is running on port 3000...
echo [*] Press Ctrl + C to stop the server.
echo.

%NODE_CMD% src/index.js

if %errorlevel% neq 0 (
    echo.
    echo [WARNING] Server stopped with error!
    pause
)
