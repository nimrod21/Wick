@echo off
title Trading Cockpit - Stop
echo Stopping Trading Cockpit...
taskkill /F /FI "WINDOWTITLE eq Cockpit Server*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Cockpit Web*" >nul 2>&1
echo Done.
timeout /t 2 /nobreak > nul
exit /b 0
