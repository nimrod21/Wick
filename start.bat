@echo off
title Trading Cockpit
cd /d "D:\Claude\trading-cockpit"

REM Prepend portable Node 22 to PATH (better-sqlite3 Node 24 prebuilts are broken)
set "PATH=D:\Claude\Tools\node-v22;%PATH%"

echo ================================================
echo   Trading Cockpit - Launcher
echo ================================================
echo.

REM First-time setup: install deps if missing
if not exist "node_modules" (
  echo [1/4] Installing dependencies (first run only)...
  call pnpm install
  if errorlevel 1 goto :fail
) else (
  echo [1/4] Dependencies OK.
)

REM Build server if dist missing
if not exist "apps\server\dist\index.js" (
  echo [2/4] Building server (first run only)...
  call pnpm --filter @cockpit/server build
  if errorlevel 1 goto :fail
) else (
  echo [2/4] Server build OK.
)

REM Initialize DB if missing
if not exist "apps\server\data\cockpit.db" (
  echo [3/4] Running migrations (first run only)...
  call pnpm migrate
  if errorlevel 1 goto :fail
) else (
  echo [3/4] Database OK.
)

echo [4/4] Launching processes...
echo.

REM Server in its own window
start "Cockpit Server" cmd /k "title Cockpit Server && set PATH=D:\Claude\Tools\node-v22;%%PATH%% && cd /d D:\Claude\trading-cockpit && node apps\server\dist\index.js"

REM Web dev server in its own window (takes ~5s to compile)
start "Cockpit Web" cmd /k "title Cockpit Web && set PATH=D:\Claude\Tools\node-v22;%%PATH%% && cd /d D:\Claude\trading-cockpit && pnpm --filter @cockpit/web dev"

REM Wait for web to compile before opening browser
echo Waiting 8 seconds for Next.js to boot...
timeout /t 8 /nobreak > nul

REM Open browser
start "" "http://127.0.0.1:3000"

echo.
echo ================================================
echo   Trading Cockpit is running.
echo   Web:    http://127.0.0.1:3000
echo   Server: http://127.0.0.1:3001
echo.
echo   To stop: run stop.bat OR close the two
echo   "Cockpit Server" and "Cockpit Web" windows.
echo ================================================
echo.
pause
exit /b 0

:fail
echo.
echo *** Setup failed. Check the error above. ***
pause
exit /b 1
