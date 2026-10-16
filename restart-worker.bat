@echo off
REM restart-worker.bat - Restart ai-worker tren port 3000
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set PORT=3000
set LOGFILE=logs\server-bg.log
if not exist logs mkdir logs

echo [1/4] Tim PID giu port %PORT% ...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
  echo Kill PID %%P ...
  taskkill /F /PID %%P >nul 2>&1
)

echo [2/4] Cho port %PORT% tu do ...
for /L %%i in (1,1,15) do (
  netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
  if errorlevel 1 goto PORTFREE
  timeout /t 1 /nobreak >nul
)
:PORTFREE
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo Loi: port %PORT% van ban. Thoat.
  exit /b 1
)
echo Port %PORT% da tu do.

echo [3/4] Start nen: node src/index.js ...
start "" /MIN cmd /c "node src/index.js >> %LOGFILE% 2>&1"
timeout /t 3 /nobreak >nul

echo [4/4] Kiem tra /api/v1/status ...
curl -s -o nul -w "HTTP %%{http_code}\n" http://localhost:%PORT%/api/v1/status
if errorlevel 1 (
  echo Loi: server chua phan hoi. Xem %LOGFILE%.
  exit /b 1
)
echo Xong.
endlocal
