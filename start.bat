@echo off
title Wick
cd /d "D:\Projects\Wick"

REM Portable Node 22 + pnpm global bin on PATH
set "PATH=D:\Claude\Tools\node-v22;%APPDATA%\npm;%PATH%"

if not exist "logs" mkdir logs

echo ================================================
echo   Wick
echo ================================================

if not exist "node_modules" (
  echo Installing dependencies, about 1 minute, one time only...
  call pnpm install
  if errorlevel 1 goto :fail
)

if not exist "apps\server\dist\index.js" (
  echo Building server, one time only...
  call pnpm --filter @wick/server build
  if errorlevel 1 goto :fail
)

if not exist "apps\server\data\wick.db" (
  echo Initializing database...
  call pnpm migrate
  if errorlevel 1 goto :fail
)

echo Checking for pending migrations...
call pnpm migrate

echo Starting server (hidden)...
for /f "delims=" %%P in ('powershell -NoProfile -Command "(Start-Process cmd -ArgumentList '/c','node apps\server\dist\index.js ^> logs\server.log 2^>^&1' -PassThru -WindowStyle Hidden).Id"') do set "SERVER_PID=%%P"

echo Starting web (hidden)...
for /f "delims=" %%P in ('powershell -NoProfile -Command "(Start-Process cmd -ArgumentList '/c','pnpm --filter @wick/web dev ^> logs\web.log 2^>^&1' -PassThru -WindowStyle Hidden).Id"') do set "WEB_PID=%%P"

echo server pid=%SERVER_PID%  web pid=%WEB_PID%
echo Waiting 8 seconds for web to boot...
timeout /t 8 /nobreak > nul

start "" "http://127.0.0.1:3000"

echo.
echo ================================================
echo   RUNNING
echo   http://127.0.0.1:3000
echo   Logs: D:\Projects\Wick\logs\
echo.
echo   Press any key in THIS window to STOP.
echo ================================================
pause > nul

echo Stopping...
if defined SERVER_PID taskkill /F /T /PID %SERVER_PID% > nul 2>&1
if defined WEB_PID    taskkill /F /T /PID %WEB_PID%    > nul 2>&1
REM Kill leftover node/pnpm children just in case
taskkill /F /IM node.exe > nul 2>&1
exit /b 0

:fail
echo.
echo *** Setup failed. Check logs above. ***
pause
exit /b 1
