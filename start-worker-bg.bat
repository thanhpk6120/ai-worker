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
rem Xoa bien SystemOne ke thua tu shell cha (gia tri cu co the che do .env).
rem XOA HAN (set "VAR="), khong gan rong - xem clear-systemone-env.bat.
call "%~dp0clear-systemone-env.bat"
rem Spawn qua WMI (Win32_Process.Create) => worker DOC LAP voi shell cha.
rem Ban cua dung `Start-Process` => process bi ghep vao job object cua shell,
rem bi reap khi shell dong => worker chet giua chung (step de lai RUNNING mo coi).
node "%~dp0scripts\worker-control.js" start
if errorlevel 1 (
    echo [ERROR] Khong start duoc worker.
    exit /b 1
)
echo [OK] Worker dang chay nen. Kiem tra: curl http://localhost:3000/api/v1/status
