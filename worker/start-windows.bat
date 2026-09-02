@echo off
REM ---------------------------------------------------------------------
REM  AI Song Engine - worker starter for Windows
REM  1. Install Node.js 18+  : https://nodejs.org
REM  2. Copy .env.example to .env and put your REDIS_URL in it
REM  3. Double-click this file
REM ---------------------------------------------------------------------
cd /d "%~dp0"
title AI Song Engine - worker

if not exist ".env" (
  echo.
  echo   [!] No .env file found.
  echo       Copy .env.example to .env and set REDIS_URL inside it.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies, this happens only once...
  call npm install --omit=dev
)

echo Starting worker...
node server.js
pause
