@echo off
cd /d "%~dp0"
echo.
echo   WorkBuddy to Claude Code - local gateway
echo.
echo   A page opens in your browser. Do what it says there.
echo   Close this window to stop the gateway.
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul & start "" http://127.0.0.1:8789"
node src/server.ts
pause
