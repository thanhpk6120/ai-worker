@echo off
title Dung AI Worker Server
color 0C

echo ========================================================================
echo         AI WORKER - STOPPING BACKGROUND SERVER
echo ========================================================================
echo.
cd /d "%~dp0"

set "NODE_CMD=node"
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\fnm.exe" (
        set NODE_CMD="%LOCALAPPDATA%\Microsoft\WinGet\Links\fnm.exe" exec --using=default -- node
    ) else if exist "%USERPROFILE%\AppData\Local\Microsoft\WinGet\Links\fnm.exe" (
        set NODE_CMD="%USERPROFILE%\AppData\Local\Microsoft\WinGet\Links\fnm.exe" exec --using=default -- node
    )
)

%NODE_CMD% "%~dp0scripts\worker-control.js" stop

echo.
echo [OK] AI Worker Server da duoc dung hoan toan.
echo Cua so se tu dong dong sau 2 giay...
ping -n 3 127.0.0.1 >nul
exit /b 0
