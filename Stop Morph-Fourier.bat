@echo off
rem Stop the Morph-Fourier server (kills whatever is listening on :8000).
setlocal
set FOUND=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >/dev/null 2>&1
    set FOUND=1
)
if defined FOUND (echo Morph-Fourier stopped.) else (echo Morph-Fourier was not running.)
timeout /t 2 >nul
