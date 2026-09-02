@echo off
REM Starts the AI Song Engine worker using the Node runtime shipped in this folder.
cd /d "%~dp0"
title AI Song Engine - Worker
"%~dp0node.exe" "%~dp0launcher.js"
echo.
echo The worker has stopped.
pause
