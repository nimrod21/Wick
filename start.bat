@echo off
title Trading Cockpit
cd /d "D:\Claude\trading-cockpit"

REM Prepend portable Node 22 to PATH
set "PATH=D:\Claude\Tools\node-v22;%PATH%"

REM Ensure pnpm global bin is in PATH too (where pnpm / pm2 live)
set "PATH=%APPDATA%\npm;%PATH%"

if not exist "logs" mkdir logs

echo ================================================
echo   Trading Cockpit
echo ================================================

REM --- first-run setup (skipped when already done) ---
if not exist "node_modules" (
  echo Installing dependencies (~1 min, one time)...
  call pnpm install || goto :fail
)
if not exist "apps\server\dist\index.js" (
  echo Building server (one time)...
  call pnpm --filter @cockpit/server build || goto :fail
)
if not exist "apps\web\.next" (
  echo Building web (one time, ~1 min)...
  call pnpm --filter @cockpit/web build || goto :fail
)
if not exist "apps\server\data\cockpit.db" (
  echo Initializing database...
  call pnpm migrate || goto :fail
)

echo Starting server + web (hidden)...

REM Launch hidden background processes, capture PIDs
for /f "delims=" %%P in ('powershell -NoProfile -Command "(Start-Process node -ArgumentList 'apps\server\dist\index.js' -PassThru -RedirectStandardOutput 'logs\server.log' -RedirectStandardError 'logs\server.err' -WindowStyle Hidden).Id"') do set "SERVER_PID=%%P"

for /f "delims=" %%P in ('powershell -NoProfile -Command "(Start-Process pnpm -ArgumentList '--filter','@cockpit/web','start' -PassThru -RedirectStandardOutput 'logs\web.log' -RedirectStandardError 'logs\web.err' -WindowStyle Hidden).Id"') do set "WEB_PID=%%P"

echo Waiting for web to boot...
timeout /t 6 /nobreak > nul

start "" "http://127.0.0.1:3000"

echo.
echo ================================================
echo   RUNNING
echo   http://127.0.0.1:3000
echo   logs: D:\Claude\trading-cockpit\logs\
echo.
echo   Press any key to STOP and exit.
echo ================================================
pause > nul

echo Stopping...
if defined SERVER_PID taskkill /F /T /PID %SERVER_PID% > nul 2>&1
if defined WEB_PID    taskkill /F /T /PID %WEB_PID%    > nul 2>&1
exit /b 0

:fail
echo.
echo *** Setup failed. Check output above. ***
echo Logs: D:\Claude\trading-cockpit\logs\
pause
exit /b 1
