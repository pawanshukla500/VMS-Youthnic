@echo off
title Meesho Login Helper
cd /d "%~dp0"

IF NOT EXIST "node_modules" (
  echo Installing dependencies...
  call npm install
  call npx playwright install chromium
)

node cli.js --login
pause
