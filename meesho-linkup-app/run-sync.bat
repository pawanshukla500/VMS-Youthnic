@echo off
title Meesho Flyer Link-up - VMS Companion
echo ========================================================
echo    MEESHO FLYER LINK-UP - VMS COMPANION TOOL
echo ========================================================
cd /d "%~dp0"

IF NOT EXIST "node_modules" (
  echo Installing dependencies...
  call npm install
  call npx playwright install chromium
)

node cli.js
pause
