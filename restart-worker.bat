@echo off
REM restart-worker.bat - Restart ai-worker tren port 3000
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set PORT=3000
set LOGFILE=logs\server-bg.log
if not exist logs mkdir logs

set "NODE_CMD=node"
where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\fnm.exe" (
        set NODE_CMD="%LOCALAPPDATA%\Microsoft\WinGet\Links\fnm.exe" exec --using=default -- node
    ) else if exist "%USERPROFILE%\AppData\Local\Microsoft\WinGet\Links\fnm.exe" (
        set NODE_CMD="%USERPROFILE%\AppData\Local\Microsoft\WinGet\Links\fnm.exe" exec --using=default -- node
    )
)

echo [1/3] Xoa bien moi truong ke thua tu shell...
call "%~dp0clear-systemone-env.bat"

echo [2/3] Khoi dong lai AI Worker Server...
%NODE_CMD% "%~dp0scripts\worker-control.js" restart
if errorlevel 1 (
  echo Loi: khong restart duoc worker. Xem %LOGFILE%.
  exit /b 1
)

echo [3/3] Kiem tra /api/v1/status ...
curl -s -o nul -w "HTTP %%{http_code}\n" http://localhost:%PORT%/api/v1/status
if errorlevel 1 (
  echo Loi: server chua phan hoi. Xem %LOGFILE%.
  exit /b 1
)
echo Xong.
endlocal
