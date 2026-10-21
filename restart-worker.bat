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
  REM timeout /t doc stdin => loi "Input redirection is not supported" khi stdin bi redirect.
  REM ping -n khong doc stdin, cho delay tuong duong.
  ping -n 2 127.0.0.1 >nul
)
:PORTFREE
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo Loi: port %PORT% van ban. Thoat.
  exit /b 1
)
echo Port %PORT% da tu do.

echo [3/4] Start nen: node src/index.js ...
REM Xoa bien SystemOne ke thua tu shell cha truoc khi start (gia tri cu se che do .env).
call "%~dp0clear-systemone-env.bat"
start "" /MIN cmd /c "node src/index.js >> %LOGFILE% 2>&1"
ping -n 4 127.0.0.1 >nul

echo [4/4] Kiem tra /api/v1/status ...
curl -s -o nul -w "HTTP %%{http_code}\n" http://localhost:%PORT%/api/v1/status
if errorlevel 1 (
  echo Loi: server chua phan hoi. Xem %LOGFILE%.
  exit /b 1
)
echo Xong.
endlocal
