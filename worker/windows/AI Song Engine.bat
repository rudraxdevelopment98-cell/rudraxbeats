@echo off
REM Starts the AI Song Engine worker using the Node runtime shipped in this folder.
REM If it ever falls over it restarts itself - the engine is meant to run
REM unattended, so a crash at 3am must not need a human to click anything.
cd /d "%~dp0"
title AI Song Engine - Worker

:run
"%~dp0node.exe" "%~dp0launcher.js"
set CODE=%ERRORLEVEL%

REM 0 = stopped on purpose (Ctrl+C), 2 = setup not finished. Both stay stopped.
if "%CODE%"=="0" goto stop
if "%CODE%"=="2" goto stop

echo.
echo   The worker stopped unexpectedly (code %CODE%).
echo   Restarting in 10 seconds...  press Ctrl+C to quit instead.
timeout /t 10 /nobreak >nul
echo.
goto run

:stop
echo.
echo The worker has stopped.
pause
