@echo off
rem Chay AI Worker nen (khong chiem terminal, khong mo cua so moi).
rem Log: logs\server-bg.log va logs\server-bg-err.log
rem Dung server: netstat -ano ^| findstr ":3000" de lay PID, roi taskkill /PID <pid> /F
set "PROJECT_ROOT=%~dp0"
cd /d "%PROJECT_ROOT%"
if not exist "logs" mkdir "logs" >nul 2>nul
netstat -ano | findstr "LISTENING" | findstr ":3000" >nul 2>nul
if %errorlevel% equ 0 (
    echo [INFO] Port 3000 dang duoc dung, khong start them.
    exit /b 0
)
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'node' -ArgumentList 'src/index.js' -WorkingDirectory '%PROJECT_ROOT%' -WindowStyle Hidden -RedirectStandardOutput '%PROJECT_ROOT%logs\server-bg.log' -RedirectStandardError '%PROJECT_ROOT%logs\server-bg-err.log'"
echo [OK] Worker dang chay nen. Kiem tra: curl http://localhost:3000/api/v1/status
