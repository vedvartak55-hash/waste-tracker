@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org , install it, then run this file again.
  pause
  exit /b
)
if not exist .env copy .env.example .env >nul
echo.
echo  Website:   http://localhost:3000
echo  Dashboard: sign in with the ADMIN_PASSWORD from the .env file (default admin123)
echo  Close this window to stop the website.
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
