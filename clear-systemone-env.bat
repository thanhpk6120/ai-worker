@echo off
REM clear-systemone-env.bat
REM Xoa 4 bien SYSTEMONE_* ke thua tu shell cha.
REM config.js CHI nap .env khi process.env[key] === undefined, nen giu lai gia tri cu
REM (ke ca chuoi rong) se lam .env bi bo qua => server chay sai model/API key.
REM cmd.exe: set "VAR=" XOA HAN bien (khong phai gan rong). Dung `call` de goi file nay.
set "SYSTEMONE_MODEL="
set "SYSTEMONE_API_KEY="
set "SYSTEMONE_BASE_URL="
set "SYSTEMONE_ENABLED="
exit /b 0
